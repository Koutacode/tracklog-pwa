import { Capacitor } from '@capacitor/core';
import { LocalNotifications, type ActionPerformed, type ActionType } from '@capacitor/local-notifications';
import { checkNotificationPermissionStatus } from './nativeSetup';
import {
  clearPendingExpresswayEndDecision,
  clearPendingExpresswayEndPrompt,
  clearPendingExpresswayEndPromptIfMatches,
  endExpressway,
  getPendingExpresswayEndPrompt,
  setPendingExpresswayEndDecision,
  setPendingExpresswayEndPrompt,
  type PendingExpresswayEndPrompt,
} from '../db/repositories';
import { enqueueNotificationExpresswayEndIcResolution } from './expresswayIcResolution';

const ACTION_TYPE_ID = 'tracklog_expressway_end_actions';
const ACTION_END = 'end_expressway';
const ACTION_KEEP = 'keep_expressway';
const CHANNEL_ID = 'tracklog_expressway_alert';
const EXTRA_KIND = 'expressway_end_prompt_v1';
const RESIDENT_SERVICE_NOTIFICATION_OWNER = 'resident-service';

export const NATIVE_EXPRESSWAY_NOTIFICATION_ACTION_TYPE: ActionType = {
  id: ACTION_TYPE_ID,
  actions: [
    { id: ACTION_END, title: '終了する', foreground: false },
    { id: ACTION_KEEP, title: 'まだ高速中', foreground: false },
  ],
};

let initialized = false;
let initPromise: Promise<void> | null = null;

function isNative() {
  return Capacitor.isNativePlatform();
}

function toNotificationId(tripId: string) {
  let hash = 0;
  for (let i = 0; i < tripId.length; i++) {
    hash = (hash * 31 + tripId.charCodeAt(i)) >>> 0;
  }
  return 610000 + (hash % 120000);
}

function parsePromptFromExtra(extra: any): PendingExpresswayEndPrompt | null {
  if (!extra || typeof extra !== 'object') return null;
  if (extra.kind !== EXTRA_KIND) return null;
  const tripId = typeof extra.tripId === 'string' ? extra.tripId.trim() : '';
  const speedKmh = Number(extra.speedKmh);
  const detectedAt = typeof extra.detectedAt === 'string' ? extra.detectedAt : '';
  const lat = Number(extra.lat);
  const lng = Number(extra.lng);
  const accuracy = Number(extra.accuracy);
  const promptId = typeof extra.promptId === 'string' ? extra.promptId.trim() : '';
  const reason = extra.reason && typeof extra.reason === 'object' ? extra.reason : undefined;
  if (!tripId || !Number.isFinite(speedKmh) || !detectedAt || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  return {
    tripId,
    ...(promptId ? { promptId } : {}),
    speedKmh: Math.max(0, Math.min(200, Math.round(speedKmh))),
    detectedAt,
    geo: {
      lat,
      lng,
      ...(Number.isFinite(accuracy) ? { accuracy } : {}),
    },
    ...(reason ? { reason } : {}),
  };
}

function promptIdentity(prompt: PendingExpresswayEndPrompt) {
  return {
    tripId: prompt.tripId,
    promptId: prompt.promptId,
    nativeDetectionId: prompt.reason?.nativeDetectionId,
  };
}

async function clearHandledPrompt(prompt: PendingExpresswayEndPrompt) {
  if (prompt.promptId || prompt.reason?.nativeDetectionId) {
    return clearPendingExpresswayEndPromptIfMatches(promptIdentity(prompt));
  }
  await clearPendingExpresswayEndPrompt(prompt.tripId);
  return true;
}

async function canPersistFailedPromptAction(prompt: PendingExpresswayEndPrompt) {
  const current = await getPendingExpresswayEndPrompt();
  if (!current) return true;
  if (current.tripId !== prompt.tripId) return false;
  if (prompt.promptId) return current.promptId === prompt.promptId;
  if (prompt.reason?.nativeDetectionId) {
    return current.reason?.nativeDetectionId === prompt.reason.nativeDetectionId;
  }
  return !current.promptId && !current.reason?.nativeDetectionId;
}

async function ensureNativePermission(): Promise<boolean> {
  const current = await LocalNotifications.checkPermissions();
  if (current.display === 'granted') return true;
  if (current.display === 'denied') return false;
  const requested = await LocalNotifications.requestPermissions();
  return requested.display === 'granted';
}

async function setupNativeActionBindings() {
  try {
    await LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: '高速道路確認',
      description: '高速道路終了確認',
      importance: 5,
      visibility: 1,
      vibration: true,
      lights: true,
      lightColor: '#f97316',
    });
  } catch {
    // channel may already exist
  }
}

export async function handleNativeExpresswayPromptNotificationAction(
  event: ActionPerformed,
): Promise<boolean> {
  if (event.notification?.extra?.owner === RESIDENT_SERVICE_NOTIFICATION_OWNER) return false;
  const prompt = parsePromptFromExtra(event.notification?.extra);
  if (!prompt) return false;
  if (event.actionId === ACTION_END) {
    let shouldCancel = true;
    try {
      const { eventId } = await endExpressway({
        tripId: prompt.tripId,
        geo: prompt.geo,
        autoDecision: prompt.reason,
        source: 'automatic_detection',
        automaticConfirmation: 'confirmed',
      });
      enqueueNotificationExpresswayEndIcResolution({ eventId, geo: prompt.geo });
      await clearHandledPrompt(prompt);
      await clearPendingExpresswayEndDecision(prompt.tripId);
    } catch {
      if (await canPersistFailedPromptAction(prompt)) {
        await setPendingExpresswayEndPrompt(prompt);
        await setPendingExpresswayEndDecision({
          tripId: prompt.tripId,
          promptId: prompt.promptId,
          nativeDetectionId: prompt.reason?.nativeDetectionId,
          action: 'end',
          decidedAt: new Date().toISOString(),
          speedKmh: prompt.speedKmh,
          geo: prompt.geo,
        });
      } else {
        shouldCancel = false;
      }
    }
    if (shouldCancel) await cancelNativeExpresswayEndPrompt(prompt.tripId);
    return true;
  }
  if (event.actionId === ACTION_KEEP) {
    const cleared = await clearHandledPrompt(prompt);
    if (!cleared) return true;
    await setPendingExpresswayEndDecision({
      tripId: prompt.tripId,
      promptId: prompt.promptId,
      nativeDetectionId: prompt.reason?.nativeDetectionId,
      action: 'keep',
      decidedAt: new Date().toISOString(),
      speedKmh: prompt.speedKmh,
      geo: prompt.geo,
    });
    await cancelNativeExpresswayEndPrompt(prompt.tripId);
  }
  return true;
}

export async function initNativeExpresswayPrompt() {
  if (!isNative()) return;
  if (initialized) return;
  if (initPromise) {
    await initPromise;
    return;
  }
  initPromise = (async () => {
    await setupNativeActionBindings();
    initialized = true;
  })();
  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

export async function showNativeExpresswayEndPrompt(prompt: PendingExpresswayEndPrompt): Promise<boolean> {
  if (!isNative()) return false;
  await initNativeExpresswayPrompt();
  const granted = await ensureNativePermission();
  if (!granted) return false;
  const id = toNotificationId(prompt.tripId);
  await LocalNotifications.schedule({
    notifications: [
      {
        id,
        title: 'TrackLog運行アシスト: 高速道路終了確認',
        body: `低速状態を検知しました（${prompt.speedKmh} km/h）。終了か継続かを選択してください。`,
        actionTypeId: ACTION_TYPE_ID,
        channelId: CHANNEL_ID,
        ongoing: true,
        autoCancel: false,
        extra: {
          kind: EXTRA_KIND,
          tripId: prompt.tripId,
          promptId: prompt.promptId ?? null,
          speedKmh: prompt.speedKmh,
          detectedAt: prompt.detectedAt,
          lat: prompt.geo.lat,
          lng: prompt.geo.lng,
          accuracy: prompt.geo.accuracy ?? null,
          reason: prompt.reason ?? null,
        },
      },
    ],
  });
  return true;
}

export async function cancelNativeExpresswayEndPrompt(tripId?: string) {
  if (!isNative()) return;
  if (tripId) {
    await LocalNotifications.cancel({
      notifications: [{ id: toNotificationId(tripId) }],
    });
    return;
  }
  const pending = await LocalNotifications.getPending();
  const ids = pending.notifications
    .filter(n => n.extra?.kind === EXTRA_KIND)
    .map(n => ({ id: n.id }));
  if (ids.length > 0) {
    await LocalNotifications.cancel({ notifications: ids });
  }
}

export async function getNativeNotificationDiagnostic() {
  if (!isNative()) return null;
  const notificationPermission = await checkNotificationPermissionStatus();
  return {
    notificationPermission,
  };
}
