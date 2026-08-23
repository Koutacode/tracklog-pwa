import { Capacitor } from '@capacitor/core';
import { addRoutePoint, pruneRoutePointsForRetention } from '../db/repositories';
import type { RouteTrackingMode } from '../db/repositories';
import { inferSpeedKmh } from '../domain/routePointTelemetry';
import { BackgroundGeolocation } from './backgroundGeolocationPlugin';

let bgWatcherId: string | null = null;
let webWatchId: number | null = null;
let activeTripId: string | null = null;
let residentEnabled = false;
let activeRouteMode: RouteTrackingMode = 'precision';
let residentMode: RouteTrackingMode = 'battery';
let watcherMode: RouteTrackingMode | null = null;
let watcherPurpose: 'route' | 'resident' | null = null;
let watcherNotificationText: string | null = null;
let watcherRouteGeneration: number | null = null;
let watcherGeneration = 0;
let locationNotificationText = '位置記録中';
let routePointRetentionRunAt = 0;
let routeGeneration = 0;
let watcherTransitionQueue: Promise<void> = Promise.resolve();

const MAX_PENDING_RECORDS = 120;
export const MAX_STALE_POINT_AGE_MS = 90 * 1000;
// Match the native quality gate. Location providers and the wall clock can
// differ slightly, so accept up to one minute of positive skew, never more.
export const MAX_FUTURE_POINT_SKEW_MS = 60 * 1000;
const DROP_WARNING_INTERVAL_MS = 60 * 1000;

type ModeConfig = {
  minTimeMs: number;
  minDistanceM: number;
  maxAccuracyM: number;
  maxJumpDistanceM: number;
  maxJumpSpeedKmh: number;
  distanceFilter: number;
  stale: boolean;
  webOptions: PositionOptions;
  label: string;
};

const MODE_CONFIG: Record<RouteTrackingMode, ModeConfig> = {
  precision: {
    minTimeMs: 6000,
    minDistanceM: 12,
    maxAccuracyM: 35,
    maxJumpDistanceM: 220,
    maxJumpSpeedKmh: 155,
    distanceFilter: 10,
    stale: false,
    webOptions: { enableHighAccuracy: true, maximumAge: 2000, timeout: 6000 },
    label: '精度重視',
  },
  battery: {
    minTimeMs: 15000,
    minDistanceM: 40,
    maxAccuracyM: 70,
    maxJumpDistanceM: 380,
    maxJumpSpeedKmh: 175,
    distanceFilter: 30,
    stale: false,
    webOptions: { enableHighAccuracy: true, maximumAge: 10000, timeout: 12000 },
    label: 'バッテリー重視',
  },
};

export type LocationPayload = {
  lat: number;
  lng: number;
  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
  time?: number | null;
  source: 'foreground' | 'background';
};

export type RoutePointWriter = (
  point: Parameters<typeof addRoutePoint>[0],
) => Promise<unknown>;

type LocationUpdateListener = (location: LocationPayload) => void | Promise<void>;

const locationListeners = new Set<LocationUpdateListener>();
let lastEmittedLocationAt: number | null = null;

/**
 * A small serial queue whose trip identity is fixed when the queue is created.
 * Closing a queue rejects no callers: already accepted writes drain in order,
 * while late callbacks are ignored instead of being attached to a later trip.
 */
export class RouteRecordQueue<T> {
  private tail: Promise<void> = Promise.resolve();
  private accepting = true;
  private pendingCount = 0;

  constructor(
    readonly tripId: string,
    readonly generation: number,
    private readonly writer: (tripId: string, payload: T) => Promise<void>,
    private readonly maxPending = MAX_PENDING_RECORDS,
    private readonly onDrop?: () => void,
  ) {}

  enqueue(payload: T): Promise<void> {
    if (!this.accepting) return this.tail;
    if (this.pendingCount >= this.maxPending) {
      this.onDrop?.();
      return this.tail;
    }

    this.pendingCount += 1;
    const write = this.tail.then(() => this.writer(this.tripId, payload));
    this.tail = write
      .catch(() => {
        // A failed point must not poison the remaining serial writes.
      })
      .finally(() => {
        this.pendingCount = Math.max(0, this.pendingCount - 1);
      });
    // Return this point's real result to the enqueue caller while the internal
    // tail remains recovered for subsequent writes and stop/drain.
    return write;
  }

  closeAndDrain(): Promise<void> {
    this.accepting = false;
    return this.tail;
  }
}

export type RouteRecordSession = {
  tripId: string;
  generation: number;
  mode: RouteTrackingMode;
  config: ModeConfig;
  queue: RouteRecordQueue<LocationPayload>;
  lastPoint: { lat: number; lng: number; at: number } | null;
  smoothedSpeedKmh: number | null;
  droppedRecordCount: number;
  lastDropWarningAt: number;
  writeRoutePoint: RoutePointWriter;
};

let activeRecordSession: RouteRecordSession | null = null;

function applyMode(mode: RouteTrackingMode) {
  const config = MODE_CONFIG[mode] ?? MODE_CONFIG.precision;
  return config;
}

function emitLocationUpdate(location: LocationPayload) {
  for (const listener of locationListeners) {
    Promise.resolve(listener(location)).catch(() => {
      // keep the location stream independent from heartbeat failures
    });
  }
}

function maybeRunRoutePointRetention() {
  const now = Date.now();
  if (now - routePointRetentionRunAt < 6 * 60 * 60 * 1000) return;
  routePointRetentionRunAt = now;
  void pruneRoutePointsForRetention().catch(() => {
    // keep tracking unaffected on cleanup failures
  });
}

function toIso(tsMs?: number | null): string {
  const t = typeof tsMs === 'number' && Number.isFinite(tsMs) ? tsMs : Date.now();
  return new Date(t).toISOString();
}

function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const r = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sin1 = Math.sin(dLat / 2);
  const sin2 = Math.sin(dLng / 2);
  const h = sin1 * sin1 + Math.cos(lat1) * Math.cos(lat2) * sin2 * sin2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

function speedMsToKmh(speedMs?: number | null): number | null {
  if (typeof speedMs !== 'number' || !Number.isFinite(speedMs) || speedMs < 0) return null;
  return speedMs * 3.6;
}

function speedKmhToMs(speedKmh?: number | null): number | null {
  if (typeof speedKmh !== 'number' || !Number.isFinite(speedKmh) || speedKmh < 0) return null;
  return speedKmh / 3.6;
}

export function resolveRoutePointTimestamp(
  candidateTime: number | null | undefined,
  nowMs: number,
  lastAcceptedAt: number | null,
): number | null {
  if (!Number.isFinite(nowMs) || nowMs <= 0) return null;
  const timestamp = candidateTime == null ? nowMs : candidateTime;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  if (nowMs - timestamp > MAX_STALE_POINT_AGE_MS) return null;
  if (timestamp - nowMs > MAX_FUTURE_POINT_SKEW_MS) return null;
  if (lastAcceptedAt != null && timestamp <= lastAcceptedAt) return null;
  return timestamp;
}

type RawLocationUpdate = {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  speed?: number | null;
  bearing?: number | null;
  time?: number | null;
};

export function resolveLocationUpdatePayload(
  location: RawLocationUpdate,
  source: LocationPayload['source'],
  nowMs: number,
  lastAcceptedAt: number | null,
): { payload: LocationPayload; acceptedAt: number } | null {
  if (
    !Number.isFinite(location.latitude)
    || location.latitude < -90
    || location.latitude > 90
    || !Number.isFinite(location.longitude)
    || location.longitude < -180
    || location.longitude > 180
  ) {
    return null;
  }
  const acceptedAt = resolveRoutePointTimestamp(location.time, nowMs, lastAcceptedAt);
  if (acceptedAt == null) return null;
  return {
    acceptedAt,
    payload: {
      lat: location.latitude,
      lng: location.longitude,
      accuracy: location.accuracy ?? null,
      speed: location.speed ?? null,
      heading: location.bearing ?? null,
      time: acceptedAt,
      source,
    },
  };
}

function fuseSpeedKmh(
  sensorSpeedKmh: number | null,
  inferredSpeedKmh: number | null,
  accuracyM: number | null,
): number | null {
  if (sensorSpeedKmh == null && inferredSpeedKmh == null) return null;
  if (sensorSpeedKmh == null) return inferredSpeedKmh;
  if (inferredSpeedKmh == null) return sensorSpeedKmh;
  let sensorWeight = 0.62;
  if (accuracyM != null) {
    if (accuracyM <= 12) sensorWeight = 0.76;
    else if (accuracyM >= 40) sensorWeight = 0.4;
  }
  const delta = Math.abs(sensorSpeedKmh - inferredSpeedKmh);
  if (delta >= 24) {
    sensorWeight = Math.min(sensorWeight, 0.35);
  }
  return sensorSpeedKmh * sensorWeight + inferredSpeedKmh * (1 - sensorWeight);
}

function nextSmoothedSpeedEstimate(
  previousSmoothedSpeedKmh: number | null,
  nextSpeedKmh: number | null,
  accuracyM: number | null,
): number | null {
  if (nextSpeedKmh == null) {
    return null;
  }
  if (previousSmoothedSpeedKmh == null) {
    return nextSpeedKmh;
  }
  let alpha = 0.34;
  if (accuracyM != null) {
    if (accuracyM <= 10) alpha = 0.46;
    else if (accuracyM >= 35) alpha = 0.22;
  }
  return previousSmoothedSpeedKmh + alpha * (nextSpeedKmh - previousSmoothedSpeedKmh);
}

async function recordLocation(
  session: RouteRecordSession,
  tripId: string,
  params: LocationPayload,
) {
  const now = resolveRoutePointTimestamp(params.time, Date.now(), session.lastPoint?.at ?? null);
  if (now == null) return;
  const accuracy = typeof params.accuracy === 'number' && Number.isFinite(params.accuracy) ? params.accuracy : null;
  if (accuracy != null && accuracy > session.config.maxAccuracyM) {
    return;
  }

  let inferredSpeedKmh: number | null = null;
  const sensorSpeedKmh = speedMsToKmh(params.speed);
  if (session.lastPoint) {
    const dt = now - session.lastPoint.at;
    const dist = distanceMeters(session.lastPoint, { lat: params.lat, lng: params.lng });
    inferredSpeedKmh = inferSpeedKmh(dist, dt);
    const speedKmh = fuseSpeedKmh(sensorSpeedKmh, inferredSpeedKmh, accuracy);
    if (
      speedKmh != null &&
      dist >= session.config.maxJumpDistanceM &&
      speedKmh > session.config.maxJumpSpeedKmh
    ) {
      return;
    }
    if (dt < session.config.minTimeMs && dist < session.config.minDistanceM) return;
  }

  const fusedSpeedKmh = nextSmoothedSpeedEstimate(
    session.smoothedSpeedKmh,
    fuseSpeedKmh(sensorSpeedKmh, inferredSpeedKmh, accuracy),
    accuracy,
  );
  const fusedSpeedMs = speedKmhToMs(fusedSpeedKmh);

  await session.writeRoutePoint({
    tripId,
    ts: toIso(now),
    lat: params.lat,
    lng: params.lng,
    accuracy: params.accuracy ?? undefined,
    speed: fusedSpeedMs ?? params.speed ?? null,
    heading: params.heading ?? null,
    source: params.source,
  });
  // Filtering state describes durable history only. A failed Dexie write must
  // not suppress or distort the next point that can actually be saved.
  session.lastPoint = { lat: params.lat, lng: params.lng, at: now };
  session.smoothedSpeedKmh = fusedSpeedKmh;
}

function warnDroppedRecord(session: RouteRecordSession) {
  session.droppedRecordCount += 1;
  const now = Date.now();
  if (now - session.lastDropWarningAt >= DROP_WARNING_INTERVAL_MS) {
    console.warn(
      `[routeTracking] queue saturated. Dropped ${session.droppedRecordCount} point(s) in the last minute.`,
    );
    session.lastDropWarningAt = now;
    session.droppedRecordCount = 0;
  }
}

export function createRouteRecordSession(
  tripId: string,
  mode: RouteTrackingMode,
  writeRoutePoint: RoutePointWriter = addRoutePoint,
): RouteRecordSession {
  const session: RouteRecordSession = {
    tripId,
    generation: ++routeGeneration,
    mode,
    config: MODE_CONFIG[mode] ?? MODE_CONFIG.precision,
    queue: null as unknown as RouteRecordQueue<LocationPayload>,
    lastPoint: null,
    smoothedSpeedKmh: null,
    droppedRecordCount: 0,
    lastDropWarningAt: 0,
    writeRoutePoint,
  };
  session.queue = new RouteRecordQueue(
    tripId,
    session.generation,
    (capturedTripId, payload) => recordLocation(session, capturedTripId, payload),
    MAX_PENDING_RECORDS,
    () => warnDroppedRecord(session),
  );
  return session;
}

function enqueueRecordLocation(
  session: RouteRecordSession | null,
  params: LocationPayload,
): Promise<void> {
  if (!session) return Promise.resolve();
  return session.queue.enqueue(params);
}

async function removeLocationWatcher() {
  // Invalidate callbacks before awaiting native/web watcher cleanup.
  watcherGeneration += 1;
  if (bgWatcherId) {
    const id = bgWatcherId;
    bgWatcherId = null;
    try {
      await BackgroundGeolocation.removeWatcher({ id });
    } catch {
      // ignore cleanup errors
    }
  }
  if (webWatchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(webWatchId);
    webWatchId = null;
  }
  watcherMode = null;
  watcherPurpose = null;
  watcherNotificationText = null;
  watcherRouteGeneration = null;
}

function buildBackgroundMessage() {
  return '';
}

function normalizeLocationNotificationText(text?: string | null) {
  const normalized = typeof text === 'string' ? text.trim() : '';
  return normalized || '位置記録中';
}

export function setLocationNotificationText(text?: string | null) {
  locationNotificationText = normalizeLocationNotificationText(text);
}

async function handleLocation(
  location: RawLocationUpdate,
  source: LocationPayload['source'],
  recordSession: RouteRecordSession | null,
) {
  const resolved = resolveLocationUpdatePayload(
    location,
    source,
    Date.now(),
    lastEmittedLocationAt,
  );
  if (!resolved) return;
  const { payload } = resolved;
  lastEmittedLocationAt = resolved.acceptedAt;
  emitLocationUpdate(payload);
  await enqueueRecordLocation(recordSession, payload);
}

async function ensureLocationWatcher(purpose: 'route' | 'resident', mode: RouteTrackingMode) {
  const notificationText = normalizeLocationNotificationText(locationNotificationText);
  const routeSession = purpose === 'route' ? activeRecordSession : null;
  const routeSessionGeneration = routeSession?.generation ?? null;
  if (
    (bgWatcherId || webWatchId != null) &&
    watcherPurpose === purpose &&
    watcherMode === mode &&
    watcherNotificationText === notificationText &&
    watcherRouteGeneration === routeSessionGeneration
  ) {
    return;
  }

  await removeLocationWatcher();
  const config = applyMode(mode);

  if (Capacitor.isNativePlatform()) {
    const callbackGeneration = ++watcherGeneration;
    const nextWatcherId = await BackgroundGeolocation.addWatcher(
      {
        requestPermissions: true,
        stale: purpose === 'resident' ? true : config.stale,
        distanceFilter: purpose === 'resident' ? Math.min(config.distanceFilter, 25) : config.distanceFilter,
        backgroundTitle: notificationText,
        backgroundMessage: buildBackgroundMessage(),
      },
      async (location, error) => {
        if (callbackGeneration !== watcherGeneration) return;
        if (error) {
          console.warn('[routeTracking] native watcher error');
          return;
        }
        if (!location) return;
        try {
          await handleLocation(location, 'background', routeSession);
        } catch {
          console.warn('[routeTracking] route point write failed');
        }
      },
    );
    bgWatcherId = nextWatcherId;
    watcherMode = mode;
    watcherPurpose = purpose;
    watcherNotificationText = notificationText;
    watcherRouteGeneration = routeSessionGeneration;
    return;
  }

  if (!navigator.geolocation) throw new Error('位置情報が利用できません');
  const callbackGeneration = ++watcherGeneration;
  webWatchId = navigator.geolocation.watchPosition(
    async pos => {
      if (callbackGeneration !== watcherGeneration) return;
      try {
        await handleLocation(
          {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            speed: pos.coords.speed ?? null,
            bearing: pos.coords.heading ?? null,
            time: pos.timestamp ?? Date.now(),
          },
          'foreground',
          routeSession,
        );
      } catch {
        console.warn('[routeTracking] route point write failed');
      }
    },
    () => {
      console.warn('[routeTracking] web watcher error');
    },
    purpose === 'resident'
      ? { enableHighAccuracy: true, maximumAge: 30000, timeout: 10000 }
      : config.webOptions,
  );
  watcherMode = mode;
  watcherPurpose = purpose;
  watcherNotificationText = notificationText;
  watcherRouteGeneration = routeSessionGeneration;
}

async function reconcileLocationWatcherNow() {
  if (activeTripId) {
    await ensureLocationWatcher('route', activeRouteMode);
    return;
  }
  if (residentEnabled) {
    await ensureLocationWatcher('resident', residentMode);
    return;
  }
  await removeLocationWatcher();
}

function reconcileLocationWatcher() {
  const transition = watcherTransitionQueue
    .catch(() => {
      // A failed native transition must not poison later start/stop requests.
    })
    .then(() => reconcileLocationWatcherNow());
  watcherTransitionQueue = transition.catch(() => {
    // Preserve a healthy transition chain while returning the real failure to
    // the caller that requested this reconciliation.
  });
  return transition;
}

export async function startRouteTracking(tripId: string, mode: RouteTrackingMode = 'precision') {
  const isAlreadyRunning =
    (bgWatcherId || webWatchId != null) &&
    watcherPurpose === 'route' &&
    watcherMode === mode &&
    activeTripId === tripId &&
    watcherRouteGeneration === activeRecordSession?.generation;
  if (isAlreadyRunning) {
    return;
  }

  const existingSession = activeRecordSession;
  const canReuseSession =
    existingSession?.tripId === tripId && existingSession.mode === mode;
  const previousSession = canReuseSession ? null : existingSession;
  let previousDrain: Promise<void> = Promise.resolve();
  if (previousSession) {
    // Close before publishing the next session. Any late callback holding the
    // old generation is ignored, but writes already accepted still drain to
    // the old tripId captured by its queue.
    previousDrain = previousSession.queue.closeAndDrain();
    watcherGeneration += 1;
    watcherRouteGeneration = null;
  }

  const nextSession = canReuseSession
    ? existingSession
    : createRouteRecordSession(tripId, mode);
  activeRecordSession = nextSession;
  activeTripId = tripId;
  activeRouteMode = mode;
  maybeRunRoutePointRetention();
  await Promise.all([
    reconcileLocationWatcher(),
    previousDrain,
  ]);
}

export async function stopRouteTracking() {
  const session = activeRecordSession;
  const sessionDrain = session?.queue.closeAndDrain() ?? Promise.resolve();
  // End acceptance synchronously, before the first await. A caller may start a
  // new trip without awaiting this promise and the two queues remain isolated.
  activeRecordSession = null;
  activeTripId = null;
  if (watcherPurpose === 'route') {
    watcherGeneration += 1;
    watcherRouteGeneration = null;
  }
  await Promise.all([
    reconcileLocationWatcher(),
    sessionDrain,
  ]);
}

export async function startResidentLocationUpdates(mode: RouteTrackingMode = 'battery') {
  residentEnabled = true;
  residentMode = mode;
  await reconcileLocationWatcher();
}

export async function stopResidentLocationUpdates() {
  residentEnabled = false;
  await reconcileLocationWatcher();
}

export function isRouteTrackingRunning() {
  return activeTripId !== null && (!!bgWatcherId || webWatchId != null);
}

export function isLocationWatcherRunning() {
  return !!bgWatcherId || webWatchId != null;
}

export function subscribeLocationUpdates(listener: LocationUpdateListener) {
  locationListeners.add(listener);
  return () => {
    locationListeners.delete(listener);
  };
}

export async function openNativeSettings() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await BackgroundGeolocation.openSettings();
  } catch {
    // ignore
  }
}
