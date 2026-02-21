import { db } from './db';
import type {
  AppEvent,
  TripStartEvent,
  TripEndEvent,
  RestStartEvent,
  RestEndEvent,
  Geo,
  EventType,
  RoutePoint,
} from '../domain/types';
import { computeTotals } from '../domain/metrics';
import { reverseGeocode } from '../services/geo';

/*
 * Utilities
 */
function nowIso(): string {
  return new Date().toISOString();
}

export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as any).randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function setMeta(key: string, value: string | null) {
  if (value) {
    await db.meta.put({ key, value, updatedAt: nowIso() });
  } else {
    await db.meta.delete(key);
  }
}

async function getMeta(key: string): Promise<string | null> {
  const row = await db.meta.get(key);
  return row?.value ?? null;
}

const META_ACTIVE_TRIP_ID = 'activeTripId';
const META_AUTO_EXPRESSWAY_CONFIG = 'autoExpresswayConfig';
const META_ROUTE_TRACKING_ENABLED = 'routeTrackingEnabled';
const META_ROUTE_TRACKING_MODE = 'routeTrackingMode';
const META_PENDING_EXPRESSWAY_END_PROMPT = 'pendingExpresswayEndPrompt';
const META_PENDING_EXPRESSWAY_END_DECISION = 'pendingExpresswayEndDecision';

export type AutoExpresswayConfig = {
  speedKmh: number;
  durationSec: number;
  endSpeedKmh: number;
  endDurationSec: number;
};

export type PendingExpresswayEndPrompt = {
  tripId: string;
  speedKmh: number;
  detectedAt: string;
  geo: Geo;
};

export type PendingExpresswayEndDecision = {
  tripId: string;
  action: 'end' | 'keep';
  decidedAt: string;
  speedKmh?: number;
  geo?: Geo;
};

function normalizePendingExpresswayEndPrompt(raw: unknown): PendingExpresswayEndPrompt | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const tripId = typeof row.tripId === 'string' ? row.tripId.trim() : '';
  const speedRaw = Number(row.speedKmh);
  const detectedAt = typeof row.detectedAt === 'string' ? row.detectedAt : '';
  const geoRaw = (row.geo ?? null) as Record<string, unknown> | null;
  if (!tripId || !Number.isFinite(speedRaw) || !detectedAt || !geoRaw) return null;
  const lat = Number(geoRaw.lat);
  const lng = Number(geoRaw.lng);
  const accuracy = Number(geoRaw.accuracy);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    tripId,
    speedKmh: Math.max(0, Math.min(200, Math.round(speedRaw))),
    detectedAt,
    geo: {
      lat,
      lng,
      ...(Number.isFinite(accuracy) ? { accuracy } : {}),
    },
  };
}

function normalizePendingExpresswayEndDecision(raw: unknown): PendingExpresswayEndDecision | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const tripId = typeof row.tripId === 'string' ? row.tripId.trim() : '';
  const action = row.action === 'end' || row.action === 'keep' ? row.action : null;
  const decidedAt = typeof row.decidedAt === 'string' ? row.decidedAt : '';
  if (!tripId || !action || !decidedAt) return null;
  const speedRaw = Number(row.speedKmh);
  const geoRaw = (row.geo ?? null) as Record<string, unknown> | null;
  let geo: Geo | undefined;
  if (geoRaw) {
    const lat = Number(geoRaw.lat);
    const lng = Number(geoRaw.lng);
    const accuracy = Number(geoRaw.accuracy);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      geo = {
        lat,
        lng,
        ...(Number.isFinite(accuracy) ? { accuracy } : {}),
      };
    }
  }
  return {
    tripId,
    action,
    decidedAt,
    ...(Number.isFinite(speedRaw) ? { speedKmh: Math.max(0, Math.min(200, Math.round(speedRaw))) } : {}),
    ...(geo ? { geo } : {}),
  };
}

export const DEFAULT_AUTO_EXPRESSWAY_CONFIG: AutoExpresswayConfig = {
  speedKmh: 78,
  durationSec: 6,
  endSpeedKmh: 34,
  endDurationSec: 24,
};

function normalizeAutoExpresswayConfig(raw: Partial<AutoExpresswayConfig> | null): AutoExpresswayConfig {
  const speed = Number(raw?.speedKmh);
  const duration = Number(raw?.durationSec);
  const endSpeed = Number(raw?.endSpeedKmh);
  const endDuration = Number(raw?.endDurationSec);
  const speedKmh = Number.isFinite(speed) ? Math.min(Math.max(Math.round(speed), 30), 160) : DEFAULT_AUTO_EXPRESSWAY_CONFIG.speedKmh;
  const durationSec = Number.isFinite(duration)
    ? Math.min(Math.max(Math.round(duration), 1), 60)
    : DEFAULT_AUTO_EXPRESSWAY_CONFIG.durationSec;
  const endSpeedKmh = Number.isFinite(endSpeed)
    ? Math.min(Math.max(Math.round(endSpeed), 10), 120)
    : DEFAULT_AUTO_EXPRESSWAY_CONFIG.endSpeedKmh;
  const endDurationSec = Number.isFinite(endDuration)
    ? Math.min(Math.max(Math.round(endDuration), 5), 300)
    : DEFAULT_AUTO_EXPRESSWAY_CONFIG.endDurationSec;
  return { speedKmh, durationSec, endSpeedKmh, endDurationSec };
}

export async function getAutoExpresswayConfig(): Promise<AutoExpresswayConfig> {
  const raw = await getMeta(META_AUTO_EXPRESSWAY_CONFIG);
  if (!raw) return DEFAULT_AUTO_EXPRESSWAY_CONFIG;
  try {
    const parsed = JSON.parse(raw) as Partial<AutoExpresswayConfig>;
    return normalizeAutoExpresswayConfig(parsed);
  } catch {
    return DEFAULT_AUTO_EXPRESSWAY_CONFIG;
  }
}

export async function setAutoExpresswayConfig(config: AutoExpresswayConfig): Promise<AutoExpresswayConfig> {
  const normalized = normalizeAutoExpresswayConfig(config);
  await setMeta(META_AUTO_EXPRESSWAY_CONFIG, JSON.stringify(normalized));
  return normalized;
}

export async function getRouteTrackingEnabled(): Promise<boolean> {
  const raw = await getMeta(META_ROUTE_TRACKING_ENABLED);
  return raw === '1';
}

export async function setRouteTrackingEnabled(enabled: boolean): Promise<void> {
  await setMeta(META_ROUTE_TRACKING_ENABLED, enabled ? '1' : null);
}

export type RouteTrackingMode = 'precision' | 'battery';

export const DEFAULT_ROUTE_TRACKING_MODE: RouteTrackingMode = 'precision';

function normalizeRouteTrackingMode(raw: string | null): RouteTrackingMode {
  if (raw === 'battery' || raw === 'precision') return raw;
  return DEFAULT_ROUTE_TRACKING_MODE;
}

export async function getRouteTrackingMode(): Promise<RouteTrackingMode> {
  const raw = await getMeta(META_ROUTE_TRACKING_MODE);
  return normalizeRouteTrackingMode(raw);
}

export async function setRouteTrackingMode(mode: RouteTrackingMode): Promise<RouteTrackingMode> {
  const normalized = normalizeRouteTrackingMode(mode);
  await setMeta(META_ROUTE_TRACKING_MODE, normalized);
  return normalized;
}

export async function getPendingExpresswayEndPrompt(): Promise<PendingExpresswayEndPrompt | null> {
  const raw = await getMeta(META_PENDING_EXPRESSWAY_END_PROMPT);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return normalizePendingExpresswayEndPrompt(parsed);
  } catch {
    return null;
  }
}

export async function setPendingExpresswayEndPrompt(prompt: PendingExpresswayEndPrompt): Promise<void> {
  const normalized = normalizePendingExpresswayEndPrompt(prompt);
  if (!normalized) {
    throw new Error('高速終了確認データが不正です');
  }
  await setMeta(META_PENDING_EXPRESSWAY_END_PROMPT, JSON.stringify(normalized));
}

export async function clearPendingExpresswayEndPrompt(tripId?: string): Promise<void> {
  if (!tripId) {
    await setMeta(META_PENDING_EXPRESSWAY_END_PROMPT, null);
    return;
  }
  const current = await getPendingExpresswayEndPrompt();
  if (current?.tripId === tripId) {
    await setMeta(META_PENDING_EXPRESSWAY_END_PROMPT, null);
  }
}

export async function getPendingExpresswayEndDecision(): Promise<PendingExpresswayEndDecision | null> {
  const raw = await getMeta(META_PENDING_EXPRESSWAY_END_DECISION);
  if (!raw) return null;
  try {
    return normalizePendingExpresswayEndDecision(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export async function setPendingExpresswayEndDecision(decision: PendingExpresswayEndDecision): Promise<void> {
  const normalized = normalizePendingExpresswayEndDecision(decision);
  if (!normalized) throw new Error('高速終了アクションが不正です');
  await setMeta(META_PENDING_EXPRESSWAY_END_DECISION, JSON.stringify(normalized));
}

export async function clearPendingExpresswayEndDecision(tripId?: string): Promise<void> {
  if (!tripId) {
    await setMeta(META_PENDING_EXPRESSWAY_END_DECISION, null);
    return;
  }
  const current = await getPendingExpresswayEndDecision();
  if (current?.tripId === tripId) {
    await setMeta(META_PENDING_EXPRESSWAY_END_DECISION, null);
  }
}

// Trip active handling

/**
 * Returns the active tripId from meta if it exists and hasn't been closed.
 * If meta is inconsistent it attempts to derive the active trip from events.
 */
export async function getActiveTripId(): Promise<string | null> {
  const metaTripId = await getMeta(META_ACTIVE_TRIP_ID);
  if (metaTripId) {
    const start = await db.events.where('[tripId+type]').equals([metaTripId, 'trip_start']).first();
    if (start) {
      const end = await db.events.where('[tripId+type]').equals([metaTripId, 'trip_end']).first();
      if (!end) return metaTripId;
    }
    await setMeta(META_ACTIVE_TRIP_ID, null);
  }
  // Derive from events: latest trip_start without trip_end.
  const starts = (await db.events.where('type').equals('trip_start').toArray()) as TripStartEvent[];
  starts.sort((a, b) => b.ts.localeCompare(a.ts));
  for (const s of starts) {
    const e = await db.events.where('[tripId+type]').equals([s.tripId, 'trip_end']).first();
    if (!e) {
      await setMeta(META_ACTIVE_TRIP_ID, s.tripId);
      return s.tripId;
    }
  }
  return null;
}

export async function clearActiveTripId() {
  await setMeta(META_ACTIVE_TRIP_ID, null);
}

// Event CRUD

export async function updateEventAddress(eventId: string, address?: string) {
  await db.events.update(eventId, { address });
}

export async function updateEventTimestamp(eventId: string, ts: string) {
  const ev = await db.events.get(eventId);
  if (!ev) throw new Error('イベントが見つかりません');
  await db.events.update(eventId, { ts, syncStatus: 'pending' });
  await rebalanceDayCloseIndices(ev.tripId);
}

const SESSION_KEYS = [
  'restSessionId',
  'breakSessionId',
  'loadSessionId',
  'unloadSessionId',
  'expresswaySessionId',
] as const;

type SessionKey = (typeof SESSION_KEYS)[number];

const SESSION_KEY_BY_TYPE: Partial<Record<EventType, SessionKey>> = {
  rest_start: 'restSessionId',
  rest_end: 'restSessionId',
  break_start: 'breakSessionId',
  break_end: 'breakSessionId',
  load_start: 'loadSessionId',
  load_end: 'loadSessionId',
  unload_start: 'unloadSessionId',
  unload_end: 'unloadSessionId',
  expressway_start: 'expresswaySessionId',
  expressway_end: 'expresswaySessionId',
};

const TOGGLE_GROUPS = [
  { start: 'rest_start', end: 'rest_end', key: 'restSessionId', label: '休息' },
  { start: 'break_start', end: 'break_end', key: 'breakSessionId', label: '休憩' },
  { start: 'load_start', end: 'load_end', key: 'loadSessionId', label: '積込' },
  { start: 'unload_start', end: 'unload_end', key: 'unloadSessionId', label: '荷卸' },
  { start: 'expressway_start', end: 'expressway_end', key: 'expresswaySessionId', label: '高速道路' },
] as const;

type ToggleGroup = (typeof TOGGLE_GROUPS)[number];

function getToggleGroupByType(type: EventType): ToggleGroup | null {
  return TOGGLE_GROUPS.find(g => g.start === type || g.end === type) ?? null;
}

function pickExistingSessionId(extras: Record<string, unknown>): string | null {
  for (const key of SESSION_KEYS) {
    const val = extras[key];
    if (typeof val === 'string' && val.trim()) return val;
  }
  return null;
}

function findPairedToggleEvent(
  events: AppEvent[],
  ev: AppEvent,
  group: ToggleGroup,
  typeOverride?: EventType,
): AppEvent | undefined {
  const type = typeOverride ?? ev.type;
  const pairType = type === group.start ? group.end : group.start;
  const candidates = events.filter(e => e.type === pairType);
  const sid = (ev as any).extras?.[group.key] as string | undefined;
  if (sid) {
    const match = candidates.find(e => (e as any).extras?.[group.key] === sid);
    if (match) return match;
  }
  if (type === group.start) {
    return candidates.filter(e => e.ts >= ev.ts).sort((a, b) => a.ts.localeCompare(b.ts))[0];
  }
  return candidates.filter(e => e.ts <= ev.ts).sort((a, b) => a.ts.localeCompare(b.ts)).slice(-1)[0];
}

function applyTypeExtras(
  type: EventType,
  extras: Record<string, unknown>,
  sessionId?: string,
): Record<string, unknown> {
  const targetSessionKey = SESSION_KEY_BY_TYPE[type];
  if (targetSessionKey) {
    const sid =
      (typeof sessionId === 'string' && sessionId.trim() ? sessionId : null) ??
      (typeof extras[targetSessionKey] === 'string' && String(extras[targetSessionKey]).trim()
        ? (extras[targetSessionKey] as string)
        : null) ??
      pickExistingSessionId(extras) ??
      uuid();
    extras[targetSessionKey] = sid;
    for (const key of SESSION_KEYS) {
      if (key !== targetSessionKey) {
        delete (extras as any)[key];
      }
    }
  } else {
    for (const key of SESSION_KEYS) {
      delete (extras as any)[key];
    }
  }

  if (type === 'rest_end') {
    if (typeof (extras as any).dayClose !== 'boolean') {
      (extras as any).dayClose = false;
    }
  }
  if (type === 'expressway' || type === 'expressway_start' || type === 'expressway_end') {
    if ((extras as any).icResolveStatus == null) {
      (extras as any).icResolveStatus = 'pending';
    }
  }
  return extras;
}

export async function updateEventType(eventId: string, nextType: EventType) {
  const ev = await db.events.get(eventId);
  if (!ev) throw new Error('イベントが見つかりません');
  if (ev.type === nextType) return;
  if (ev.type === 'trip_start' || ev.type === 'trip_end') {
    throw new Error('運行開始/終了の項目は変更できません');
  }
  if (nextType === 'trip_start' || nextType === 'trip_end') {
    throw new Error('運行開始/終了には変更できません');
  }

  const events = await getEventsByTripId(ev.tripId);
  const oldGroup = getToggleGroupByType(ev.type);
  const newGroup = getToggleGroupByType(nextType);
  let pairedEvent: AppEvent | undefined;

  if (oldGroup && !newGroup) {
    throw new Error('開始/終了のイベントは単独イベントに変更できません。ペアで変更してください。');
  }

  if (newGroup) {
    pairedEvent = oldGroup ? findPairedToggleEvent(events, ev, oldGroup) : undefined;
    if (!pairedEvent) {
      pairedEvent = findPairedToggleEvent(events, ev, newGroup, nextType);
    }
    if (!pairedEvent) {
      throw new Error('開始/終了の対になるイベントが見つかりません。ペアになるイベントを先に用意してください。');
    }
  }

  const extras = { ...(ev as any).extras } as Record<string, unknown>;

  if (nextType === 'rest_start') {
    const odo = Number((extras as any).odoKm);
    if (!Number.isFinite(odo) || odo <= 0) {
      throw new Error('休息開始に変更するにはODOが必要です。先にODOを入力してください。');
    }
  }

  const sessionKey = SESSION_KEY_BY_TYPE[nextType];
  const pairedExtras = pairedEvent ? ({ ...(pairedEvent as any).extras } as Record<string, unknown>) : null;
  const sessionId =
    (sessionKey && typeof extras[sessionKey] === 'string' && String(extras[sessionKey]).trim()
      ? (extras[sessionKey] as string)
      : null) ??
    (sessionKey && pairedExtras && typeof pairedExtras[sessionKey] === 'string' && String(pairedExtras[sessionKey]).trim()
      ? (pairedExtras[sessionKey] as string)
      : null) ??
    pickExistingSessionId(extras) ??
    (pairedExtras ? pickExistingSessionId(pairedExtras) : null) ??
    (sessionKey ? uuid() : null) ??
    undefined;

  const nextExtras = applyTypeExtras(nextType, extras, sessionId);
  const updates: Array<{ id: string; type: EventType; extras: Record<string, unknown> }> = [
    { id: ev.id, type: nextType, extras: nextExtras },
  ];

  let pairType: EventType | null = null;
  if (newGroup && pairedEvent) {
    pairType = nextType === newGroup.start ? newGroup.end : newGroup.start;
    const updatedPairExtras = applyTypeExtras(pairType, pairedExtras ?? {}, sessionId);
    updates.push({ id: pairedEvent.id, type: pairType, extras: updatedPairExtras });
  }

  await db.transaction('rw', db.events, async () => {
    for (const u of updates) {
      await db.events.update(u.id, { type: u.type, extras: u.extras, syncStatus: 'pending' });
    }
  });

  const needsRebalance =
    ev.type === 'rest_end' ||
    nextType === 'rest_end' ||
    (pairedEvent?.type === 'rest_end') ||
    pairType === 'rest_end';
  if (needsRebalance) {
    await rebalanceDayCloseIndices(ev.tripId);
  }
  const needsTotals =
    ev.type === 'rest_start' ||
    nextType === 'rest_start' ||
    (pairedEvent?.type === 'rest_start') ||
    pairType === 'rest_start';
  if (needsTotals) {
    await recomputeTripEndTotals(ev.tripId);
  }
}

async function recomputeTripEndTotals(tripId: string) {
  const events = await getEventsByTripId(tripId);
  const start = events.find(e => e.type === 'trip_start') as TripStartEvent | undefined;
  const end = [...events].reverse().find(e => e.type === 'trip_end') as TripEndEvent | undefined;
  if (!start || !end) return;
  const restStarts = events.filter(e => e.type === 'rest_start') as RestStartEvent[];
  restStarts.sort((a, b) => a.ts.localeCompare(b.ts));
  const lastRestStartOdo = restStarts.length > 0 ? restStarts[restStarts.length - 1].extras.odoKm : undefined;
  const totals = computeTotals({
    odoStart: start.extras.odoKm,
    odoEnd: end.extras.odoKm,
    lastRestStartOdo,
  });
  const extras = { ...(end as any).extras, totalKm: totals.totalKm, lastLegKm: totals.lastLegKm };
  await db.events.update(end.id, { extras, syncStatus: 'pending' });
}

export async function updateEventOdo(eventId: string, odoKm: number) {
  if (!Number.isFinite(odoKm) || odoKm <= 0) throw new Error('オドメーターが不正です');
  const ev = await db.events.get(eventId);
  if (!ev) throw new Error('イベントが見つかりません');
  if (!['trip_start', 'rest_start', 'trip_end'].includes(ev.type)) {
    throw new Error('このイベントではオドメーターを編集できません');
  }
  const extras = { ...(ev as any).extras, odoKm };
  await db.events.update(eventId, { extras, syncStatus: 'pending' });
  await recomputeTripEndTotals(ev.tripId);
}

export async function updateEventLiters(eventId: string, liters: number) {
  if (!Number.isFinite(liters) || liters <= 0) throw new Error('給油量が不正です');
  const ev = await db.events.get(eventId);
  if (!ev) throw new Error('イベントが見つかりません');
  if (ev.type !== 'refuel') {
    throw new Error('給油イベントではありません');
  }
  const extras = { ...(ev as any).extras, liters };
  await db.events.update(eventId, { extras, syncStatus: 'pending' });
}

export async function addEvent(event: AppEvent) {
  await db.events.put(event);
}

export async function addRoutePoint(point: Omit<RoutePoint, 'id'> & { id?: string }): Promise<RoutePoint> {
  const id = point.id ?? uuid();
  const row: RoutePoint = {
    id,
    tripId: point.tripId,
    ts: point.ts,
    lat: point.lat,
    lng: point.lng,
    accuracy: point.accuracy,
    speed: point.speed ?? null,
    heading: point.heading ?? null,
    source: point.source,
  };
  await db.routePoints.put(row);
  return row;
}

export async function listRoutePointsByTripId(tripId: string): Promise<RoutePoint[]> {
  const arr = await db.routePoints.where('tripId').equals(tripId).toArray();
  arr.sort((a, b) => a.ts.localeCompare(b.ts));
  return arr;
}

export async function getAllRoutePoints(): Promise<RoutePoint[]> {
  const arr = await db.routePoints.toArray();
  arr.sort((a, b) => a.ts.localeCompare(b.ts));
  return arr;
}

export async function getEventsByTripId(tripId: string): Promise<AppEvent[]> {
  const arr = await db.events.where('tripId').equals(tripId).toArray();
  arr.sort((a, b) => a.ts.localeCompare(b.ts));
  return arr;
}

export async function getAllEvents(): Promise<AppEvent[]> {
  const arr = await db.events.toArray();
  arr.sort((a, b) => a.ts.localeCompare(b.ts));
  return arr;
}

// Trip operations

export async function startTrip(params: {
  odoKm: number;
  geo?: Geo;
  address?: string;
}): Promise<{ tripId: string; event: TripStartEvent }> {
  const tripId = uuid();
  const e: TripStartEvent = {
    id: uuid(),
    tripId,
    type: 'trip_start',
    ts: nowIso(),
    geo: params.geo,
    address: params.address,
    syncStatus: 'pending',
    extras: { odoKm: params.odoKm },
  };
  await db.transaction('rw', db.events, db.meta, async () => {
    await db.events.put(e);
    await setMeta(META_ACTIVE_TRIP_ID, tripId);
    await setMeta(META_PENDING_EXPRESSWAY_END_PROMPT, null);
    await setMeta(META_PENDING_EXPRESSWAY_END_DECISION, null);
  });
  return { tripId, event: e };
}

export async function endTrip(params: {
  tripId: string;
  odoEndKm: number;
  geo?: Geo;
  address?: string;
}): Promise<{ event: TripEndEvent }> {
  const events = await getEventsByTripId(params.tripId);
  const start = events.find(e => e.type === 'trip_start') as TripStartEvent | undefined;
  if (!start) throw new Error('trip_start が存在しません');
  const restStarts = events.filter(e => e.type === 'rest_start') as RestStartEvent[];
  restStarts.sort((a, b) => a.ts.localeCompare(b.ts));
  const lastRestStartOdo = restStarts.length > 0 ? restStarts[restStarts.length - 1].extras.odoKm : undefined;
  if (params.odoEndKm < start.extras.odoKm) {
    throw new Error('運行終了メーターが運行開始より小さいため保存できません');
  }
  if (lastRestStartOdo != null && params.odoEndKm < lastRestStartOdo) {
    throw new Error('運行終了メーターが最後の休息開始メーターより小さいため保存できません');
  }
  const totals = computeTotals({
    odoStart: start.extras.odoKm,
    odoEnd: params.odoEndKm,
    lastRestStartOdo,
  });
  const e: TripEndEvent = {
    id: uuid(),
    tripId: params.tripId,
    type: 'trip_end',
    ts: nowIso(),
    geo: params.geo,
    address: params.address,
    syncStatus: 'pending',
    extras: {
      odoKm: params.odoEndKm,
      totalKm: totals.totalKm,
      lastLegKm: totals.lastLegKm,
    },
  };
  await db.transaction('rw', db.events, db.meta, async () => {
    await db.events.put(e);
    await clearActiveTripId();
    await clearPendingExpresswayEndPrompt(params.tripId);
    await clearPendingExpresswayEndDecision(params.tripId);
  });
  return { event: e };
}

// Rest operations

export async function startRest(params: {
  tripId: string;
  odoKm: number;
  geo?: Geo;
  address?: string;
}): Promise<{ restSessionId: string; event: RestStartEvent }> {
  const events = await getEventsByTripId(params.tripId);
  // Validate odometer not decreasing
  const lastOdo = findLatestOdoCheckpoint(events);
  if (lastOdo != null && params.odoKm < lastOdo) {
    throw new Error('休息開始メーターが前回メーターより小さいため保存できません');
  }
  const restSessionId = uuid();
  const e: RestStartEvent = {
    id: uuid(),
    tripId: params.tripId,
    type: 'rest_start',
    ts: nowIso(),
    geo: params.geo,
    address: params.address,
    syncStatus: 'pending',
    extras: { restSessionId, odoKm: params.odoKm },
  };
  await db.events.put(e);
  return { restSessionId, event: e };
}

export async function endRest(params: {
  tripId: string;
  restSessionId: string;
  dayClose: boolean;
  geo?: Geo;
  address?: string;
}): Promise<{ event: RestEndEvent }> {
  const events = await getEventsByTripId(params.tripId);
  const hasStart = events.some(
    e => e.type === 'rest_start' && (e as any).extras?.restSessionId === params.restSessionId
  );
  if (!hasStart) throw new Error('対応する rest_start が存在しません（restSessionId不整合）');
  let dayIndex: number | undefined = undefined;
  if (params.dayClose) {
    dayIndex = getNextDayIndexFromTripEvents(events);
  }
  const e: RestEndEvent = {
    id: uuid(),
    tripId: params.tripId,
    type: 'rest_end',
    ts: nowIso(),
    geo: params.geo,
    address: params.address,
    syncStatus: 'pending',
    extras: {
      restSessionId: params.restSessionId,
      dayClose: params.dayClose,
      ...(dayIndex != null ? { dayIndex } : {}),
    },
  };
  await db.events.put(e);
  return { event: e };
}

// Helpers for day index and odometer checkpoints

function getNextDayIndexFromTripEvents(events: AppEvent[]): number {
  const closes = events.filter(
    e => e.type === 'rest_end' && (e as any).extras?.dayClose === true
  ) as RestEndEvent[];
  const indices = closes
    .map(e => (e as any).extras?.dayIndex)
    .filter((n): n is number => typeof n === 'number');
  if (indices.length > 0) return Math.max(...indices) + 1;
  return closes.length + 1;
}

function findLatestOdoCheckpoint(events: AppEvent[]): number | null {
  const sorted = [...events].sort((a, b) => b.ts.localeCompare(a.ts));
  for (const e of sorted) {
    if (e.type === 'rest_start') return (e as RestStartEvent).extras.odoKm;
    if (e.type === 'trip_start') return (e as TripStartEvent).extras.odoKm;
    if (e.type === 'trip_end') return (e as TripEndEvent).extras.odoKm;
  }
  return null;
}

// Toggle helpers
function baseEvent(params: {
  tripId: string;
  type: any;
  geo?: Geo;
  address?: string;
  extras?: Record<string, unknown>;
}): AppEvent {
  return {
    id: uuid(),
    tripId: params.tripId,
    type: params.type,
    ts: nowIso(),
    geo: params.geo,
    address: params.address,
    syncStatus: 'pending',
    extras: params.extras,
  } as AppEvent;
}

async function getTripEventsCached(tripId: string) {
  return await getEventsByTripId(tripId);
}

function findOpenToggleSessionId(
  events: AppEvent[],
  startType: string,
  endType: string,
  key: string,
): string | null {
  const starts = events.filter(e => e.type === startType).sort((a, b) => a.ts.localeCompare(b.ts));
  const ends = events.filter(e => e.type === endType);
  for (let i = starts.length - 1; i >= 0; i--) {
    const sid = (starts[i] as any).extras?.[key] as string | undefined;
    if (!sid) continue;
    const hasEnd = ends.some(en => (en as any).extras?.[key] === sid);
    if (!hasEnd) return sid;
  }
  const lastStart = starts[starts.length - 1];
  if (lastStart) {
    const hasEndAfter = ends.some(en => en.ts > lastStart.ts);
    if (!hasEndAfter) return '__legacy__';
  }
  return null;
}

// Load (積込) operations
export async function startLoad(params: { tripId: string; geo?: Geo; address?: string }) {
  const events = await getTripEventsCached(params.tripId);
  const open = findOpenToggleSessionId(events, 'load_start', 'load_end', 'loadSessionId');
  if (open) throw new Error('積込がすでに開始されています（終了してください）');
  const loadSessionId = uuid();
  const e = baseEvent({
    tripId: params.tripId,
    type: 'load_start',
    geo: params.geo,
    address: params.address,
    extras: { loadSessionId },
  });
  await addEvent(e);
  return { loadSessionId };
}

export async function endLoad(params: { tripId: string; geo?: Geo; address?: string }) {
  const events = await getTripEventsCached(params.tripId);
  const open = findOpenToggleSessionId(events, 'load_start', 'load_end', 'loadSessionId');
  if (!open) throw new Error('積込が開始されていません');
  const e = baseEvent({
    tripId: params.tripId,
    type: 'load_end',
    geo: params.geo,
    address: params.address,
    extras: open === '__legacy__' ? undefined : { loadSessionId: open },
  });
  await addEvent(e);
}

// Unload (荷卸) operations
export async function startUnload(params: { tripId: string; geo?: Geo; address?: string }) {
  const events = await getTripEventsCached(params.tripId);
  const open = findOpenToggleSessionId(events, 'unload_start', 'unload_end', 'unloadSessionId');
  if (open) throw new Error('荷卸がすでに開始されています（終了してください）');
  const unloadSessionId = uuid();
  const e = baseEvent({
    tripId: params.tripId,
    type: 'unload_start',
    geo: params.geo,
    address: params.address,
    extras: { unloadSessionId },
  });
  await addEvent(e);
  return { unloadSessionId };
}

export async function endUnload(params: { tripId: string; geo?: Geo; address?: string }) {
  const events = await getTripEventsCached(params.tripId);
  const open = findOpenToggleSessionId(events, 'unload_start', 'unload_end', 'unloadSessionId');
  if (!open) throw new Error('荷卸が開始されていません');
  const e = baseEvent({
    tripId: params.tripId,
    type: 'unload_end',
    geo: params.geo,
    address: params.address,
    extras: open === '__legacy__' ? undefined : { unloadSessionId: open },
  });
  await addEvent(e);
}

// Break (休憩) operations
export async function startBreak(params: { tripId: string; geo?: Geo; address?: string }) {
  const events = await getTripEventsCached(params.tripId);
  const open = findOpenToggleSessionId(events, 'break_start', 'break_end', 'breakSessionId');
  if (open) throw new Error('休憩がすでに開始されています（終了してください）');
  const breakSessionId = uuid();
  const e = baseEvent({
    tripId: params.tripId,
    type: 'break_start',
    geo: params.geo,
    address: params.address,
    extras: { breakSessionId },
  });
  await addEvent(e);
  return { breakSessionId };
}

export async function endBreak(params: { tripId: string; geo?: Geo; address?: string }) {
  const events = await getTripEventsCached(params.tripId);
  const open = findOpenToggleSessionId(events, 'break_start', 'break_end', 'breakSessionId');
  if (!open) throw new Error('休憩が開始されていません');
  const e = baseEvent({
    tripId: params.tripId,
    type: 'break_end',
    geo: params.geo,
    address: params.address,
    extras: open === '__legacy__' ? undefined : { breakSessionId: open },
  });
  await addEvent(e);
}

// Refuel (給油)
export async function addRefuel(params: {
  tripId: string;
  liters: number;
  geo?: Geo;
  address?: string;
}) {
  if (!Number.isFinite(params.liters) || params.liters <= 0) {
    throw new Error('給油量が不正です');
  }
  const e = baseEvent({
    tripId: params.tripId,
    type: 'refuel',
    geo: params.geo,
    address: params.address,
    extras: { liters: params.liters },
  });
  await addEvent(e);
}

// Boarding (乗船)
export async function addBoarding(params: { tripId: string; geo?: Geo; address?: string }) {
  const e = baseEvent({
    tripId: params.tripId,
    type: 'boarding',
    geo: params.geo,
    address: params.address,
  });
  await addEvent(e);
}

// Point mark (地点マーク)
export async function addPointMark(params: {
  tripId: string;
  geo?: Geo;
  address?: string;
  label?: string;
}) {
  const e = baseEvent({
    tripId: params.tripId,
    type: 'point_mark',
    geo: params.geo,
    address: params.address,
    extras: params.label ? { label: params.label } : undefined,
  });
  await addEvent(e);
}

// Expressway (高速道路)
export async function startExpressway(params: { tripId: string; geo?: Geo; address?: string }) {
  const events = await getTripEventsCached(params.tripId);
  const open = findOpenToggleSessionId(events, 'expressway_start', 'expressway_end', 'expresswaySessionId');
  if (open) throw new Error('高速道路が開始済みです（終了を押してください）');
  const expresswaySessionId = uuid();
  const e = baseEvent({
    tripId: params.tripId,
    type: 'expressway_start',
    geo: params.geo,
    address: params.address,
    extras: { expresswaySessionId, icResolveStatus: 'pending' },
  });
  await addEvent(e);
  await clearPendingExpresswayEndPrompt(params.tripId);
  await clearPendingExpresswayEndDecision(params.tripId);
  return { expresswaySessionId, eventId: e.id };
}

export async function endExpressway(params: { tripId: string; geo?: Geo; address?: string }) {
  const events = await getTripEventsCached(params.tripId);
  const open = findOpenToggleSessionId(events, 'expressway_start', 'expressway_end', 'expresswaySessionId');
  if (!open) throw new Error('高速道路が開始されていません');
  const e = baseEvent({
    tripId: params.tripId,
    type: 'expressway_end',
    geo: params.geo,
    address: params.address,
    extras: open === '__legacy__' ? { icResolveStatus: 'pending' } : { expresswaySessionId: open, icResolveStatus: 'pending' },
  });
  await addEvent(e);
  await clearPendingExpresswayEndPrompt(params.tripId);
  await clearPendingExpresswayEndDecision(params.tripId);
  return { eventId: e.id };
}

export async function getPendingExpresswayEvents(tripId?: string) {
  const types = ['expressway', 'expressway_start', 'expressway_end'];
  const arr = tripId
    ? await db.events.where('[tripId+type]').anyOf(types.map(t => [tripId, t])).toArray()
    : await db.events.where('type').anyOf(types).toArray();
  return arr.filter(e => (e as any).extras?.icResolveStatus === 'pending');
}

export async function updateExpresswayResolved(params: {
  eventId: string;
  status: 'resolved' | 'failed';
  icName?: string;
  icDistanceM?: number;
}) {
  const ev = await db.events.get(params.eventId);
  if (!ev) return;
  const extras = { ...(ev as any).extras };
  extras.icResolveStatus = params.status;
  if (params.icName) extras.icName = params.icName;
  if (params.icDistanceM != null) extras.icDistanceM = params.icDistanceM;
  await db.events.update(params.eventId, { extras });
}

// Trip summary
export type TripSummary = {
  tripId: string;
  startTs: string;
  endTs?: string;
  odoStart: number;
  odoEnd?: number;
  totalKm?: number;
  lastLegKm?: number;
  status: 'active' | 'closed';
};

export async function listTrips(): Promise<TripSummary[]> {
  const starts = (await db.events.where('type').equals('trip_start').toArray()) as TripStartEvent[];
  const ends = (await db.events.where('type').equals('trip_end').toArray()) as TripEndEvent[];
  const endByTrip = new Map<string, TripEndEvent>();
  for (const e of ends) {
    const prev = endByTrip.get(e.tripId);
    if (!prev || e.ts > prev.ts) endByTrip.set(e.tripId, e);
  }
  const summaries: TripSummary[] = starts.map(s => {
    const end = endByTrip.get(s.tripId);
    return {
      tripId: s.tripId,
      startTs: s.ts,
      endTs: end?.ts,
      odoStart: s.extras.odoKm,
      odoEnd: end?.extras.odoKm,
      totalKm: end?.extras.totalKm,
      lastLegKm: end?.extras.lastLegKm,
      status: end ? 'closed' : 'active',
    };
  });
  summaries.sort((a, b) => b.startTs.localeCompare(a.startTs));
  return summaries;
}

/**
 * Backfill addresses for events that already have geo but no address (e.g. recordedオフライン).
 * Limits requests to avoid spamming the API.
 * Returns true if any address was updated.
 */
export async function backfillMissingAddresses(limit = 30, batches = 2): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.onLine) return false;

  let updatedAny = false;
  for (let i = 0; i < batches; i++) {
    const candidates = await db.events
      .filter(e => !e.address && !!(e as any).geo)
      .limit(limit)
      .toArray();
    if (candidates.length === 0) break;

    let updatedBatch = false;
    for (const ev of candidates) {
      const geo = (ev as any).geo as Geo;
      try {
        const addr = await reverseGeocode(geo);
        if (addr) {
          await updateEventAddress(ev.id, addr);
          updatedAny = true;
          updatedBatch = true;
        }
      } catch {
        // ignore failures; will retry later
      }
    }
    if (!updatedBatch) break; // avoid tight loops when nothing could be resolved
  }
  return updatedAny;
}

export async function deleteTrip(tripId: string): Promise<void> {
  await db.transaction('rw', db.events, db.meta, async () => {
    await db.events.where('tripId').equals(tripId).delete();
    const active = await db.meta.get(META_ACTIVE_TRIP_ID);
    if (active?.value === tripId) {
      await db.meta.delete(META_ACTIVE_TRIP_ID);
    }
  });
}

/**
 * Delete a single event. Trip startは運行の基点なので削除不可とする。
 * rest_end (dayClose) の並びが変わる場合は日次インデックスを再計算する。
 */
export async function deleteEvent(eventId: string): Promise<void> {
  const ev = await db.events.get(eventId);
  if (!ev) return;
  if (ev.type === 'trip_start') throw new Error('運行開始イベントは削除できません（運行ごと削除してください）');
  await db.events.delete(eventId);
  await rebalanceDayCloseIndices(ev.tripId);
}

/**
 * 手動で住所を上書きする。同期が必要な場合を想定し syncStatus を pending に戻す。
 */
export async function updateEventAddressManual(eventId: string, address: string) {
  if (!address.trim()) throw new Error('住所を入力してください');
  const ev = await db.events.get(eventId);
  if (!ev) throw new Error('イベントが見つかりません');
  await db.events.update(eventId, { address: address.trim(), syncStatus: 'pending' });
}

/**
 * 位置情報があるイベントに対して逆ジオコーディングを再実行する。
 * より詳細な住所を取得できた場合に上書きする。
 */
export async function refreshEventAddressFromGeo(eventId: string): Promise<string | undefined> {
  const ev = await db.events.get(eventId);
  if (!ev) throw new Error('イベントが見つかりません');
  const geo = (ev as any).geo as Geo | undefined;
  if (!geo) throw new Error('このイベントには位置情報が保存されていません');
  const addr = await reverseGeocode(geo);
  if (addr) {
    await db.events.update(eventId, { address: addr, syncStatus: 'pending' });
  }
  return addr;
}

// ---- Helpers ----

async function rebalanceDayCloseIndices(tripId: string) {
  const events = await getEventsByTripId(tripId);
  const dayCloses = events.filter(
    e => e.type === 'rest_end' && (e as RestEndEvent).extras?.dayClose
  ) as RestEndEvent[];
  const sorted = [...dayCloses].sort((a, b) => a.ts.localeCompare(b.ts));
  await Promise.all(
    sorted.map((e, idx) => {
      const extras = { ...(e as any).extras, dayIndex: idx + 1 };
      return db.events.update(e.id, { extras });
    })
  );
}
