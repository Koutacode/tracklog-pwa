import { getActiveTripId, getEventsByTripId } from '../db/repositories';
import type { AppEvent } from '../domain/types';
import {
  findOpenToggleStart,
  PERSISTED_BASIC_TOGGLE_DEFINITIONS,
  PERSISTED_TOGGLE_DEFINITIONS,
  resolveTogglePairing,
  type TogglePairDefinition,
} from '../domain/togglePairing';
import { getDriverIdentity } from './remoteAuth';
import { subscribeLocationUpdates } from './routeTracking';
import type { LocationPayload } from './routeTracking';
import { resolveLocationHeartbeatPayload } from './locationHeartbeatPolicy';
import { updateTracklogDeviceLocationViaFunction } from './tracklogPrivilegedApi';

const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const FORCE_HEARTBEAT_INTERVAL_MS = 5 * 1000;

let unsubscribeLocation: (() => void) | null = null;
let lastSentAt = 0;
let inFlight: Promise<void> | null = null;
let pendingLocation: LocationPayload | null = null;
let lastAcceptedLocationAt: number | null = null;

const STATUS_TOGGLE_DEFINITIONS: ReadonlyArray<{
  definition: TogglePairDefinition;
  status: string;
}> = [
  { definition: PERSISTED_BASIC_TOGGLE_DEFINITIONS[4], status: 'フェリー中' },
  { definition: PERSISTED_BASIC_TOGGLE_DEFINITIONS[0], status: '休息中' },
  { definition: PERSISTED_BASIC_TOGGLE_DEFINITIONS[1], status: '休憩中' },
  { definition: PERSISTED_BASIC_TOGGLE_DEFINITIONS[2], status: '積込中' },
  { definition: PERSISTED_BASIC_TOGGLE_DEFINITIONS[3], status: '荷卸中' },
];

function nowIso() {
  return new Date().toISOString();
}

function locationTimeMs(location: LocationPayload) {
  return typeof location.time === 'number' && Number.isFinite(location.time) ? location.time : Date.now();
}

function inferLatestStatus(events: AppEvent[]) {
  const normalEvents = resolveTogglePairing(events, PERSISTED_TOGGLE_DEFINITIONS).normalEvents;
  for (const { definition, status } of STATUS_TOGGLE_DEFINITIONS) {
    if (findOpenToggleStart(normalEvents, definition)) return status;
  }
  return normalEvents.length > 0 ? '運転中' : '待機中';
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
  void sendEligibleLocationHeartbeat(next);
}

async function sendEligibleLocationHeartbeat(location: LocationPayload, force = false) {
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
    .catch(() => {
      console.warn('[locationHeartbeat] update failed');
    })
    .finally(() => {
      inFlight = null;
      window.setTimeout(drainPending, HEARTBEAT_INTERVAL_MS);
    });
  await inFlight;
}

async function handleLocationHeartbeat(location: LocationPayload, force = false) {
  const accepted = resolveLocationHeartbeatPayload(location, Date.now(), lastAcceptedLocationAt);
  if (!accepted) return;
  lastAcceptedLocationAt = accepted.time ?? null;
  await sendEligibleLocationHeartbeat(accepted, force);
}

export function startLocationHeartbeat() {
  if (unsubscribeLocation) return;
  lastAcceptedLocationAt = null;
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
  lastAcceptedLocationAt = null;
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
