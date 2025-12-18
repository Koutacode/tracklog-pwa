import { db } from './db';
import type {
  AppEvent,
  TripStartEvent,
  TripEndEvent,
  RestStartEvent,
  RestEndEvent,
  Geo,
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

export async function addEvent(event: AppEvent) {
  await db.events.put(event);
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

// Expressway (高速道路)
export async function addExpressway(params: { tripId: string; geo?: Geo; address?: string }) {
  const e = baseEvent({
    tripId: params.tripId,
    type: 'expressway',
    geo: params.geo,
    address: params.address,
    extras: { icResolveStatus: 'pending' },
  });
  await addEvent(e);
  return { eventId: e.id };
}

export async function getPendingExpresswayEvents(tripId?: string) {
  const arr = tripId
    ? await db.events.where('[tripId+type]').equals([tripId, 'expressway']).toArray()
    : await db.events.where('type').equals('expressway').toArray();
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
export async function backfillMissingAddresses(limit = 5): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.onLine) return false;
  const candidates = await db.events
    .filter(e => !e.address && !!(e as any).geo)
    .limit(limit)
    .toArray();
  if (candidates.length === 0) return false;
  let updated = false;
  for (const ev of candidates) {
    const geo = (ev as any).geo as Geo;
    try {
      const addr = await reverseGeocode(geo);
      if (addr) {
        await updateEventAddress(ev.id, addr);
        updated = true;
      }
    } catch {
      // ignore failures; will retry later
    }
  }
  return updated;
}
