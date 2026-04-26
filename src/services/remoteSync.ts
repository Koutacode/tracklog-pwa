import { db } from '../db/db';
import {
  getActiveTripId,
  getAllEvents,
  getEventsByTripId,
  getLatestRoutePoint,
  getRemoteRoutePointsUploadedThrough,
  listRoutePointsChangedSince,
  listTrips,
  setRemoteRoutePointsUploadedThrough,
} from '../db/repositories';
import { listReportTrips } from '../db/reportRepository';
import type { AppEvent, RoutePoint } from '../domain/types';
import type {
  DriverIdentity,
  RemoteCloudMaintenanceResult,
  RemoteReportSnapshot,
  RemoteRoutePoint,
  RemoteSyncState,
  RemoteTripEvent,
  RemoteTripHeader,
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
};

let inFlight: Promise<RemoteSyncState> | null = null;

const META_REMOTE_CLOUD_MAINTENANCE_CHECKED_AT = 'remoteCloudMaintenanceCheckedAt';
const META_REMOTE_CLOUD_DETAIL_RETENTION_CUTOFF_AT = 'remoteCloudDetailRetentionCutoffAt';
const CLOUD_MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;

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

function normalizeIso(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
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
  tripHeaders: Array<{ tripId: string; endTs?: string; status: string }>,
  cutoffIso: string | null,
) {
  if (!cutoffIso) return new Set<string>();
  const cutoffMs = Date.parse(cutoffIso);
  if (!Number.isFinite(cutoffMs)) return new Set<string>();
  return new Set(
    tripHeaders
      .filter(trip => trip.status === 'closed' && !!trip.endTs && Date.parse(trip.endTs) < cutoffMs)
      .map(trip => trip.tripId),
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

async function markAllEventsSynced() {
  await db.events.toCollection().modify(item => {
    item.syncStatus = 'synced';
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
      emit({
        deviceId: identity.deviceId,
        displayName: identity.displayName,
        vehicleLabel: identity.vehicleLabel,
        authInitialized: identity.authInitialized,
        profileComplete: identity.profileComplete,
      });

      const cloudDetailRetentionCutoff = await maybeRunCloudMaintenance();
      const routePointSyncStartedAt = nowIso();
      const routePointsUploadedThrough = await getRemoteRoutePointsUploadedThrough();
      const [events, routePoints, reportTrips, tripHeaders] = await Promise.all([
        getAllEvents(),
        listRoutePointsChangedSince(routePointsUploadedThrough),
        listReportTrips(),
        listTrips(),
      ]);
      const deviceId = identity.deviceId as string;
      const cloudPrunedTripIds = getCloudDetailPrunedTripIds(tripHeaders, cloudDetailRetentionCutoff);
      const uploadableEvents = events.filter(item => !cloudPrunedTripIds.has(item.tripId));
      const uploadableRoutePoints = routePoints.filter(item => !cloudPrunedTripIds.has(item.tripId));
      const uploadableReports = reportTrips.filter(item => !cloudPrunedTripIds.has(item.id));

      await claimDeviceProfile(identity);
      const normalizedTrips: RemoteTripHeader[] = tripHeaders.map(item => ({
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
      const normalizedEvents = uploadableEvents.map(item => normalizeTripEvent(deviceId, item));
      const normalizedRoutePoints = uploadableRoutePoints.map(item => normalizeRoutePoint(deviceId, item));
      const normalizedReports: RemoteReportSnapshot[] = uploadableReports.map(item => ({
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

      await withRemoteSyncSignalsSuppressed(async () => {
        await markAllEventsSynced();
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
