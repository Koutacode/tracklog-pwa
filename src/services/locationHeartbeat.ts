import { getActiveTripId, getEventsByTripId } from '../db/repositories';
import type { AppEvent, EventType } from '../domain/types';
import { getDriverIdentity } from './remoteAuth';
import { subscribeLocationUpdates } from './routeTracking';
import type { LocationPayload } from './routeTracking';
import { updateTracklogDeviceLocationViaFunction } from './tracklogPrivilegedApi';

const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const FORCE_HEARTBEAT_INTERVAL_MS = 5 * 1000;
const MAX_LOCATION_AGE_MS = 5 * 60 * 1000;

let unsubscribeLocation: (() => void) | null = null;
let lastSentAt = 0;
let inFlight: Promise<void> | null = null;
let pendingLocation: LocationPayload | null = null;

const SESSION_KEYS_BY_TYPE: Partial<Record<EventType, string>> = {
  rest_start: 'restSessionId',
  break_start: 'breakSessionId',
  load_start: 'loadSessionId',
  unload_start: 'unloadSessionId',
  boarding: 'ferrySessionId',
};

const END_TYPE_BY_START: Partial<Record<EventType, EventType>> = {
  rest_start: 'rest_end',
  break_start: 'break_end',
  load_start: 'load_end',
  unload_start: 'unload_end',
  boarding: 'disembark',
};

const STATUS_BY_START: Partial<Record<EventType, string>> = {
  rest_start: '休息中',
  break_start: '休憩中',
  load_start: '積込中',
  unload_start: '荷卸中',
  boarding: 'フェリー中',
};

function nowIso() {
  return new Date().toISOString();
}

function locationTimeMs(location: LocationPayload) {
  return typeof location.time === 'number' && Number.isFinite(location.time) ? location.time : Date.now();
}

function isFreshLocation(location: LocationPayload) {
  return Date.now() - locationTimeMs(location) <= MAX_LOCATION_AGE_MS;
}

function hasOpenSession(events: AppEvent[], startType: EventType) {
  const endType = END_TYPE_BY_START[startType];
  const key = SESSION_KEYS_BY_TYPE[startType];
  if (!endType || !key) return false;

  const starts = events.filter(e => e.type === startType).sort((a, b) => a.ts.localeCompare(b.ts));
  const ends = events.filter(e => e.type === endType);
  for (let i = starts.length - 1; i >= 0; i--) {
    const sessionId = (starts[i] as any).extras?.[key] as string | undefined;
    if (!sessionId) continue;
    if (!ends.some(item => (item as any).extras?.[key] === sessionId)) return true;
  }
  return false;
}

function inferLatestStatus(events: AppEvent[]) {
  for (const startType of Object.keys(STATUS_BY_START) as EventType[]) {
    if (hasOpenSession(events, startType)) return STATUS_BY_START[startType] ?? '運転中';
  }
  return events.length > 0 ? '運転中' : '待機中';
}

async function getOperationSnapshot() {
  const activeTripId = await getActiveTripId();
  const activeTripEvents = activeTripId ? await getEventsByTripId(activeTripId) : [];
  return {
    latestTripId: activeTripId,
    latestStatus: activeTripId ? inferLatestStatus(activeTripEvents) : '待機中',
  };
}

async function sendLocation(location: LocationPayload) {
  const identity = await getDriverIdentity();
  if (!identity.configured || !identity.authInitialized || !identity.profileComplete) return;
  if (identity.approvalStatus !== 'approved' || !identity.deviceId) return;

  const operation = await getOperationSnapshot();
  const sentAt = nowIso();
  await updateTracklogDeviceLocationViaFunction({
    deviceId: identity.deviceId,
    latestStatus: operation.latestStatus,
    latestTripId: operation.latestTripId,
    latestLat: location.lat,
    latestLng: location.lng,
    latestAccuracy: typeof location.accuracy === 'number' && Number.isFinite(location.accuracy)
      ? location.accuracy
      : null,
    latestLocationAt: new Date(locationTimeMs(location)).toISOString(),
    lastSeenAt: sentAt,
  });
  lastSentAt = Date.now();
}

function drainPending() {
  if (!pendingLocation || inFlight) return;
  const next = pendingLocation;
  pendingLocation = null;
  void handleLocationHeartbeat(next);
}

async function handleLocationHeartbeat(location: LocationPayload, force = false) {
  if (!isFreshLocation(location)) return;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  const minInterval = force ? FORCE_HEARTBEAT_INTERVAL_MS : HEARTBEAT_INTERVAL_MS;
  if (Date.now() - lastSentAt < minInterval) {
    if (!force) pendingLocation = location;
    return;
  }
  if (inFlight) {
    pendingLocation = location;
    return;
  }

  inFlight = sendLocation(location)
    .catch(error => {
      console.warn('[locationHeartbeat] update failed', error);
    })
    .finally(() => {
      inFlight = null;
      window.setTimeout(drainPending, HEARTBEAT_INTERVAL_MS);
    });
  await inFlight;
}

export function startLocationHeartbeat() {
  if (unsubscribeLocation) return;
  unsubscribeLocation = subscribeLocationUpdates(location => {
    void handleLocationHeartbeat(location);
  });
}

export function stopLocationHeartbeat() {
  if (unsubscribeLocation) {
    unsubscribeLocation();
    unsubscribeLocation = null;
  }
  pendingLocation = null;
}

export async function requestLocationHeartbeatNow() {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return;
  await new Promise<void>(resolve => {
    navigator.geolocation.getCurrentPosition(
      position => {
        void handleLocationHeartbeat(
          {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
            speed: position.coords.speed ?? null,
            heading: position.coords.heading ?? null,
            time: position.timestamp,
            source: 'foreground',
          },
          true,
        ).finally(resolve);
      },
      () => resolve(),
      {
        enableHighAccuracy: true,
        maximumAge: 30000,
        timeout: 10000,
      },
    );
  });
}
