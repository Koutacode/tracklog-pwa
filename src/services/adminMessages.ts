import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { TracklogAdminMessage } from '../domain/remoteTypes';
import { getDriverIdentity } from './remoteAuth';
import { requestLocationHeartbeatNow } from './locationHeartbeat';
import {
  ackTracklogAdminMessagesViaFunction,
  listPendingTracklogAdminMessagesViaFunction,
} from './tracklogPrivilegedApi';

export const TRACKLOG_ADMIN_MESSAGE_EVENT = 'tracklog-admin-message';

const NATIVE_CHANNEL_ID = 'tracklog_admin_messages';
const NATIVE_ACTION_TYPE_ID = 'tracklog_admin_message_actions';
const NATIVE_ACTION_UPDATE_LOCATION = 'update_location';
const EXTRA_KIND = 'tracklog_admin_message_v1';
const POLL_MIN_INTERVAL_MS = 10 * 1000;

let nativeChannelReady = false;
let nativeTapListenerReady = false;
let pollInFlight: Promise<void> | null = null;
let lastPollAt = 0;
const localSeenMessageIds = new Set<string>();

function isNative() {
  return Capacitor.isNativePlatform();
}

function toNotificationId(messageId: string) {
  let hash = 0;
  for (let i = 0; i < messageId.length; i++) {
    hash = (hash * 31 + messageId.charCodeAt(i)) >>> 0;
  }
  return 740000 + (hash % 180000);
}

function emitAdminMessage(message: TracklogAdminMessage) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<TracklogAdminMessage>(TRACKLOG_ADMIN_MESSAGE_EVENT, { detail: message }));
}

async function ensureNativeMessageChannel() {
  if (!isNative() || nativeChannelReady) return;
  await LocalNotifications.registerActionTypes({
    types: [
      {
        id: NATIVE_ACTION_TYPE_ID,
        actions: [
          {
            id: NATIVE_ACTION_UPDATE_LOCATION,
            title: '現在地更新',
            foreground: true,
          },
        ],
      },
    ],
  });
  try {
    await LocalNotifications.createChannel({
      id: NATIVE_CHANNEL_ID,
      name: '管理者メッセージ',
      description: '管理画面から送信されたメッセージ',
      importance: 4,
      visibility: 1,
      vibration: true,
      lights: true,
      lightColor: '#38bdf8',
    });
  } catch {
    // channel may already exist
  }
  nativeChannelReady = true;
}

async function ensureNativeTapListener() {
  if (!isNative() || nativeTapListenerReady) return;
  await LocalNotifications.addListener('localNotificationActionPerformed', event => {
    const extra = event.notification?.extra;
    if (!extra || extra.kind !== EXTRA_KIND || typeof extra.messageId !== 'string') return;
    if (extra.requestLocation === false) return;
    if (event.actionId && event.actionId !== NATIVE_ACTION_UPDATE_LOCATION && event.actionId !== 'tap') return;
    void requestLocationFromAdminMessage(extra.messageId);
  });
  nativeTapListenerReady = true;
}

async function showNativeNotification(message: TracklogAdminMessage) {
  if (!isNative()) return false;
  await ensureNativeMessageChannel();
  await ensureNativeTapListener();
  const permission = await LocalNotifications.checkPermissions();
  if (permission.display !== 'granted') return false;
  await LocalNotifications.schedule({
    notifications: [
      {
        id: toNotificationId(message.id),
        title: 'TrackLog',
        body: message.body,
        actionTypeId: message.request_location ? NATIVE_ACTION_TYPE_ID : undefined,
        channelId: NATIVE_CHANNEL_ID,
        autoCancel: true,
        extra: {
          kind: EXTRA_KIND,
          messageId: message.id,
          requestLocation: message.request_location,
        },
      },
    ],
  });
  return true;
}

function showWebNotification(message: TracklogAdminMessage) {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return false;
  if (Notification.permission !== 'granted') return false;
  const notification = new Notification('TrackLog', {
    body: message.body,
    tag: `tracklog-admin-${message.id}`,
    data: {
      kind: EXTRA_KIND,
      messageId: message.id,
    },
  });
  notification.onclick = () => {
    window.focus();
    notification.close();
    if (message.request_location) void requestLocationFromAdminMessage(message.id);
  };
  return true;
}

async function showMessageNotification(message: TracklogAdminMessage) {
  emitAdminMessage(message);
  if (await showNativeNotification(message)) return;
  showWebNotification(message);
}

async function handleAdminMessage(message: TracklogAdminMessage) {
  if (localSeenMessageIds.has(message.id)) return null;
  localSeenMessageIds.add(message.id);
  await showMessageNotification(message);
  return message.id;
}

async function getApprovedDeviceId() {
  const identity = await getDriverIdentity();
  if (!identity.configured || !identity.authInitialized || !identity.profileComplete) return null;
  if (identity.approvalStatus !== 'approved' || !identity.deviceId) return null;
  return identity.deviceId;
}

export async function requestLocationFromAdminMessage(messageId: string) {
  const deviceId = await getApprovedDeviceId();
  if (!deviceId) return false;
  const locationRequestedAt = new Date().toISOString();
  await requestLocationHeartbeatNow();
  await ackTracklogAdminMessagesViaFunction({
    deviceId,
    messageIds: [messageId],
    locationRequestedAt,
  });
  return true;
}

export async function pollTracklogAdminMessages(options?: { force?: boolean }) {
  if (pollInFlight) return pollInFlight;
  const now = Date.now();
  if (!options?.force && now - lastPollAt < POLL_MIN_INTERVAL_MS) return;
  lastPollAt = now;
  pollInFlight = (async () => {
    const deviceId = await getApprovedDeviceId();
    if (!deviceId) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;

    const messages = await listPendingTracklogAdminMessagesViaFunction({ deviceId });
    if (messages.length === 0) return;

    const acknowledgedIds: string[] = [];
    for (const message of messages) {
      const acknowledgedId = await handleAdminMessage(message);
      if (acknowledgedId) acknowledgedIds.push(acknowledgedId);
    }
    if (acknowledgedIds.length > 0) {
      await ackTracklogAdminMessagesViaFunction({
        deviceId,
        messageIds: acknowledgedIds,
        locationRequestedAt: null,
      });
    }
  })()
    .catch(error => {
      console.warn('[adminMessages] poll failed', error);
    })
    .finally(() => {
      pollInFlight = null;
    });
  return pollInFlight;
}
