import { Capacitor } from '@capacitor/core';
import { PushNotifications, type ActionPerformed, type PushNotificationSchema, type Token } from '@capacitor/push-notifications';
import {
  openAdminMessageInbox,
  pollTracklogAdminMessages,
  rememberAdminMessageFromPush,
  requestLocationFromAdminMessage,
} from './adminMessages';
import {
  FIREBASE_NATIVE_PUSH_ENABLED,
  FIREBASE_PUSH_CONFIG,
  FIREBASE_WEB_VAPID_KEY,
  isFirebaseWebPushConfigured,
} from './firebasePushConfig';
import { getDriverIdentity } from './remoteAuth';
import {
  getTracklogWebPushConfigViaFunction,
  registerTracklogPushTokenViaFunction,
  type TracklogWebPushSubscription,
} from './tracklogPrivilegedApi';

const PUSH_REGISTER_MIN_INTERVAL_MS = 5 * 60 * 1000;
const PUSH_TOKEN_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const PUSH_CHANNEL_ID = 'tracklog_admin_messages';

let nativeListenersReady = false;
let webListenersReady = false;
let firebaseForegroundListenerReady = false;
let nativeRegistrationStarted = false;
let webRegistrationStarted = false;
let lastEnsureAt = 0;
let lastRegisteredValue: string | null = null;
let lastRegisteredPlatform: 'android' | 'web' | null = null;
let lastRegisteredProvider: 'fcm' | 'webpush' | null = null;
let lastRegisteredAt = 0;

function now() {
  return Date.now();
}

function getPushData(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object') return {};
  const raw = input as Record<string, unknown>;
  const nested = raw.data;
  if (nested && typeof nested === 'object') return nested as Record<string, unknown>;
  return raw;
}

function getPushString(data: Record<string, unknown>, key: string) {
  const value = data[key];
  return typeof value === 'string' ? value.trim() : '';
}

function getPushBoolean(data: Record<string, unknown>, key: string, fallback = false) {
  const value = data[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true' || value === '1';
  return fallback;
}

async function getApprovedDeviceId() {
  const identity = await getDriverIdentity();
  if (!identity.configured || !identity.authInitialized || !identity.profileComplete) return null;
  if (identity.approvalStatus !== 'approved' || !identity.deviceId) return null;
  return identity.deviceId;
}

function recentlyRegistered(
  value: string,
  platform: 'android' | 'web',
  provider: 'fcm' | 'webpush',
) {
  const current = now();
  return (
    lastRegisteredValue === value &&
    lastRegisteredPlatform === platform &&
    lastRegisteredProvider === provider &&
    current - lastRegisteredAt < PUSH_TOKEN_REFRESH_INTERVAL_MS
  );
}

function rememberRegistration(
  value: string,
  platform: 'android' | 'web',
  provider: 'fcm' | 'webpush',
) {
  lastRegisteredValue = value;
  lastRegisteredPlatform = platform;
  lastRegisteredProvider = provider;
  lastRegisteredAt = now();
}

async function savePushToken(token: string, platform: 'android' | 'web') {
  const trimmed = token.trim();
  if (!trimmed) return false;
  if (recentlyRegistered(trimmed, platform, 'fcm')) return true;

  const deviceId = await getApprovedDeviceId();
  if (!deviceId) return false;
  await registerTracklogPushTokenViaFunction({
    deviceId,
    platform,
    provider: 'fcm',
    token: trimmed,
  });
  rememberRegistration(trimmed, platform, 'fcm');
  return true;
}

async function saveWebPushSubscription(subscription: TracklogWebPushSubscription) {
  const serialized = JSON.stringify(subscription);
  if (recentlyRegistered(serialized, 'web', 'webpush')) return true;

  const deviceId = await getApprovedDeviceId();
  if (!deviceId) return false;
  await registerTracklogPushTokenViaFunction({
    deviceId,
    platform: 'web',
    provider: 'webpush',
    subscription,
  });
  rememberRegistration(serialized, 'web', 'webpush');
  return true;
}

async function handlePushTap(data: Record<string, unknown>) {
  const messageId = getPushString(data, 'messageId');
  if (!messageId) {
    await pollTracklogAdminMessages({ force: true });
    return;
  }
  const body = getPushString(data, 'body') || getPushString(data, 'messageBody');
  rememberAdminMessageFromPush({
    id: messageId,
    body,
    requestLocation: getPushBoolean(data, 'requestLocation', true),
    sentAt: getPushString(data, 'sentAt'),
  });
  openAdminMessageInbox(messageId);
  if (!body) {
    await pollTracklogAdminMessages({ force: true });
  }
  if (getPushBoolean(data, 'requestLocation', true)) {
    await requestLocationFromAdminMessage(messageId);
  } else {
    await pollTracklogAdminMessages({ force: true });
  }
}

async function handlePushReceived() {
  await pollTracklogAdminMessages({ force: true });
}

async function ensureNativePushListeners() {
  if (nativeListenersReady) return;
  await PushNotifications.addListener('registration', (token: Token) => {
    void savePushToken(token.value, 'android').catch(error => {
      console.warn('[pushRegistration] native token registration failed', error);
    });
  });
  await PushNotifications.addListener('registrationError', error => {
    console.warn('[pushRegistration] native registration error', error);
  });
  await PushNotifications.addListener('pushNotificationReceived', (_notification: PushNotificationSchema) => {
    void handlePushReceived().catch(error => {
      console.warn('[pushRegistration] native push receive handling failed', error);
    });
  });
  await PushNotifications.addListener('pushNotificationActionPerformed', (event: ActionPerformed) => {
    void handlePushTap(getPushData(event.notification)).catch(error => {
      console.warn('[pushRegistration] native push tap handling failed', error);
    });
  });
  nativeListenersReady = true;
}

async function ensureNativePushRegistration() {
  await ensureNativePushListeners();
  try {
    await PushNotifications.createChannel({
      id: PUSH_CHANNEL_ID,
      name: '管理者メッセージ',
      description: '管理画面から送信されたメッセージ',
      importance: 4,
      visibility: 1,
      vibration: true,
      lights: true,
      lightColor: '#38bdf8',
    });
  } catch {
    // Existing channels cannot always be recreated with new settings.
  }

  const currentPermission = await PushNotifications.checkPermissions();
  const permission = currentPermission.receive === 'granted'
    ? currentPermission
    : await PushNotifications.requestPermissions();
  if (permission.receive !== 'granted') return false;
  nativeRegistrationStarted = true;
  await PushNotifications.register();
  return true;
}

async function getWebServiceWorkerRegistration() {
  if (!('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration;
}

export function decodeVapidPublicKey(value: string) {
  const key = value.trim();
  if (!key || !/^[A-Za-z0-9_-]+={0,2}$/.test(key)) {
    throw new Error('Standard Web Push public key is invalid');
  }
  const base64 = key.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  let binary = '';
  try {
    binary = atob(padded);
  } catch {
    throw new Error('Standard Web Push public key is invalid');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new Error('Standard Web Push public key is invalid');
  }
  return bytes;
}

export function normalizeWebPushSubscriptionJson(value: unknown): TracklogWebPushSubscription {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Standard Web Push subscription is invalid');
  }
  const raw = value as Record<string, unknown>;
  const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint.trim() : '';
  if (!endpoint) throw new Error('Standard Web Push subscription endpoint is missing');
  try {
    if (new URL(endpoint).protocol !== 'https:') throw new Error('invalid protocol');
  } catch {
    throw new Error('Standard Web Push subscription endpoint is invalid');
  }

  const rawKeys = raw.keys;
  if (!rawKeys || typeof rawKeys !== 'object' || Array.isArray(rawKeys)) {
    throw new Error('Standard Web Push subscription keys are missing');
  }
  const keys = rawKeys as Record<string, unknown>;
  const auth = typeof keys.auth === 'string' ? keys.auth.trim() : '';
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh.trim() : '';
  if (!auth || !p256dh) throw new Error('Standard Web Push subscription keys are invalid');

  const rawExpirationTime = raw.expirationTime;
  const expirationTime = rawExpirationTime == null
    ? null
    : typeof rawExpirationTime === 'number' && Number.isFinite(rawExpirationTime) && rawExpirationTime >= 0
      ? rawExpirationTime
      : null;
  if (rawExpirationTime != null && expirationTime == null) {
    throw new Error('Standard Web Push subscription expiration is invalid');
  }

  return {
    endpoint,
    expirationTime,
    keys: { auth, p256dh },
  };
}

function applicationServerKeyMatches(subscription: PushSubscription, expected: Uint8Array) {
  const current = subscription.options.applicationServerKey;
  if (!current) return false;
  const currentBytes = new Uint8Array(current);
  if (currentBytes.length !== expected.length) return false;
  return currentBytes.every((byte, index) => byte === expected[index]);
}

function handleServiceWorkerMessage(event: MessageEvent) {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  const payload = data as Record<string, unknown>;
  if (payload.type !== 'TRACKLOG_ADMIN_PUSH_CLICK') return;
  void handlePushTap({
    messageId: getPushString(payload, 'messageId'),
    body: getPushString(payload, 'body') || getPushString(payload, 'messageBody'),
    requestLocation: getPushBoolean(payload, 'requestLocation', true) ? 'true' : 'false',
    sentAt: getPushString(payload, 'sentAt'),
  }).catch(error => {
    console.warn('[pushRegistration] service worker push click handling failed', error);
  });
}

function consumePushUrlParams() {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const messageId = url.searchParams.get('tracklogPushMessageId')?.trim();
  if (!messageId) return;
  const requestLocation = url.searchParams.get('tracklogRequestLocation') !== '0';
  const body = url.searchParams.get('tracklogPushBody')?.trim() || '';
  const sentAt = url.searchParams.get('tracklogPushSentAt')?.trim() || '';
  url.searchParams.delete('tracklogPushMessageId');
  url.searchParams.delete('tracklogRequestLocation');
  url.searchParams.delete('tracklogPushBody');
  url.searchParams.delete('tracklogPushSentAt');
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
  void handlePushTap({
    messageId,
    body,
    requestLocation: requestLocation ? 'true' : 'false',
    sentAt,
  }).catch(error => {
    console.warn('[pushRegistration] push URL handling failed', error);
  });
}

export function initializeTracklogPushOpenHandlers() {
  if (webListenersReady) return;
  navigator.serviceWorker?.addEventListener('message', handleServiceWorkerMessage);
  consumePushUrlParams();
  webListenersReady = true;
}

async function tryFirebaseWebPushRegistration(registration: ServiceWorkerRegistration) {
  initializeTracklogPushOpenHandlers();
  if (!isFirebaseWebPushConfigured()) return false;
  const messagingModule = await import('firebase/messaging');
  const supported = await messagingModule.isSupported().catch(() => false);
  if (!supported) return false;
  const appModule = await import('firebase/app');
  const app = appModule.getApps().find(item => item.name === 'tracklog-push') ??
    appModule.initializeApp(FIREBASE_PUSH_CONFIG, 'tracklog-push');
  const messaging = messagingModule.getMessaging(app);
  if (!firebaseForegroundListenerReady) {
    messagingModule.onMessage(messaging, () => {
      void handlePushReceived().catch(error => {
        console.warn('[pushRegistration] web foreground push handling failed', error);
      });
    });
    firebaseForegroundListenerReady = true;
  }

  const tokenOptions: { serviceWorkerRegistration: ServiceWorkerRegistration; vapidKey?: string } = {
    serviceWorkerRegistration: registration,
  };
  if (FIREBASE_WEB_VAPID_KEY) tokenOptions.vapidKey = FIREBASE_WEB_VAPID_KEY;
  const token = await messagingModule.getToken(messaging, tokenOptions);
  if (!token) return false;
  return savePushToken(token, 'web');
}

async function tryStandardWebPushRegistration(
  registration: ServiceWorkerRegistration,
  deviceId: string,
) {
  if (!('PushManager' in window) || !registration.pushManager) return false;
  const { publicVapidKey } = await getTracklogWebPushConfigViaFunction({ deviceId });
  const applicationServerKey = decodeVapidPublicKey(publicVapidKey);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !applicationServerKeyMatches(subscription, applicationServerKey)) {
    const unsubscribed = await subscription.unsubscribe();
    if (!unsubscribed) throw new Error('Existing Web Push subscription could not be replaced');
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });
  return saveWebPushSubscription(normalizeWebPushSubscriptionJson(subscription.toJSON()));
}

async function ensureWebPushRegistration(deviceId: string) {
  initializeTracklogPushOpenHandlers();
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  const registration = await getWebServiceWorkerRegistration();
  if (!registration) return false;

  try {
    if (await tryFirebaseWebPushRegistration(registration)) {
      webRegistrationStarted = true;
      return true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Firebase Web Push failed';
    console.warn('[pushRegistration] Firebase web push unavailable; trying standard Web Push', message);
  }

  const registered = await tryStandardWebPushRegistration(registration, deviceId);
  if (registered) webRegistrationStarted = true;
  return registered;
}

export async function ensureTracklogPushRegistration(options?: { force?: boolean }) {
  const current = now();
  if (!options?.force && current - lastEnsureAt < PUSH_REGISTER_MIN_INTERVAL_MS) return;
  lastEnsureAt = current;

  const deviceId = await getApprovedDeviceId();
  if (!deviceId) return;

  if (Capacitor.isNativePlatform()) {
    if (!FIREBASE_NATIVE_PUSH_ENABLED) return;
    if (nativeRegistrationStarted && !options?.force) return;
    await ensureNativePushRegistration().catch(error => {
      console.warn('[pushRegistration] native push setup failed', error);
    });
    return;
  }

  if (webRegistrationStarted && !options?.force) return;
  await ensureWebPushRegistration(deviceId).catch(error => {
    console.warn('[pushRegistration] web push setup failed', error);
  });
}
