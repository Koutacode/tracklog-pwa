import { db } from '../db/db';
import {
  deleteTrip,
  getActiveTripId,
  getAllEvents,
  getDeletedEventTombstones,
  getEventsByTripId,
  getLatestRoutePoint,
  getRemoteRoutePointsUploadedThrough,
  listRoutePointsChangedSince,
  listTrips,
  setRemoteRoutePointsUploadedThrough,
} from '../db/repositories';
import { listReportTrips } from '../db/reportRepository';
import type { AppEvent, EventType, RoutePoint } from '../domain/types';
import type {
  DriverIdentity,
  RemoteCloudMaintenanceResult,
  RemoteDeletedEventTombstone,
  RemoteDeletedTripTombstone,
  RemoteTripHeader,
  RemoteReportSnapshot,
  RemoteRoutePoint,
  RemoteSyncState,
  RemoteTripEvent,
} from '../domain/remoteTypes';
import { subscribeRemoteSyncRequests, withRemoteSyncSignalsSuppressed } from '../app/remoteSyncSignal';
import {
  claimTracklogDeviceProfile,
  getDriverIdentity,
  getRemoteLastSyncAt,
  initializeDriverIdentity,
  setRemoteLastSyncAt,
} from './remoteAuth';
import { driverSupabase, SUPABASE_CONFIGURED } from './supabase';

type Listener = (state: RemoteSyncState) => void;

const listeners = new Set<Listener>();

let state: RemoteSyncState = {
  configured: SUPABASE_CONFIGURED,
  enabled: true,
  syncing: false,
  lastSyncAt: null,
  lastError: null,
  deviceId: null,
  displayName: '',
  vehicleLabel: '',
  authInitialized: false,
  profileComplete: false,
  approvalStatus: 'unregistered',
};

let inFlight: Promise<RemoteSyncState> | null = null;

const META_REMOTE_CLOUD_MAINTENANCE_CHECKED_AT = 'remoteCloudMaintenanceCheckedAt';
const META_REMOTE_CLOUD_DETAIL_RETENTION_CUTOFF_AT = 'remoteCloudDetailRetentionCutoffAt';
const CLOUD_MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REMOTE_DEVICE_IDS_CHUNK_SIZE = 50;

const KNOWN_EVENT_TYPES: Set<EventType> = new Set([
  'trip_start',
  'trip_end',
  'rest_start',
  'rest_end',
  'break_start',
  'break_end',
  'load_start',
  'load_end',
  'unload_start',
  'unload_end',
  'refuel',
  'boarding',
  'disembark',
  'expressway',
  'expressway_start',
  'expressway_end',
  'point_mark',
]);

const REMOTE_ROUTE_POINT_SOURCES: Set<RoutePoint['source']> = new Set([
  'foreground',
  'background',
  'event',
]);

const LOCAL_SYNC_HEADER_EVENT_ID_PREFIX = 'header-sync';
const HEADER_SYNC_EVENT_START = `${LOCAL_SYNC_HEADER_EVENT_ID_PREFIX}-trip-start`;
const HEADER_SYNC_EVENT_END = `${LOCAL_SYNC_HEADER_EVENT_ID_PREFIX}-trip-end`;
const EVENT_ROUTE_POINT_ANCHOR_PREFIX = 'event-anchor-';

function emit(patch: Partial<RemoteSyncState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

function nowIso() {
  return new Date().toISOString();
}

async function getMeta(key: string): Promise<string | null> {
  const row = await db.meta.get(key);
  return row?.value ?? null;
}

async function setMeta(key: string, value: string | null): Promise<void> {
  if (!value) {
    await db.meta.delete(key);
    return;
  }
  await db.meta.put({
    key,
    value,
    updatedAt: nowIso(),
  });
}

function isMissingRpcError(error: any) {
  const message = `${error?.message ?? error ?? ''}`.toLowerCase();
  return error?.code === 'PGRST202' || message.includes('prune_tracklog_cloud_usage');
}

function isMissingTableError(error: any, table: string) {
  const message = `${error?.message ?? error ?? ''}`.toLowerCase();
  const tableName = table.toLowerCase();
  return (
    error?.code === '42P01' ||
    error?.code === 'PGRST205' ||
    message.includes(`relation "${tableName}" does not exist`) ||
    message.includes(`could not find the table '${tableName}'`) ||
    (message.includes('schema cache') && message.includes(tableName))
  );
}

function normalizeIso(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function normalizeEventType(raw: unknown): EventType | null {
  if (typeof raw !== 'string') return null;
  return KNOWN_EVENT_TYPES.has(raw as EventType) ? (raw as EventType) : null;
}

function normalizeSyncStatus(raw: unknown) {
  if (raw === 'pending' || raw === 'synced' || raw === 'error') return raw;
  return 'synced';
}

function normalizeRemoteExtras(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return { ...raw };
}

function normalizeRemoteGeo(raw: unknown): { lat: number; lng: number; accuracy?: number } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const lat = Number(r.lat);
  const lng = Number(r.lng);
  const accuracy = Number(r.accuracy);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return {
    lat,
    lng,
    ...(Number.isFinite(accuracy) ? { accuracy } : {}),
  };
}

function toMapStringSet(values: Array<{ device_id?: string | null }> | undefined | null): string[] {
  if (!Array.isArray(values)) return [];
  const next = new Set<string>();
  for (const item of values) {
    const id = typeof item.device_id === 'string' ? item.device_id.trim() : '';
    if (id) next.add(id);
  }
  return [...next];
}

function chunkArray<T>(items: T[], size: number) {
  const list = items ?? [];
  if (size <= 0) return [list];
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}

function uniqueByKey<T>(items: T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFor(item).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function parseRemoteEvent(raw: unknown): AppEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const tripId = typeof row.trip_id === 'string' ? row.trip_id.trim() : '';
  const ts = normalizeIso(row.ts);
  const type = normalizeEventType(row.type);
  if (!id || !tripId || !ts || !type) return null;
  const address = typeof row.address === 'string' && row.address.trim() ? row.address.trim() : undefined;
  return {
    id,
    tripId,
    type,
    ts,
    ...(address ? { address } : {}),
    ...(normalizeRemoteGeo(row.geo) ? { geo: normalizeRemoteGeo(row.geo)! } : {}),
    syncStatus: normalizeSyncStatus(row.sync_status),
    ...(normalizeRemoteExtras(row.extras) ? { extras: normalizeRemoteExtras(row.extras)! } : {}),
  };
}

function parseRemoteRoutePoint(raw: unknown): RoutePoint | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const tripId = typeof row.trip_id === 'string' ? row.trip_id.trim() : '';
  const ts = normalizeIso(row.ts);
  const lat = Number(row.lat);
  const lng = Number(row.lng);
  const accuracy = Number(row.accuracy);
  const speed = Number(row.speed);
  const heading = Number(row.heading);
  if (!id || !tripId || !ts || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const sourceRaw = row.source;
  const source = typeof sourceRaw === 'string' && REMOTE_ROUTE_POINT_SOURCES.has(sourceRaw as RoutePoint['source'])
    ? sourceRaw
    : null;

  return {
    id,
    tripId,
    ts,
    updatedAt: normalizeIso(row.updated_at) ?? normalizeIso(row.ts)!,
    lat,
    lng,
    ...(Number.isFinite(accuracy) ? { accuracy } : {}),
    ...(Number.isFinite(speed) ? { speed } : {}),
    ...(Number.isFinite(heading) ? { heading } : {}),
    ...(source ? { source: source as RoutePoint['source'] } : {}),
  };
}

async function getUserDeviceIds(userId: string): Promise<string[]> {
  if (!driverSupabase) return [];
  const { data, error } = await driverSupabase
    .from('device_profiles')
    .select('device_id')
    .eq('auth_user_id', userId);
  if (error) {
    throw new Error(error.message || 'device_profiles の参照に失敗しました');
  }
  const ids = toMapStringSet(data as Array<{ device_id?: string | null }>);
  if (ids.length === 0) return [];

  const query: string[] = [];
  const trimmed = ids.map(id => id.trim()).filter(Boolean);
  for (const item of trimmed) {
    if (!query.includes(item)) query.push(item);
  }
  return query;
}

async function fetchTableByDeviceIds<T extends Record<string, unknown>>(table: string): Promise<T[]> {
  if (!driverSupabase) return [];
  const session = await driverSupabase.auth.getSession();
  const userId = session.data.session?.user?.id?.trim();
  if (!userId) return [];
  const deviceIds = await getUserDeviceIds(userId);
  if (deviceIds.length === 0) return [];

  const rows: T[] = [];
  const chunks = chunkArray(deviceIds, REMOTE_DEVICE_IDS_CHUNK_SIZE);
  for (const ids of chunks) {
    if (ids.length === 0) continue;
    const query = driverSupabase
      .from(table)
      .select('*')
      .in('device_id', ids)
      .order('ts', { ascending: true });
    const { data, error } = await query;
    if (error) {
      throw new Error(error.message || `${table} の取得に失敗しました`);
    }
    if (Array.isArray(data)) {
      rows.push(...(data as T[]));
    }
  }
  return rows;
}

async function fetchUserCloudTripHeaders(): Promise<RemoteTripHeader[]> {
  if (!driverSupabase) return [];
  const session = await driverSupabase.auth.getSession();
  const userId = session.data.session?.user?.id?.trim();
  if (!userId) return [];
  const deviceIds = await getUserDeviceIds(userId);
  if (deviceIds.length === 0) return [];

  const headers: RemoteTripHeader[] = [];
  for (const chunk of chunkArray(deviceIds, REMOTE_DEVICE_IDS_CHUNK_SIZE)) {
    if (chunk.length === 0) continue;
    const result = await driverSupabase
      .from('trip_headers')
      .select('*')
      .in('device_id', chunk)
      .order('start_ts', { ascending: true });
    if (result.error) {
      throw new Error(result.error.message || 'trip_headers の取得に失敗しました');
    }
    if (Array.isArray(result.data)) {
      headers.push(...(result.data as RemoteTripHeader[]));
    }
  }
  return headers;
}

async function fetchUserDeletedTripIds(): Promise<Set<string>> {
  if (!driverSupabase) return new Set();
  const session = await driverSupabase.auth.getSession();
  const userId = session.data.session?.user?.id?.trim();
  if (!userId) return new Set();
  const deviceIds = await getUserDeviceIds(userId);
  if (deviceIds.length === 0) return new Set();

  const tombstones: RemoteDeletedTripTombstone[] = [];
  for (const chunk of chunkArray(deviceIds, REMOTE_DEVICE_IDS_CHUNK_SIZE)) {
    if (chunk.length === 0) continue;
    const result = await driverSupabase
      .from('deleted_trip_tombstones')
      .select('*')
      .in('device_id', chunk)
      .order('deleted_at', { ascending: true });
    if (result.error) {
      if (isMissingTableError(result.error, 'deleted_trip_tombstones')) {
        return new Set();
      }
      throw new Error(result.error.message || 'deleted_trip_tombstones の取得に失敗しました');
    }
    if (Array.isArray(result.data)) {
      tombstones.push(...(result.data as RemoteDeletedTripTombstone[]));
    }
  }

  return new Set(tombstones.map(item => item.trip_id).filter(Boolean));
}

async function fetchUserDeletedEventIds(): Promise<Set<string>> {
  if (!driverSupabase) return new Set();
  const session = await driverSupabase.auth.getSession();
  const userId = session.data.session?.user?.id?.trim();
  if (!userId) return new Set();
  const deviceIds = await getUserDeviceIds(userId);
  if (deviceIds.length === 0) return new Set();

  const tombstones: RemoteDeletedEventTombstone[] = [];
  for (const chunk of chunkArray(deviceIds, REMOTE_DEVICE_IDS_CHUNK_SIZE)) {
    if (chunk.length === 0) continue;
    const result = await driverSupabase
      .from('deleted_event_tombstones')
      .select('*')
      .in('device_id', chunk)
      .order('deleted_at', { ascending: true });
    if (result.error) {
      if (isMissingTableError(result.error, 'deleted_event_tombstones')) {
        return new Set();
      }
      throw new Error(result.error.message || 'deleted_event_tombstones の取得に失敗しました');
    }
    if (Array.isArray(result.data)) {
      tombstones.push(...(result.data as RemoteDeletedEventTombstone[]));
    }
  }

  return new Set(tombstones.map(item => item.event_id).filter(Boolean));
}

async function removeLocalDeletedTrips(deletedTripIds: Set<string>): Promise<void> {
  if (deletedTripIds.size === 0) return;
  await withRemoteSyncSignalsSuppressed(async () => {
    for (const tripId of deletedTripIds) {
      await deleteTrip(tripId);
    }
  });
}

async function removeLocalDeletedEvents(deletedEventIds: Set<string>): Promise<void> {
  if (deletedEventIds.size === 0) return;
  await withRemoteSyncSignalsSuppressed(async () => {
    await db.transaction('rw', db.events, db.routePoints, async () => {
      for (const eventId of deletedEventIds) {
        await db.events.delete(eventId);
        await db.routePoints.delete(`${EVENT_ROUTE_POINT_ANCHOR_PREFIX}${eventId}`);
      }
    });
  });
}

async function uploadDeletedEventTombstones(deviceId: string): Promise<Set<string>> {
  const local = await getDeletedEventTombstones();
  const ids = new Set(local.map(item => item.eventId).filter(Boolean));
  if (local.length === 0 || !driverSupabase) return ids;

  const session = await driverSupabase.auth.getSession();
  const userId = session.data.session?.user?.id?.trim();
  if (!userId) return ids;

  const rows: RemoteDeletedEventTombstone[] = uniqueByKey(local, item => item.eventId).map(item => ({
    event_id: item.eventId,
    trip_id: item.tripId,
    device_id: deviceId,
    event_type: item.eventType ?? null,
    event_ts: item.eventTs ?? null,
    deleted_by: userId,
    deleted_at: item.deletedAt,
  }));
  const { error } = await driverSupabase.from('deleted_event_tombstones').upsert(rows, {
    onConflict: 'event_id',
  });
  if (error) {
    if (isMissingTableError(error, 'deleted_event_tombstones')) {
      return ids;
    }
    throw error;
  }
  return ids;
}

function normalizeHeaderStartEvent(header: RemoteTripHeader): AppEvent {
  return {
    id: `${HEADER_SYNC_EVENT_START}-${header.trip_id}`,
    tripId: header.trip_id,
    type: 'trip_start',
    ts: normalizeIso(header.start_ts) || header.start_ts,
    syncStatus: 'synced',
    extras: { odoKm: header.odo_start },
  };
}

function normalizeHeaderEndEvent(header: RemoteTripHeader): AppEvent {
  const endTs = normalizeIso(header.end_ts) || header.end_ts || nowIso();
  return {
    id: `${HEADER_SYNC_EVENT_END}-${header.trip_id}`,
    tripId: header.trip_id,
    type: 'trip_end',
    ts: endTs,
    syncStatus: 'synced',
    extras: {
      odoKm: header.odo_end ?? 0,
      totalKm: header.total_km ?? 0,
      lastLegKm: header.last_leg_km ?? 0,
    },
  };
}

async function applyRemoteDownload(rows: {
  headers: RemoteTripHeader[];
  events: RemoteTripEvent[];
  routePoints: RemoteRoutePoint[];
  cloudCutoff: string | null;
  deletedTripIds: Set<string>;
  deletedEventIds: Set<string>;
}) {
  const visibleHeaders = rows.headers.filter(item => !rows.deletedTripIds.has(item.trip_id));
  const normalizedEvents = rows.events
    .map(parseRemoteEvent)
    .filter((item): item is AppEvent =>
      item !== null &&
      !rows.deletedTripIds.has(item.tripId) &&
      !rows.deletedEventIds.has(item.id),
    );
  const deletedEventAnchorIds = new Set([...rows.deletedEventIds].map(id => `${EVENT_ROUTE_POINT_ANCHOR_PREFIX}${id}`));
  const normalizedRoutePoints = rows.routePoints
    .map(parseRemoteRoutePoint)
    .filter((item): item is RoutePoint =>
      item !== null &&
      !rows.deletedTripIds.has(item.tripId) &&
      !deletedEventAnchorIds.has(item.id),
    );

  const prunedHeaders = rows.cloudCutoff
    ? visibleHeaders.filter(item =>
        !(item.status === 'closed' && item.end_ts && Number.isFinite(Date.parse(item.end_ts)) && Date.parse(item.end_ts) < Date.parse(rows.cloudCutoff!)),
      )
    : visibleHeaders;
  const prunedTripIds = getCloudDetailPrunedTripIds(prunedHeaders, rows.cloudCutoff);

  const targetEvents = normalizedEvents.filter(item => !prunedTripIds.has(item.tripId));
  const targetRoutePoints = normalizedRoutePoints.filter(item => !prunedTripIds.has(item.tripId));
  const targetEventIds = targetEvents.map(item => item.id);
  const localEventsById = new Map<string, AppEvent>();
  if (targetEventIds.length > 0) {
    const localEvents = await db.events.bulkGet(targetEventIds);
    for (const item of localEvents) {
      if (item) localEventsById.set(item.id, item);
    }
  }
  const remoteEventsToApply = targetEvents.filter(item => {
    const local = localEventsById.get(item.id);
    return !(local && local.syncStatus !== 'synced');
  });

  const remoteTripIds = [...new Set(prunedHeaders.map(item => item.trip_id))];
  const localTripEvents = remoteTripIds.length > 0
    ? await db.events.where('tripId').anyOf(remoteTripIds).toArray()
    : [];
  const localHasStart = new Set(localTripEvents.filter(item => item.type === 'trip_start').map(item => item.tripId));
  const localHasEnd = new Set(localTripEvents.filter(item => item.type === 'trip_end').map(item => item.tripId));

  const headerBoundaryEvents = [];
  for (const header of prunedHeaders) {
    if (!localHasStart.has(header.trip_id)) {
      headerBoundaryEvents.push(normalizeHeaderStartEvent(header));
    }
    if (header.end_ts && !localHasEnd.has(header.trip_id)) {
      headerBoundaryEvents.push(normalizeHeaderEndEvent(header));
    }
  }

  const mergedEvents = [...remoteEventsToApply, ...headerBoundaryEvents];
  const uniqueEvents = Object.values(
    mergedEvents.reduce<Record<string, AppEvent>>((acc, item) => {
      acc[item.id] = item;
      return acc;
    }, {}),
  );

  await withRemoteSyncSignalsSuppressed(async () => {
    await db.transaction('rw', db.events, db.routePoints, async () => {
      await db.events.bulkPut(uniqueEvents);
      if (targetRoutePoints.length > 0) {
        await db.routePoints.bulkPut(targetRoutePoints);
      }
    });
  });
}

async function getSavedCloudDetailRetentionCutoff(): Promise<string | null> {
  return normalizeIso(await getMeta(META_REMOTE_CLOUD_DETAIL_RETENTION_CUTOFF_AT));
}

async function maybeRunCloudMaintenance(): Promise<string | null> {
  if (!driverSupabase) return getSavedCloudDetailRetentionCutoff();

  const [lastCheckedAt, savedCutoff] = await Promise.all([
    getMeta(META_REMOTE_CLOUD_MAINTENANCE_CHECKED_AT),
    getSavedCloudDetailRetentionCutoff(),
  ]);
  const lastCheckedMs = lastCheckedAt ? Date.parse(lastCheckedAt) : NaN;
  if (Number.isFinite(lastCheckedMs) && Date.now() - lastCheckedMs < CLOUD_MAINTENANCE_INTERVAL_MS) {
    return savedCutoff;
  }

  try {
    const { data, error } = await driverSupabase.rpc('prune_tracklog_cloud_usage');
    await setMeta(META_REMOTE_CLOUD_MAINTENANCE_CHECKED_AT, nowIso());
    if (error) {
      if (!isMissingRpcError(error)) {
        console.warn('[remoteSync] cloud maintenance skipped', error);
      }
      return savedCutoff;
    }

    const result = data as RemoteCloudMaintenanceResult | null;
    const nextCutoff = normalizeIso(result?.detail_retention_cutoff);
    const effectiveCutoff =
      savedCutoff && nextCutoff
        ? (savedCutoff > nextCutoff ? savedCutoff : nextCutoff)
        : nextCutoff ?? savedCutoff;
    if (effectiveCutoff) {
      await setMeta(META_REMOTE_CLOUD_DETAIL_RETENTION_CUTOFF_AT, effectiveCutoff);
    }
    return effectiveCutoff;
  } catch (error) {
    console.warn('[remoteSync] cloud maintenance failed', error);
    await setMeta(META_REMOTE_CLOUD_MAINTENANCE_CHECKED_AT, nowIso());
    return savedCutoff;
  }
}

function getCloudDetailPrunedTripIds(
  tripHeaders: Array<{ trip_id: string; end_ts?: string | null; status: string }>,
  cutoffIso: string | null,
) {
  if (!cutoffIso) return new Set<string>();
  const cutoffMs = Date.parse(cutoffIso);
  if (!Number.isFinite(cutoffMs)) return new Set<string>();
  return new Set(
    tripHeaders
      .filter(trip => trip.status === 'closed' && !!trip.end_ts && Date.parse(trip.end_ts) < cutoffMs)
      .map(trip => trip.trip_id),
  );
}

function getLatestPoint(routePoint: RoutePoint | null, events: AppEvent[]) {
  const event = [...events]
    .filter(item => !!item.geo)
    .sort((a, b) => b.ts.localeCompare(a.ts))[0];
  if (routePoint && (!event?.geo || routePoint.ts >= event.ts)) {
    return {
      lat: routePoint.lat,
      lng: routePoint.lng,
      accuracy: routePoint.accuracy ?? null,
    };
  }
  if (!event?.geo) return null;
  return {
    lat: event.geo.lat,
    lng: event.geo.lng,
    accuracy: event.geo.accuracy ?? null,
  };
}

function hasOpenSession(events: AppEvent[], startType: string, endType: string, key: string) {
  const starts = events.filter(e => e.type === startType).sort((a, b) => a.ts.localeCompare(b.ts));
  const ends = events.filter(e => e.type === endType);
  for (let i = starts.length - 1; i >= 0; i--) {
    const sessionId = (starts[i] as any).extras?.[key] as string | undefined;
    if (!sessionId) continue;
    const closed = ends.some(item => (item as any).extras?.[key] === sessionId);
    if (!closed) return true;
  }
  return false;
}

function inferLatestStatus(events: AppEvent[]) {
  if (hasOpenSession(events, 'boarding', 'disembark', 'ferrySessionId')) return 'フェリー中';
  if (hasOpenSession(events, 'rest_start', 'rest_end', 'restSessionId')) return '休息中';
  if (hasOpenSession(events, 'break_start', 'break_end', 'breakSessionId')) return '休憩中';
  if (hasOpenSession(events, 'load_start', 'load_end', 'loadSessionId')) return '積込中';
  if (hasOpenSession(events, 'unload_start', 'unload_end', 'unloadSessionId')) return '荷卸中';
  const end = events.find(item => item.type === 'trip_end');
  if (end) return '運行終了';
  return events.length > 0 ? '運転中' : '待機中';
}

function normalizeTripEvent(deviceId: string, event: AppEvent): RemoteTripEvent {
  return {
    id: event.id,
    trip_id: event.tripId,
    device_id: deviceId,
    type: event.type,
    ts: event.ts,
    address: event.address ?? null,
    geo: event.geo ? { ...event.geo } : null,
    extras: event.extras ? { ...event.extras } : null,
    sync_status: event.syncStatus,
    updated_at: nowIso(),
  };
}

function normalizeRoutePoint(deviceId: string, point: RoutePoint): RemoteRoutePoint {
  return {
    id: point.id,
    trip_id: point.tripId,
    device_id: deviceId,
    ts: point.ts,
    lat: point.lat,
    lng: point.lng,
    accuracy: point.accuracy ?? null,
    speed: point.speed ?? null,
    heading: point.heading ?? null,
    source: point.source ?? null,
    updated_at: nowIso(),
  };
}

type EventUploadSnapshot = {
  id: string;
  fingerprint: string;
};

function normalizeEventFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeEventFingerprintValue);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        const next = normalizeEventFingerprintValue((value as Record<string, unknown>)[key]);
        if (next !== undefined) acc[key] = next;
        return acc;
      }, {});
  }
  return value;
}

function eventUploadFingerprint(event: AppEvent): string {
  return JSON.stringify({
    id: event.id,
    tripId: event.tripId,
    type: event.type,
    ts: event.ts,
    address: event.address ?? null,
    geo: event.geo
      ? {
          lat: event.geo.lat,
          lng: event.geo.lng,
          accuracy: event.geo.accuracy ?? null,
        }
      : null,
    extras: event.extras ? normalizeEventFingerprintValue(event.extras) : null,
  });
}

function buildEventUploadSnapshot(event: AppEvent): EventUploadSnapshot {
  return {
    id: event.id,
    fingerprint: eventUploadFingerprint(event),
  };
}

async function markUploadedEventsSynced(snapshots: EventUploadSnapshot[]) {
  if (snapshots.length === 0) return;
  const snapshotById = new Map<string, string>();
  for (const item of snapshots) {
    if (item.id && !snapshotById.has(item.id)) {
      snapshotById.set(item.id, item.fingerprint);
    }
  }

  await db.transaction('rw', db.events, async () => {
    for (const [id, fingerprint] of snapshotById) {
      const current = await db.events.get(id);
      if (current && eventUploadFingerprint(current) === fingerprint) {
        await db.events.update(id, { syncStatus: 'synced' });
      }
    }
  });
}

async function claimDeviceProfile(identity: DriverIdentity) {
  const [routePoint, activeTripId] = await Promise.all([getLatestRoutePoint(), getActiveTripId()]);
  const activeTripEvents = activeTripId ? await getEventsByTripId(activeTripId) : [];
  const latest = getLatestPoint(routePoint, activeTripEvents);
  return claimTracklogDeviceProfile({
    deviceId: identity.deviceId as string,
    displayName: identity.displayName || `端末-${(identity.deviceId as string).slice(0, 8)}`,
    vehicleLabel: identity.vehicleLabel || null,
    latestStatus: inferLatestStatus(activeTripEvents),
    latestTripId: activeTripId,
    latestLat: latest?.lat ?? null,
    latestLng: latest?.lng ?? null,
    latestAccuracy: latest?.accuracy ?? null,
  });
}

export async function hydrateRemoteSyncState(): Promise<RemoteSyncState> {
  const [identity, lastSyncAt] = await Promise.all([
    getDriverIdentity(),
    getRemoteLastSyncAt(),
  ]);
  emit({
    configured: SUPABASE_CONFIGURED,
    enabled: true,
    lastSyncAt,
    deviceId: identity.deviceId,
    displayName: identity.displayName,
    vehicleLabel: identity.vehicleLabel,
    authInitialized: identity.authInitialized,
    profileComplete: identity.profileComplete,
    approvalStatus: identity.approvalStatus,
  });
  return state;
}

export function getRemoteSyncState() {
  return state;
}

export function subscribeRemoteSyncState(listener: Listener) {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
}

export async function runRemoteSync(reason = 'manual'): Promise<RemoteSyncState> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    await hydrateRemoteSyncState();
    if (!SUPABASE_CONFIGURED || !driverSupabase) {
      return state;
    }
    emit({ syncing: true, lastError: null });
    try {
      const identity = await initializeDriverIdentity();
      if (!identity.authInitialized) {
        emit({
          syncing: false,
          authInitialized: false,
          profileComplete: identity.profileComplete,
          approvalStatus: identity.approvalStatus,
          deviceId: identity.deviceId,
          displayName: identity.displayName,
          vehicleLabel: identity.vehicleLabel,
        });
        return state;
      }
      if (!identity.profileComplete || identity.approvalStatus !== 'approved') {
        emit({
          syncing: false,
          lastError: null,
          deviceId: identity.deviceId,
          displayName: identity.displayName,
          vehicleLabel: identity.vehicleLabel,
          authInitialized: identity.authInitialized,
          profileComplete: identity.profileComplete,
          approvalStatus: identity.approvalStatus,
        });
        return state;
      }
      emit({
        deviceId: identity.deviceId,
        displayName: identity.displayName,
        vehicleLabel: identity.vehicleLabel,
        authInitialized: identity.authInitialized,
        profileComplete: identity.profileComplete,
        approvalStatus: identity.approvalStatus,
      });

      const cloudDetailRetentionCutoff = await maybeRunCloudMaintenance();
      const deletedTripIds = await fetchUserDeletedTripIds();
      const routePointSyncStartedAt = nowIso();
      const routePointsUploadedThrough = await getRemoteRoutePointsUploadedThrough();
      const deviceId = identity.deviceId as string;
      const localDeletedEventIds = await uploadDeletedEventTombstones(deviceId);
      const remoteDeletedEventIds = await fetchUserDeletedEventIds();
      const deletedEventIds = new Set([...localDeletedEventIds, ...remoteDeletedEventIds]);
      const [events, routePoints, reportTrips, tripHeaders] = await Promise.all([
        getAllEvents(),
        listRoutePointsChangedSince(routePointsUploadedThrough),
        listReportTrips(),
        listTrips(),
      ]);
      await removeLocalDeletedTrips(deletedTripIds);
      await removeLocalDeletedEvents(deletedEventIds);
      const visibleEvents = events.filter(item => !deletedTripIds.has(item.tripId) && !deletedEventIds.has(item.id));
      const deletedEventAnchorIds = new Set([...deletedEventIds].map(id => `${EVENT_ROUTE_POINT_ANCHOR_PREFIX}${id}`));
      const visibleRoutePoints = routePoints.filter(item => !deletedTripIds.has(item.tripId));
      const uploadableVisibleRoutePoints = visibleRoutePoints.filter(item => !deletedEventAnchorIds.has(item.id));
      const visibleReportTrips = reportTrips.filter(item => !deletedTripIds.has(item.id));
      const visibleTripHeaders = tripHeaders.filter(item => !deletedTripIds.has(item.tripId));
      const cloudPrunedTripIds = getCloudDetailPrunedTripIds(
        visibleTripHeaders.map(item => ({
          trip_id: item.tripId,
          end_ts: item.endTs ?? null,
          status: item.status === 'closed' ? 'closed' : 'active',
        })),
        cloudDetailRetentionCutoff,
      );
      const uploadableEvents = visibleEvents.filter(item => !cloudPrunedTripIds.has(item.tripId));
      const uploadableRoutePoints = uploadableVisibleRoutePoints.filter(item => !cloudPrunedTripIds.has(item.tripId));
      const uploadableTripIds = new Set(visibleTripHeaders.map(item => item.tripId));
      const uploadableReports = visibleReportTrips.filter(item => uploadableTripIds.has(item.id) && !cloudPrunedTripIds.has(item.id));

      await claimDeviceProfile(identity);
      const normalizedTrips: RemoteTripHeader[] = uniqueByKey(visibleTripHeaders, item => item.tripId).map(item => ({
        trip_id: item.tripId,
        device_id: deviceId,
        start_ts: item.startTs,
        end_ts: item.endTs ?? null,
        odo_start: item.odoStart,
        odo_end: item.odoEnd ?? null,
        total_km: item.totalKm ?? null,
        last_leg_km: item.lastLegKm ?? null,
        status: item.status,
        updated_at: nowIso(),
      }));
      const uniqueUploadableEvents = uniqueByKey(uploadableEvents, item => item.id);
      const uploadedEventSnapshots = uniqueUploadableEvents.map(buildEventUploadSnapshot);
      const normalizedEvents = uniqueUploadableEvents.map(item => normalizeTripEvent(deviceId, item));
      const normalizedRoutePoints = uniqueByKey(uploadableRoutePoints, item => item.id).map(item => normalizeRoutePoint(deviceId, item));
      const normalizedReports: RemoteReportSnapshot[] = uniqueByKey(uploadableReports, item => item.id).map(item => ({
        trip_id: item.id,
        device_id: deviceId,
        created_at: item.createdAt,
        label: item.label,
        payload_json: JSON.parse(JSON.stringify(item)),
        updated_at: nowIso(),
      }));

      if (normalizedTrips.length > 0) {
        const { error } = await driverSupabase.from('trip_headers').upsert(normalizedTrips, {
          onConflict: 'trip_id',
        });
        if (error) throw error;
      }

      if (normalizedEvents.length > 0) {
        const { error } = await driverSupabase.from('trip_events').upsert(normalizedEvents, {
          onConflict: 'id',
        });
        if (error) throw error;
      }

      if (normalizedRoutePoints.length > 0) {
        const { error } = await driverSupabase.from('trip_route_points').upsert(normalizedRoutePoints, {
          onConflict: 'id',
        });
        if (error) throw error;
      }

      if (normalizedReports.length > 0) {
        const { error } = await driverSupabase.from('report_snapshots').upsert(normalizedReports, {
          onConflict: 'trip_id',
        });
        if (error) throw error;
      }

      const [remoteHeaders, remoteEvents, remoteRoutePoints] = await Promise.all([
        fetchUserCloudTripHeaders(),
        fetchTableByDeviceIds<RemoteTripEvent>('trip_events'),
        fetchTableByDeviceIds<RemoteRoutePoint>('trip_route_points'),
      ]);

      await applyRemoteDownload({
        headers: remoteHeaders,
        events: remoteEvents,
        routePoints: remoteRoutePoints,
        cloudCutoff: cloudDetailRetentionCutoff,
        deletedTripIds,
        deletedEventIds,
      });

      await withRemoteSyncSignalsSuppressed(async () => {
        await markUploadedEventsSynced(uploadedEventSnapshots);
        if (!routePointsUploadedThrough || routePoints.length > 0) {
          const uploadedThrough = routePoints.reduce((latest, point) => {
            const updatedAt = point.updatedAt ?? point.ts;
            return updatedAt > latest ? updatedAt : latest;
          }, routePointSyncStartedAt);
          await setRemoteRoutePointsUploadedThrough(uploadedThrough);
        }
      });
      const syncedAt = nowIso();
      await setRemoteLastSyncAt(syncedAt);
      emit({
        syncing: false,
        lastError: null,
        lastSyncAt: syncedAt,
      });
      return state;
    } catch (error: any) {
      emit({
        syncing: false,
        lastError: error?.message ?? `${reason} sync failed`,
      });
      return state;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

let immediateTimer: number | null = null;

export function installImmediateRemoteSyncListener() {
  return subscribeRemoteSyncRequests((reason: string) => {
    if (immediateTimer != null) {
      window.clearTimeout(immediateTimer);
    }
    immediateTimer = window.setTimeout(() => {
      immediateTimer = null;
      void runRemoteSync(reason);
    }, 1200);
  });
}
