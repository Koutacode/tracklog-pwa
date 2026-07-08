import { Capacitor } from '@capacitor/core';
import { PushNotifications, type ActionPerformed, type PushNotificationSchema, type Token } from '@capacitor/push-notifications';
import { pollTracklogAdminMessages, requestLocationFromAdminMessage } from './adminMessages';
import {
  FIREBASE_NATIVE_PUSH_ENABLED,
  FIREBASE_PUSH_CONFIG,
  FIREBASE_WEB_VAPID_KEY,
  isFirebaseWebPushConfigured,
} from './firebasePushConfig';
import { getDriverIdentity } from './remoteAuth';
import { registerTracklogPushTokenViaFunction } from './tracklogPrivilegedApi';

const PUSH_REGISTER_MIN_INTERVAL_MS = 5 * 60 * 1000;
const PUSH_TOKEN_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const PUSH_CHANNEL_ID = 'tracklog_admin_messages';

let nativeListenersReady = false;
let webListenersReady = false;
let nativeRegistrationStarted = false;
let webRegistrationStarted = false;
let lastEnsureAt = 0;
let lastRegisteredToken: string | null = null;
let lastRegisteredPlatform: 'android' | 'web' | null = null;
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

async function savePushToken(token: string, platform: 'android' | 'web') {
  const trimmed = token.trim();
  if (!trimmed) return false;
  const current = now();
  if (
    lastRegisteredToken === trimmed &&
    lastRegisteredPlatform === platform &&
    current - lastRegisteredAt < PUSH_TOKEN_REFRESH_INTERVAL_MS
  ) {
    return true;
  }

  const deviceId = await getApprovedDeviceId();
  if (!deviceId) return false;
  await registerTracklogPushTokenViaFunction({
    deviceId,
    platform,
    token: trimmed,
  });
  lastRegisteredToken = trimmed;
  lastRegisteredPlatform = platform;
  lastRegisteredAt = current;
  return true;
}

async function handlePushTap(data: Record<string, unknown>) {
  const messageId = getPushString(data, 'messageId');
  if (!messageId) {
    await pollTracklogAdminMessages({ force: true });
    return;
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

function handleServiceWorkerMessage(event: MessageEvent) {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  const payload = data as Record<string, unknown>;
  if (payload.type !== 'TRACKLOG_ADMIN_PUSH_CLICK') return;
  void handlePushTap({
    messageId: getPushString(payload, 'messageId'),
    requestLocation: getPushBoolean(payload, 'requestLocation', true) ? 'true' : 'false',
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
  url.searchParams.delete('tracklogPushMessageId');
  url.searchParams.delete('tracklogRequestLocation');
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
  void handlePushTap({
    messageId,
    requestLocation: requestLocation ? 'true' : 'false',
  }).catch(error => {
    console.warn('[pushRegistration] push URL handling failed', error);
  });
}

async function ensureWebPushListeners() {
  if (webListenersReady) return;
  navigator.serviceWorker?.addEventListener('message', handleServiceWorkerMessage);
  consumePushUrlParams();

  const messagingModule = await import('firebase/messaging');
  const supported = await messagingModule.isSupported().catch(() => false);
  if (supported) {
    const appModule = await import('firebase/app');
    const app = appModule.getApps().find(item => item.name === 'tracklog-push') ??
      appModule.initializeApp(FIREBASE_PUSH_CONFIG, 'tracklog-push');
    const messaging = messagingModule.getMessaging(app);
    messagingModule.onMessage(messaging, () => {
      void handlePushReceived().catch(error => {
        console.warn('[pushRegistration] web foreground push handling failed', error);
      });
    });
  }
  webListenersReady = true;
}

async function ensureWebPushRegistration() {
  if (!isFirebaseWebPushConfigured()) return false;
  if (!('Notification' in window)) return false;
  const permission = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission();
  if (permission !== 'granted') return false;
  const registration = await getWebServiceWorkerRegistration();
  if (!registration) return false;

  await ensureWebPushListeners();
  const messagingModule = await import('firebase/messaging');
  const supported = await messagingModule.isSupported().catch(() => false);
  if (!supported) return false;
  const appModule = await import('firebase/app');
  const app = appModule.getApps().find(item => item.name === 'tracklog-push') ??
    appModule.initializeApp(FIREBASE_PUSH_CONFIG, 'tracklog-push');
  const messaging = messagingModule.getMessaging(app);
  const token = await messagingModule.getToken(messaging, {
    vapidKey: FIREBASE_WEB_VAPID_KEY,
    serviceWorkerRegistration: registration,
  });
  if (!token) return false;
  webRegistrationStarted = true;
  await savePushToken(token, 'web');
  return true;
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
  await ensureWebPushRegistration().catch(error => {
    console.warn('[pushRegistration] web push setup failed', error);
  });
}
