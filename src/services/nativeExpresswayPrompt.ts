import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { checkNotificationPermissionStatus } from './nativeSetup';
import {
  clearPendingExpresswayEndDecision,
  clearPendingExpresswayEndPrompt,
  endExpressway,
  setPendingExpresswayEndDecision,
  setPendingExpresswayEndPrompt,
  type PendingExpresswayEndPrompt,
} from '../db/repositories';

const ACTION_TYPE_ID = 'tracklog_expressway_end_actions';
const ACTION_END = 'end_expressway';
const ACTION_KEEP = 'keep_expressway';
const CHANNEL_ID = 'tracklog_expressway_alert';
const EXTRA_KIND = 'expressway_end_prompt_v1';

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
  const reason = extra.reason && typeof extra.reason === 'object' ? extra.reason : undefined;
  if (!tripId || !Number.isFinite(speedKmh) || !detectedAt || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  return {
    tripId,
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

async function ensureNativePermission(): Promise<boolean> {
  const current = await LocalNotifications.checkPermissions();
  if (current.display === 'granted') return true;
  if (current.display === 'denied') return false;
  const requested = await LocalNotifications.requestPermissions();
  return requested.display === 'granted';
}

async function setupNativeActionBindings() {
  await LocalNotifications.registerActionTypes({
    types: [
      {
        id: ACTION_TYPE_ID,
        actions: [
          { id: ACTION_END, title: '終了する', foreground: false },
          { id: ACTION_KEEP, title: 'まだ高速中', foreground: false },
        ],
      },
    ],
  });
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
  await LocalNotifications.addListener('localNotificationActionPerformed', async event => {
    const prompt = parsePromptFromExtra(event.notification?.extra);
    if (!prompt) return;
    if (event.actionId === ACTION_END) {
      try {
        await endExpressway({ tripId: prompt.tripId, geo: prompt.geo, autoDecision: prompt.reason });
        await clearPendingExpresswayEndPrompt(prompt.tripId);
        await clearPendingExpresswayEndDecision(prompt.tripId);
      } catch {
        await setPendingExpresswayEndPrompt(prompt);
        await setPendingExpresswayEndDecision({
          tripId: prompt.tripId,
          action: 'end',
          decidedAt: new Date().toISOString(),
          speedKmh: prompt.speedKmh,
          geo: prompt.geo,
        });
      }
      await cancelNativeExpresswayEndPrompt(prompt.tripId);
      return;
    }
    if (event.actionId === ACTION_KEEP) {
      await clearPendingExpresswayEndPrompt(prompt.tripId);
      await setPendingExpresswayEndDecision({
        tripId: prompt.tripId,
        action: 'keep',
        decidedAt: new Date().toISOString(),
        speedKmh: prompt.speedKmh,
        geo: prompt.geo,
      });
      await cancelNativeExpresswayEndPrompt(prompt.tripId);
    }
  });
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
  let exactAlarm: 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale' | 'unknown' = 'unknown';
  try {
    const exact = await LocalNotifications.checkExactNotificationSetting();
    exactAlarm = exact.exact_alarm;
  } catch {
    exactAlarm = 'unknown';
  }
  return {
    notificationPermission,
    exactAlarm,
  };
}
