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
export const TRACKLOG_ADMIN_MESSAGE_STORE_EVENT = 'tracklog-admin-message-store';

const NATIVE_CHANNEL_ID = 'tracklog_admin_messages';
const NATIVE_ACTION_TYPE_ID = 'tracklog_admin_message_actions';
const NATIVE_ACTION_UPDATE_LOCATION = 'update_location';
const EXTRA_KIND = 'tracklog_admin_message_v1';
const POLL_MIN_INTERVAL_MS = 10 * 1000;
const STORED_MESSAGES_KEY = 'tracklog:admin-messages';
const STORED_MESSAGES_LIMIT = 50;

export type StoredAdminMessage = {
  id: string;
  body: string;
  requestLocation: boolean;
  sentBy: string | null;
  sentAt: string;
  receivedAt: string;
  readAt: string | null;
  source: 'sync' | 'push' | 'notification';
};

let nativeChannelReady = false;
let nativeTapListenerReady = false;
let pollInFlight: Promise<void> | null = null;
let lastPollAt = 0;
const localSeenMessageIds = new Set<string>();

function isNative() {
  return Capacitor.isNativePlatform();
}

function nowIso() {
  return new Date().toISOString();
}

function emitStoredMessagesChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(TRACKLOG_ADMIN_MESSAGE_STORE_EVENT));
}

function readStoredMessages(): StoredAdminMessage[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORED_MESSAGES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(item => {
        if (!item || typeof item !== 'object') return null;
        const message = item as Partial<StoredAdminMessage>;
        if (typeof message.id !== 'string' || !message.id.trim()) return null;
        if (typeof message.body !== 'string' || !message.body.trim()) return null;
        return {
          id: message.id.trim(),
          body: message.body,
          requestLocation: message.requestLocation !== false,
          sentBy: typeof message.sentBy === 'string' ? message.sentBy : null,
          sentAt: typeof message.sentAt === 'string' && message.sentAt ? message.sentAt : nowIso(),
          receivedAt: typeof message.receivedAt === 'string' && message.receivedAt ? message.receivedAt : nowIso(),
          readAt: typeof message.readAt === 'string' && message.readAt ? message.readAt : null,
          source: message.source === 'push' || message.source === 'notification' ? message.source : 'sync',
        } satisfies StoredAdminMessage;
      })
      .filter((item): item is StoredAdminMessage => item !== null)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .slice(0, STORED_MESSAGES_LIMIT);
  } catch {
    return [];
  }
}

function writeStoredMessages(messages: StoredAdminMessage[]) {
  if (typeof localStorage === 'undefined') return;
  const normalized = [...messages]
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .slice(0, STORED_MESSAGES_LIMIT);
  try {
    localStorage.setItem(STORED_MESSAGES_KEY, JSON.stringify(normalized));
    emitStoredMessagesChanged();
  } catch (error) {
    console.warn('[adminMessages] failed to persist message inbox', error);
  }
}

function upsertStoredMessage(message: StoredAdminMessage) {
  const current = readStoredMessages();
  const existing = current.find(item => item.id === message.id);
  const nextMessage: StoredAdminMessage = existing
    ? {
        ...existing,
        body: message.body || existing.body,
        requestLocation: message.requestLocation,
        sentBy: message.sentBy ?? existing.sentBy,
        sentAt: message.sentAt || existing.sentAt,
        receivedAt: existing.receivedAt || message.receivedAt,
        source: message.source,
      }
    : message;
  writeStoredMessages([nextMessage, ...current.filter(item => item.id !== message.id)]);
  return nextMessage;
}

export function getStoredAdminMessages(): StoredAdminMessage[] {
  return readStoredMessages();
}

export function rememberAdminMessage(message: TracklogAdminMessage, source: StoredAdminMessage['source'] = 'sync') {
  return upsertStoredMessage({
    id: message.id,
    body: message.body,
    requestLocation: message.request_location,
    sentBy: message.sent_by,
    sentAt: message.sent_at,
    receivedAt: nowIso(),
    readAt: null,
    source,
  });
}

export function rememberAdminMessageFromPush(input: {
  id: string;
  body?: string;
  requestLocation?: boolean;
  sentAt?: string;
}) {
  const body = input.body?.trim() || '管理者メッセージがあります';
  return upsertStoredMessage({
    id: input.id,
    body,
    requestLocation: input.requestLocation !== false,
    sentBy: null,
    sentAt: input.sentAt?.trim() || nowIso(),
    receivedAt: nowIso(),
    readAt: null,
    source: 'push',
  });
}

export function markAdminMessageRead(messageId: string) {
  const id = messageId.trim();
  if (!id) return;
  const messages = readStoredMessages();
  let changed = false;
  const next = messages.map(message => {
    if (message.id !== id || message.readAt) return message;
    changed = true;
    return { ...message, readAt: nowIso() };
  });
  if (changed) writeStoredMessages(next);
}

export function markAllAdminMessagesRead() {
  const messages = readStoredMessages();
  const readAt = nowIso();
  const next = messages.map(message => message.readAt ? message : { ...message, readAt });
  writeStoredMessages(next);
}

export function openAdminMessageInbox(messageId?: string, options?: { replace?: boolean }) {
  if (typeof window === 'undefined') return;
  const target = new URL('/messages', window.location.origin);
  const id = messageId?.trim();
  if (id) target.searchParams.set('messageId', id);
  const nextPath = `${target.pathname}${target.search}${target.hash}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === nextPath) return;
  const method = options?.replace ? 'replaceState' : 'pushState';
  window.history[method]({}, document.title, nextPath);
  try {
    window.dispatchEvent(new PopStateEvent('popstate'));
  } catch {
    window.dispatchEvent(new Event('popstate'));
  }
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
    if (typeof extra.body === 'string' && extra.body.trim()) {
      rememberAdminMessageFromPush({
        id: extra.messageId,
        body: extra.body,
        requestLocation: extra.requestLocation !== false,
      });
    }
    openAdminMessageInbox(extra.messageId);
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
          body: message.body,
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
      body: message.body,
      requestLocation: message.request_location,
    },
  });
  notification.onclick = () => {
    window.focus();
    notification.close();
    openAdminMessageInbox(message.id);
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
  rememberAdminMessage(message);
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
