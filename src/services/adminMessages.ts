import { Capacitor } from '@capacitor/core';
import { LocalNotifications, type ActionPerformed, type ActionType } from '@capacitor/local-notifications';
import type { TracklogAdminMessage } from '../domain/remoteTypes';
import { getDriverIdentity } from './remoteAuth';
import { requestLocationHeartbeatNow } from './locationHeartbeat';
import {
  createMessageActionSingleFlight,
  handleNativeAdminMessageNotificationAction,
  parseNativeAdminMessageNotificationAction,
} from './nativeAdminMessageActionPolicy';
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
const COMPLETED_LOCATION_REQUESTS_KEY = 'tracklog:admin-message-location-completed';
const COMPLETED_LOCATION_REQUESTS_LIMIT = 100;
const PENDING_LOCATION_REQUESTS_KEY = 'tracklog:admin-message-location-pending';
const PENDING_LOCATION_REQUESTS_LIMIT = 50;

export const NATIVE_ADMIN_MESSAGE_NOTIFICATION_ACTION_TYPE: ActionType = {
  id: NATIVE_ACTION_TYPE_ID,
  actions: [
    {
      id: NATIVE_ACTION_UPDATE_LOCATION,
      title: '現在地更新',
      foreground: true,
    },
  ],
};

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
let nativeChannelInFlight: Promise<void> | null = null;
let pollInFlight: Promise<void> | null = null;
let lastPollAt = 0;
const localSeenMessageIds = new Set<string>();

function readCompletedLocationRequestIds() {
  if (typeof localStorage === 'undefined') return new Set<string>();
  try {
    const parsed = JSON.parse(localStorage.getItem(COMPLETED_LOCATION_REQUESTS_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(
      parsed
        .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
        .map(id => id.trim()),
    );
  } catch {
    return new Set<string>();
  }
}

function readPendingLocationRequestIds() {
  if (typeof localStorage === 'undefined') return [] as string[];
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_LOCATION_REQUESTS_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
      .map(id => id.trim())
      .slice(0, PENDING_LOCATION_REQUESTS_LIMIT);
  } catch {
    return [];
  }
}

function writePendingLocationRequestIds(ids: string[]) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      PENDING_LOCATION_REQUESTS_KEY,
      JSON.stringify(Array.from(new Set(ids)).slice(0, PENDING_LOCATION_REQUESTS_LIMIT)),
    );
  } catch {
    // The process-lifetime single-flight remains active when storage is full.
  }
}

function rememberPendingLocationRequest(messageId: string) {
  const current = readPendingLocationRequestIds();
  writePendingLocationRequestIds([messageId, ...current.filter(id => id !== messageId)]);
}

function removePendingLocationRequest(messageId: string) {
  writePendingLocationRequestIds(readPendingLocationRequestIds().filter(id => id !== messageId));
}

function rememberCompletedLocationRequest(messageId: string) {
  removePendingLocationRequest(messageId);
  if (typeof localStorage === 'undefined') return;
  const ids = readCompletedLocationRequestIds();
  ids.delete(messageId);
  const next = [messageId, ...ids].slice(0, COMPLETED_LOCATION_REQUESTS_LIMIT);
  try {
    localStorage.setItem(COMPLETED_LOCATION_REQUESTS_KEY, JSON.stringify(next));
  } catch {
    // Process-lifetime completion still prevents duplicate actions.
  }
}

const locationRequestSingleFlight = createMessageActionSingleFlight({
  isCompleted: messageId => readCompletedLocationRequestIds().has(messageId),
  markCompleted: rememberCompletedLocationRequest,
});

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
  if (nativeChannelInFlight) return nativeChannelInFlight;
  const setup = (async () => {
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
  })().finally(() => {
    if (nativeChannelInFlight === setup) nativeChannelInFlight = null;
  });
  nativeChannelInFlight = setup;
  return setup;
}

export function initNativeAdminMessageActions() {
  return ensureNativeMessageChannel();
}

export async function handleNativeAdminMessageNotificationActionEvent(
  event: ActionPerformed,
): Promise<boolean> {
  const action = parseNativeAdminMessageNotificationAction(event, EXTRA_KIND);
  if (!action) return false;
  await handleNativeAdminMessageNotificationAction(action, {
    remember: message => rememberAdminMessageFromPush(message),
    openInbox: openAdminMessageInbox,
    requestLocation: requestLocationFromAdminMessage,
    updateLocationActionId: NATIVE_ACTION_UPDATE_LOCATION,
  });
  return true;
}

async function showNativeNotification(message: TracklogAdminMessage) {
  if (!isNative()) return false;
  await initNativeAdminMessageActions();
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
  // Pending messages are returned again until the server receives the ACK.
  // Skip duplicate UI work, but keep the id in the ACK batch so a failed ACK
  // can be retried during the same app session.
  if (localSeenMessageIds.has(message.id)) return message.id;
  rememberAdminMessage(message);
  await showMessageNotification(message);
  localSeenMessageIds.add(message.id);
  return message.id;
}

async function getApprovedDeviceId() {
  const identity = await getDriverIdentity();
  if (!identity.configured || !identity.authInitialized || !identity.profileComplete) return null;
  if (identity.approvalStatus !== 'approved' || !identity.deviceId) return null;
  return identity.deviceId;
}

export function requestLocationFromAdminMessage(messageId: string) {
  const id = messageId.trim();
  if (!id) return Promise.resolve(false);
  if (readCompletedLocationRequestIds().has(id)) {
    removePendingLocationRequest(id);
    return Promise.resolve(true);
  }
  // Persist before touching auth/network so a retained cold-start action can
  // resume after identity initialization or process death.
  rememberPendingLocationRequest(id);
  return locationRequestSingleFlight.run(id, async () => {
    const deviceId = await getApprovedDeviceId();
    if (!deviceId) return false;
    const locationRequestedAt = new Date().toISOString();
    await requestLocationHeartbeatNow();
    await ackTracklogAdminMessagesViaFunction({
      deviceId,
      messageIds: [id],
      locationRequestedAt,
    });
    return true;
  }).then(success => {
    if (success) removePendingLocationRequest(id);
    return success;
  });
}

export async function retryPendingAdminMessageLocationRequests() {
  let completed = 0;
  for (const messageId of readPendingLocationRequestIds()) {
    try {
      if (await requestLocationFromAdminMessage(messageId)) completed += 1;
    } catch {
      // Keep the durable pending id for the next online/resume recovery.
    }
  }
  return completed;
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
