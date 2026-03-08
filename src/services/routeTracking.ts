import { Capacitor, registerPlugin } from '@capacitor/core';
import type { BackgroundGeolocationPlugin } from '@capacitor-community/background-geolocation';
import { addRoutePoint, pruneRoutePointsForRetention } from '../db/repositories';
import type { RouteTrackingMode } from '../db/repositories';

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

let bgWatcherId: string | null = null;
let webWatchId: number | null = null;
let activeTripId: string | null = null;
let lastPoint: { lat: number; lng: number; at: number } | null = null;
let currentMode: RouteTrackingMode = 'precision';
let recordQueue: Promise<void> = Promise.resolve();
let pendingRecordCount = 0;
let droppedRecordCount = 0;
let lastDropWarningAt = 0;
let routePointRetentionRunAt = 0;
let smoothedSpeedKmh: number | null = null;

const MAX_PENDING_RECORDS = 120;
const MAX_STALE_POINT_AGE_MS = 90 * 1000;
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

let modeConfig = MODE_CONFIG.precision;

type LocationPayload = {
  lat: number;
  lng: number;
  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
  time?: number | null;
  source: 'foreground' | 'background';
};

function applyMode(mode: RouteTrackingMode) {
  const config = MODE_CONFIG[mode] ?? MODE_CONFIG.precision;
  currentMode = mode;
  modeConfig = config;
  return config;
}

function resetTrackingRuntime() {
  lastPoint = null;
  smoothedSpeedKmh = null;
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

function smoothSpeedEstimate(nextSpeedKmh: number | null, accuracyM: number | null): number | null {
  if (nextSpeedKmh == null) {
    smoothedSpeedKmh = null;
    return null;
  }
  if (smoothedSpeedKmh == null) {
    smoothedSpeedKmh = nextSpeedKmh;
    return nextSpeedKmh;
  }
  let alpha = 0.34;
  if (accuracyM != null) {
    if (accuracyM <= 10) alpha = 0.46;
    else if (accuracyM >= 35) alpha = 0.22;
  }
  smoothedSpeedKmh = smoothedSpeedKmh + alpha * (nextSpeedKmh - smoothedSpeedKmh);
  return smoothedSpeedKmh;
}

async function recordLocation(params: LocationPayload) {
  if (!activeTripId) return;
  const now = typeof params.time === 'number' ? params.time : Date.now();
  if (Date.now() - now > MAX_STALE_POINT_AGE_MS) {
    return;
  }
  const accuracy = typeof params.accuracy === 'number' && Number.isFinite(params.accuracy) ? params.accuracy : null;
  if (accuracy != null && accuracy > modeConfig.maxAccuracyM) {
    return;
  }

  let inferredSpeedKmh: number | null = null;
  const sensorSpeedKmh = speedMsToKmh(params.speed);
  if (lastPoint) {
    const dt = now - lastPoint.at;
    const dist = distanceMeters(lastPoint, { lat: params.lat, lng: params.lng });
    if (dt > 0) {
      inferredSpeedKmh = dist / (dt / 3600000);
    }
    const speedKmh = fuseSpeedKmh(sensorSpeedKmh, inferredSpeedKmh, accuracy);
    if (
      speedKmh != null &&
      dist >= modeConfig.maxJumpDistanceM &&
      speedKmh > modeConfig.maxJumpSpeedKmh
    ) {
      return;
    }
    if (dt < modeConfig.minTimeMs && dist < modeConfig.minDistanceM) return;
  }

  const fusedSpeedKmh = smoothSpeedEstimate(
    fuseSpeedKmh(sensorSpeedKmh, inferredSpeedKmh, accuracy),
    accuracy,
  );
  const fusedSpeedMs = speedKmhToMs(fusedSpeedKmh);

  lastPoint = { lat: params.lat, lng: params.lng, at: now };
  await addRoutePoint({
    tripId: activeTripId,
    ts: toIso(params.time ?? undefined),
    lat: params.lat,
    lng: params.lng,
    accuracy: params.accuracy ?? undefined,
    speed: fusedSpeedMs ?? params.speed ?? null,
    heading: params.heading ?? null,
    source: params.source,
  });
}

function enqueueRecordLocation(params: LocationPayload): Promise<void> {
  if (pendingRecordCount >= MAX_PENDING_RECORDS) {
    droppedRecordCount += 1;
    const now = Date.now();
    if (now - lastDropWarningAt >= DROP_WARNING_INTERVAL_MS) {
      console.warn(
        `[routeTracking] queue saturated. Dropped ${droppedRecordCount} point(s) in the last minute.`,
      );
      lastDropWarningAt = now;
      droppedRecordCount = 0;
    }
    return recordQueue;
  }
  pendingRecordCount += 1;
  recordQueue = recordQueue
    .then(() => recordLocation(params))
    .catch(() => {
      // keep the queue healthy for subsequent points
    })
    .finally(() => {
      pendingRecordCount = Math.max(0, pendingRecordCount - 1);
    });
  return recordQueue;
}

export async function startRouteTracking(tripId: string, mode: RouteTrackingMode = 'precision') {
  const shouldRestart = (bgWatcherId || webWatchId != null) && (currentMode !== mode || activeTripId !== tripId);
  if (shouldRestart) {
    await stopRouteTracking();
  }
  if ((bgWatcherId || webWatchId != null) && currentMode === mode && activeTripId === tripId) {
    return;
  }
  const config = applyMode(mode);
  activeTripId = tripId;
  resetTrackingRuntime();
  recordQueue = Promise.resolve();
  pendingRecordCount = 0;
  droppedRecordCount = 0;
  lastDropWarningAt = 0;
  maybeRunRoutePointRetention();

  if (Capacitor.isNativePlatform()) {
    if (bgWatcherId) return;
    bgWatcherId = await BackgroundGeolocation.addWatcher(
      {
        requestPermissions: true,
        stale: config.stale,
        distanceFilter: config.distanceFilter,
        backgroundTitle: 'TrackLog運行アシスト',
        backgroundMessage: `ルートを記録中（${config.label}）。停止はアプリから行ってください。`,
      },
      async (location, error) => {
        if (error) {
          return;
        }
        if (!location) return;
        await enqueueRecordLocation({
          lat: location.latitude,
          lng: location.longitude,
          accuracy: location.accuracy ?? null,
          speed: location.speed ?? null,
          heading: location.bearing ?? null,
          time: location.time ?? null,
          source: 'background',
        });
      },
    );
    return;
  }

  if (webWatchId != null) return;
  if (!navigator.geolocation) throw new Error('位置情報が利用できません');
  webWatchId = navigator.geolocation.watchPosition(
    async pos => {
      await enqueueRecordLocation({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        speed: pos.coords.speed ?? null,
        heading: pos.coords.heading ?? null,
        time: pos.timestamp ?? Date.now(),
        source: 'foreground',
      });
    },
    () => {
      // ignore
    },
    config.webOptions,
  );
}

export async function stopRouteTracking() {
  activeTripId = null;
  resetTrackingRuntime();
  recordQueue = Promise.resolve();
  pendingRecordCount = 0;
  droppedRecordCount = 0;
  lastDropWarningAt = 0;
  if (bgWatcherId) {
    const id = bgWatcherId;
    bgWatcherId = null;
    await BackgroundGeolocation.removeWatcher({ id });
  }
  if (webWatchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(webWatchId);
    webWatchId = null;
  }
}

export function isRouteTrackingRunning() {
  return !!bgWatcherId || webWatchId != null;
}

export async function openNativeSettings() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await BackgroundGeolocation.openSettings();
  } catch {
    // ignore
  }
}
