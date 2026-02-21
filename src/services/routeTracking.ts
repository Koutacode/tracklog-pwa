import { Capacitor, registerPlugin } from '@capacitor/core';
import type { BackgroundGeolocationPlugin } from '@capacitor-community/background-geolocation';
import {
  addRoutePoint,
  clearPendingExpresswayEndDecision,
  clearPendingExpresswayEndPrompt,
  DEFAULT_AUTO_EXPRESSWAY_CONFIG,
  getAutoExpresswayConfig,
  getEventsByTripId,
  getPendingExpresswayEndDecision,
  setPendingExpresswayEndPrompt,
  startExpressway,
  updateExpresswayResolved,
} from '../db/repositories';
import type { AppEvent } from '../domain/types';
import type { AutoExpresswayConfig, RouteTrackingMode } from '../db/repositories';
import { detectExpresswaySignal } from './icResolver';
import { cancelNativeExpresswayEndPrompt, showNativeExpresswayEndPrompt } from './nativeExpresswayPrompt';

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

let bgWatcherId: string | null = null;
let webWatchId: number | null = null;
let activeTripId: string | null = null;
let lastPoint: { lat: number; lng: number; at: number } | null = null;
let currentMode: RouteTrackingMode = 'precision';

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
let autoExpresswayConfigCache: AutoExpresswayConfig = DEFAULT_AUTO_EXPRESSWAY_CONFIG;
let autoExpresswayConfigLoadedAt = 0;
let expresswayOpenCache: { tripId: string | null; checkedAt: number; isOpen: boolean } = {
  tripId: null,
  checkedAt: 0,
  isOpen: false,
};
const expresswayRuntime = {
  speedAboveSince: null as number | null,
  speedBelowSince: null as number | null,
  speedRecoveredSince: null as number | null,
  lastSpeedMs: null as number | null,
  lastSpeedAt: null as number | null,
  lastStrongAccelAt: null as number | null,
  lastStrongAccelGeo: null as { lat: number; lng: number; at: number } | null,
  lastStrongDecelAt: null as number | null,
  smoothedSpeedKmh: null as number | null,
  lastEndPromptAt: 0,
  lastKeepDecisionCheckAt: 0,
  endPromptOutstanding: false,
  inFlight: false,
  lastActionAt: 0,
};

const AUTO_EXPRESSWAY_ACCEL_PROFILE = {
  startAccelMs2: 0.18,
  startAccelWindowMs: 75 * 1000,
  endDecelMs2: -0.28,
  endDecelWindowMs: 90 * 1000,
  endPromptCooldownMs: 45 * 1000,
  endResetMarginKmh: 8,
  endResetHoldMs: 20 * 1000,
};

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

function resetAutoExpresswayRuntime() {
  expresswayRuntime.speedAboveSince = null;
  expresswayRuntime.speedBelowSince = null;
  expresswayRuntime.speedRecoveredSince = null;
  expresswayRuntime.lastSpeedMs = null;
  expresswayRuntime.lastSpeedAt = null;
  expresswayRuntime.lastStrongAccelAt = null;
  expresswayRuntime.lastStrongAccelGeo = null;
  expresswayRuntime.lastStrongDecelAt = null;
  expresswayRuntime.smoothedSpeedKmh = null;
  expresswayRuntime.lastEndPromptAt = 0;
  expresswayRuntime.lastKeepDecisionCheckAt = 0;
  expresswayRuntime.endPromptOutstanding = false;
  expresswayRuntime.inFlight = false;
  expresswayRuntime.lastActionAt = 0;
  expresswayOpenCache = { tripId: activeTripId, checkedAt: 0, isOpen: false };
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

function smoothSpeedKmh(nextSpeedKmh: number | null, accuracyM: number | null): number | null {
  if (nextSpeedKmh == null) {
    expresswayRuntime.smoothedSpeedKmh = null;
    return null;
  }
  const prev = expresswayRuntime.smoothedSpeedKmh;
  if (prev == null) {
    expresswayRuntime.smoothedSpeedKmh = nextSpeedKmh;
    return nextSpeedKmh;
  }
  let alpha = 0.34;
  if (accuracyM != null) {
    if (accuracyM <= 10) alpha = 0.46;
    else if (accuracyM >= 35) alpha = 0.22;
  }
  const smoothed = prev + alpha * (nextSpeedKmh - prev);
  expresswayRuntime.smoothedSpeedKmh = smoothed;
  return smoothed;
}

function deriveAccelerationMs2(speedMs: number | null, nowMs: number): number | null {
  const prevSpeedMs = expresswayRuntime.lastSpeedMs;
  const prevAt = expresswayRuntime.lastSpeedAt;
  expresswayRuntime.lastSpeedMs = speedMs;
  expresswayRuntime.lastSpeedAt = nowMs;
  if (speedMs == null || prevSpeedMs == null || prevAt == null) return null;
  const dtSec = (nowMs - prevAt) / 1000;
  if (!Number.isFinite(dtSec) || dtSec < 1 || dtSec > 20) return null;
  return (speedMs - prevSpeedMs) / dtSec;
}

function hasOpenExpressway(events: AppEvent[]): boolean {
  const starts = events
    .filter(e => e.type === 'expressway_start')
    .sort((a, b) => a.ts.localeCompare(b.ts));
  if (starts.length === 0) return false;
  const ends = events.filter(e => e.type === 'expressway_end');
  for (let i = starts.length - 1; i >= 0; i--) {
    const sid = (starts[i] as any).extras?.expresswaySessionId as string | undefined;
    if (!sid) continue;
    const hasEnd = ends.some(en => (en as any).extras?.expresswaySessionId === sid);
    if (!hasEnd) return true;
  }
  const lastStart = starts[starts.length - 1];
  return !!lastStart && !ends.some(en => en.ts > lastStart.ts);
}

async function loadAutoExpresswayConfigCached(now: number): Promise<AutoExpresswayConfig> {
  if (now - autoExpresswayConfigLoadedAt < 15000) return autoExpresswayConfigCache;
  autoExpresswayConfigLoadedAt = now;
  try {
    autoExpresswayConfigCache = await getAutoExpresswayConfig();
  } catch {
    // keep previous config
  }
  return autoExpresswayConfigCache;
}

function setExpresswayOpenCache(tripId: string | null, isOpen: boolean, now: number) {
  expresswayOpenCache = { tripId, isOpen, checkedAt: now };
}

async function getExpresswayOpenCached(tripId: string, now: number): Promise<boolean> {
  if (expresswayOpenCache.tripId === tripId && now - expresswayOpenCache.checkedAt < 5000) {
    return expresswayOpenCache.isOpen;
  }
  const events = await getEventsByTripId(tripId);
  const isOpen = hasOpenExpressway(events);
  setExpresswayOpenCache(tripId, isOpen, now);
  return isOpen;
}

async function consumeKeepDecisionIfAny(tripId: string, now: number) {
  if (now - expresswayRuntime.lastKeepDecisionCheckAt < 3000) return;
  expresswayRuntime.lastKeepDecisionCheckAt = now;
  let decision: Awaited<ReturnType<typeof getPendingExpresswayEndDecision>> = null;
  try {
    decision = await getPendingExpresswayEndDecision();
  } catch {
    return;
  }
  if (!decision || decision.tripId !== tripId || decision.action !== 'keep') return;
  const decidedAtMs = Date.parse(decision.decidedAt);
  const actionAt = Number.isFinite(decidedAtMs) ? decidedAtMs : now;
  expresswayRuntime.lastActionAt = Math.max(expresswayRuntime.lastActionAt, actionAt);
  expresswayRuntime.lastEndPromptAt = Math.max(expresswayRuntime.lastEndPromptAt, actionAt);
  expresswayRuntime.speedBelowSince = now;
  expresswayRuntime.speedRecoveredSince = null;
  expresswayRuntime.endPromptOutstanding = false;
  await clearPendingExpresswayEndPrompt(tripId);
  await clearPendingExpresswayEndDecision(tripId);
  await cancelNativeExpresswayEndPrompt(tripId);
}

function pickBestEntryIcCandidate(
  candidates: Array<{ signal: Awaited<ReturnType<typeof detectExpresswaySignal>>; source: 'now' | 'accel' }>,
) {
  const mapped = candidates
    .filter(item => !!item.signal?.nearestIc)
    .map(item => ({
      source: item.source,
      icName: item.signal.nearestIc!.icName,
      distanceM: item.signal.nearestIc!.distanceM,
      near: item.signal.nearIc || item.signal.nearEtcGate,
    }));
  if (mapped.length === 0) return null;
  mapped.sort((a, b) => {
    if (a.near !== b.near) return a.near ? -1 : 1;
    if (a.distanceM !== b.distanceM) return a.distanceM - b.distanceM;
    if (a.source !== b.source) return a.source === 'accel' ? -1 : 1;
    return 0;
  });
  return mapped[0];
}

async function maybeHandleNativeAutoExpressway(params: LocationPayload, effectiveSpeedKmh: number | null) {
  if (!Capacitor.isNativePlatform() || !activeTripId) return;
  const now = typeof params.time === 'number' && Number.isFinite(params.time) ? params.time : Date.now();
  const config = await loadAutoExpresswayConfigCached(now);
  const speedKmh = effectiveSpeedKmh;
  const accelMs2 = deriveAccelerationMs2(speedKmhToMs(speedKmh), now);
  if (accelMs2 != null) {
    if (accelMs2 >= AUTO_EXPRESSWAY_ACCEL_PROFILE.startAccelMs2) {
      expresswayRuntime.lastStrongAccelAt = now;
      expresswayRuntime.lastStrongAccelGeo = { lat: params.lat, lng: params.lng, at: now };
    }
    if (accelMs2 <= AUTO_EXPRESSWAY_ACCEL_PROFILE.endDecelMs2) {
      expresswayRuntime.lastStrongDecelAt = now;
    }
  }
  if (speedKmh == null) {
    expresswayRuntime.speedAboveSince = null;
    expresswayRuntime.speedBelowSince = null;
    expresswayRuntime.speedRecoveredSince = null;
    return;
  }
  const tripId = activeTripId;
  const isOpen = await getExpresswayOpenCached(tripId, now);
  if (isOpen) {
    await consumeKeepDecisionIfAny(tripId, now);
  }
  const cooldownMs = 60 * 1000;
  if (expresswayRuntime.inFlight || now - expresswayRuntime.lastActionAt < cooldownMs) return;

  const geo = {
    lat: params.lat,
    lng: params.lng,
    accuracy: params.accuracy ?? undefined,
  };

  if (isOpen) {
    expresswayRuntime.speedAboveSince = null;
    const recoverThreshold = config.endSpeedKmh + AUTO_EXPRESSWAY_ACCEL_PROFILE.endResetMarginKmh;
    if (speedKmh >= recoverThreshold) {
      if (expresswayRuntime.speedRecoveredSince == null) {
        expresswayRuntime.speedRecoveredSince = now;
      }
      const recoveredLongEnough =
        now - expresswayRuntime.speedRecoveredSince >= AUTO_EXPRESSWAY_ACCEL_PROFILE.endResetHoldMs;
      if (recoveredLongEnough && expresswayRuntime.endPromptOutstanding) {
        await clearPendingExpresswayEndPrompt(tripId);
        await clearPendingExpresswayEndDecision(tripId);
        await cancelNativeExpresswayEndPrompt(tripId);
        expresswayRuntime.endPromptOutstanding = false;
      }
      expresswayRuntime.speedBelowSince = null;
      return;
    }
    expresswayRuntime.speedRecoveredSince = null;
    if (speedKmh >= config.endSpeedKmh) {
      expresswayRuntime.speedBelowSince = null;
      return;
    }
    if (expresswayRuntime.speedBelowSince == null) {
      expresswayRuntime.speedBelowSince = now;
      return;
    }
    const lowSpeedSustained = now - expresswayRuntime.speedBelowSince >= config.endDurationSec * 1000;
    const strongDecelRecent =
      expresswayRuntime.lastStrongDecelAt != null &&
      now - expresswayRuntime.lastStrongDecelAt <= AUTO_EXPRESSWAY_ACCEL_PROFILE.endDecelWindowMs;
    const stopLikeSustained = lowSpeedSustained && speedKmh <= 20;
    if (!lowSpeedSustained || (!strongDecelRecent && !stopLikeSustained)) return;
    if (now - expresswayRuntime.lastEndPromptAt < AUTO_EXPRESSWAY_ACCEL_PROFILE.endPromptCooldownMs) return;
    const signal = await detectExpresswaySignal(geo.lat, geo.lng);
    const allowEndBySignal = !signal.resolved || signal.nearIc || signal.nearEtcGate || !signal.onExpresswayRoad;
    if (!allowEndBySignal) {
      expresswayRuntime.speedBelowSince = now;
      return;
    }
    expresswayRuntime.inFlight = true;
    try {
      const prompt = {
        tripId,
        speedKmh: Math.round(speedKmh),
        detectedAt: new Date(now).toISOString(),
        geo,
      } as const;
      await setPendingExpresswayEndPrompt(prompt);
      await showNativeExpresswayEndPrompt(prompt);
      expresswayRuntime.lastEndPromptAt = now;
      expresswayRuntime.lastActionAt = now;
      expresswayRuntime.endPromptOutstanding = true;
      setExpresswayOpenCache(tripId, true, now);
      expresswayRuntime.speedBelowSince = null;
    } catch {
      setExpresswayOpenCache(tripId, true, 0);
    } finally {
      expresswayRuntime.inFlight = false;
    }
    return;
  }

  expresswayRuntime.speedBelowSince = null;
  expresswayRuntime.speedRecoveredSince = null;
  expresswayRuntime.endPromptOutstanding = false;
  if (speedKmh < config.speedKmh) {
    expresswayRuntime.speedAboveSince = null;
    if (speedKmh >= 0 && speedKmh < config.speedKmh * 0.8) {
      expresswayRuntime.lastStrongAccelAt = null;
      expresswayRuntime.lastStrongAccelGeo = null;
    }
    return;
  }
  if (expresswayRuntime.speedAboveSince == null) {
    expresswayRuntime.speedAboveSince = now;
    return;
  }
  const strongAccelRecent =
    expresswayRuntime.lastStrongAccelAt != null &&
    now - expresswayRuntime.lastStrongAccelAt <= AUTO_EXPRESSWAY_ACCEL_PROFILE.startAccelWindowMs;
  if (!strongAccelRecent) return;
  if (now - expresswayRuntime.speedAboveSince < config.durationSec * 1000) return;
  const accelGeoCandidate =
    expresswayRuntime.lastStrongAccelGeo &&
    now - expresswayRuntime.lastStrongAccelGeo.at <= AUTO_EXPRESSWAY_ACCEL_PROFILE.startAccelWindowMs
      ? expresswayRuntime.lastStrongAccelGeo
      : null;
  const [signalNow, signalAccel] = await Promise.all([
    detectExpresswaySignal(geo.lat, geo.lng),
    accelGeoCandidate ? detectExpresswaySignal(accelGeoCandidate.lat, accelGeoCandidate.lng) : Promise.resolve(null),
  ]);
  const signalCandidates = [{ signal: signalNow, source: 'now' as const }];
  if (signalAccel) signalCandidates.push({ signal: signalAccel, source: 'accel' as const });
  const allowStartBySignal = signalCandidates.some(
    item => !item.signal.resolved || item.signal.onExpresswayRoad || item.signal.nearIc || item.signal.nearEtcGate,
  );
  if (!allowStartBySignal) {
    expresswayRuntime.speedAboveSince = now;
    return;
  }
  expresswayRuntime.inFlight = true;
  expresswayRuntime.speedAboveSince = null;
  try {
    await clearPendingExpresswayEndPrompt(tripId);
    await clearPendingExpresswayEndDecision(tripId);
    await cancelNativeExpresswayEndPrompt(tripId);
    const { eventId } = await startExpressway({ tripId, geo });
    const bestEntryIc = pickBestEntryIcCandidate(signalCandidates);
    if (bestEntryIc) {
      await updateExpresswayResolved({
        eventId,
        status: 'resolved',
        icName: bestEntryIc.icName,
        icDistanceM: bestEntryIc.distanceM,
      });
    }
    expresswayRuntime.lastActionAt = now;
    setExpresswayOpenCache(tripId, true, now);
  } catch {
    setExpresswayOpenCache(tripId, false, 0);
  } finally {
    expresswayRuntime.inFlight = false;
  }
}

async function recordLocation(params: LocationPayload) {
  if (!activeTripId) return;
  const now = typeof params.time === 'number' ? params.time : Date.now();
  const accuracy = typeof params.accuracy === 'number' && Number.isFinite(params.accuracy) ? params.accuracy : null;
  if (accuracy != null && accuracy > modeConfig.maxAccuracyM) {
    return;
  }
  let inferredSpeedKmh: number | null = null;
  let sensorSpeedKmh: number | null = speedMsToKmh(params.speed);
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
  const fusedSpeedKmh = smoothSpeedKmh(
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
  await maybeHandleNativeAutoExpressway(
    {
      ...params,
      speed: fusedSpeedMs ?? params.speed ?? null,
    },
    fusedSpeedKmh,
  );
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
  lastPoint = null;
  resetAutoExpresswayRuntime();

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
          // NOT_AUTHORIZED is handled in UI
          return;
        }
        if (!location) return;
        await recordLocation({
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
      await recordLocation({
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
  lastPoint = null;
  resetAutoExpresswayRuntime();
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
