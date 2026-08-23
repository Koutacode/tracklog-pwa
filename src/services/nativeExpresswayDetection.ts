import {
  DEFAULT_AUTO_EXPRESSWAY_CONFIG,
  clearPendingExpresswayEndDecision,
  clearPendingExpresswayEndPrompt,
  getAutoExpresswayConfig,
  getActiveTripId,
  getEventsByTripId,
  getPendingExpresswayEndDecision,
  getPendingExpresswayEndPrompt,
  setPendingExpresswayEndPrompt,
  startExpressway,
  type AutoExpresswayConfig,
  type AutoExpresswayDecisionReason,
  type PendingExpresswayEndPrompt,
} from '../db/repositories';
import { db } from '../db/db';
import {
  EXPRESSWAY_TOGGLE_DEFINITION,
  PERSISTED_BASIC_TOGGLE_DEFINITIONS,
  findOpenToggleStart,
} from '../domain/togglePairing';
import type { AppEvent } from '../domain/types';
import type { NativeResidentRoutePoint } from '../app/nativeResidentLocationPolicy';
import { enqueueExpresswayIcResolution } from './expresswayIcResolution';
import { detectExpresswaySignal, type ExpresswaySignal } from './icResolver';
import {
  cancelNativeExpresswayEndPrompt,
  showNativeExpresswayEndPrompt,
} from './nativeExpresswayPrompt';
import {
  createMemoryQueueStorage,
  createNativeExpresswayDetectionWorkQueue,
  type NativeExpresswayDetectionWorkOutcome,
} from './nativeExpresswayDetectionQueue';

const MAX_DETECTION_ACCURACY_M = 100;
const MAX_SENSOR_SPEED_KMH = 220;
const RECENT_POINT_ID_LIMIT = 1024;
const START_ACCELERATION_MS2 = 0.18;
const START_ACCELERATION_WINDOW_MS = 75_000;
const START_SIGNAL_MIN_HITS = 2;
const START_SIGNAL_MIN_HOLD_MS = 12_000;
const START_SIGNAL_MAX_GAP_MS = 25_000;
const START_PROBE_MIN_INTERVAL_MS = 10_000;
const END_DECELERATION_MS2 = -0.28;
const END_DECELERATION_WINDOW_MS = 90_000;
const END_PROBE_MIN_INTERVAL_MS = 30_000;
const END_UNRESOLVED_FALLBACK_MS = 90_000;
const END_RECOVERY_MARGIN_KMH = 8;
const END_RECOVERY_HOLD_MS = 20_000;
const SIGNAL_TIMEOUT_MS = 12_000;

export type NativeExpresswayDetectionState = {
  tripId: string;
  recentPointIds: string[];
  lastMonotonicSessionId: string | null;
  lastElapsedRealtimeMs: number | null;
  lastPointAtMs: number | null;
  lastSpeedMs: number | null;
  lastSpeedAtMs: number | null;
  speedAboveSinceMs: number | null;
  speedBelowSinceMs: number | null;
  speedRecoveredSinceMs: number | null;
  lastStrongAccelerationAtMs: number | null;
  lastStrongDecelerationAtMs: number | null;
  lastStartProbeAtMs: number | null;
  lastEndProbeAtMs: number | null;
  startSignalFirstAtMs: number | null;
  startSignalLastAtMs: number | null;
  startSignalHits: number;
  keepSuppressed: boolean;
};

export type NativeExpresswayMotionEffect =
  | { type: 'none' }
  | { type: 'probe-start'; pointAtMs: number; speedKmh: number; accelerationMs2: number | null }
  | {
      type: 'probe-end';
      pointAtMs: number;
      speedKmh: number;
      accelerationMs2: number | null;
      lowSpeedElapsedMs: number;
    }
  | { type: 'clear-keep' };

export type NativeExpresswayMotionResult = {
  state: NativeExpresswayDetectionState;
  effect: NativeExpresswayMotionEffect;
  ignoredReason?: 'different-trip' | 'duplicate' | 'out-of-order' | 'invalid-time' | 'poor-accuracy';
};

export function createNativeExpresswayDetectionState(
  tripId: string,
  eventWatermarkMs: number | null = null,
): NativeExpresswayDetectionState {
  return {
    tripId,
    recentPointIds: [],
    lastMonotonicSessionId: null,
    lastElapsedRealtimeMs: null,
    lastPointAtMs: eventWatermarkMs,
    lastSpeedMs: null,
    lastSpeedAtMs: null,
    speedAboveSinceMs: null,
    speedBelowSinceMs: null,
    speedRecoveredSinceMs: null,
    lastStrongAccelerationAtMs: null,
    lastStrongDecelerationAtMs: null,
    lastStartProbeAtMs: null,
    lastEndProbeAtMs: null,
    startSignalFirstAtMs: null,
    startSignalLastAtMs: null,
    startSignalHits: 0,
    keepSuppressed: false,
  };
}

function rememberPointId(state: NativeExpresswayDetectionState, pointId: string) {
  const recentPointIds = [...state.recentPointIds, pointId];
  if (recentPointIds.length > RECENT_POINT_ID_LIMIT) {
    recentPointIds.splice(0, recentPointIds.length - RECENT_POINT_ID_LIMIT);
  }
  return recentPointIds;
}

function resetStartCandidate(state: NativeExpresswayDetectionState) {
  return {
    ...state,
    startSignalFirstAtMs: null,
    startSignalLastAtMs: null,
    startSignalHits: 0,
  };
}

function resetMotionAcrossClockSession(state: NativeExpresswayDetectionState) {
  return resetStartCandidate({
    ...state,
    lastSpeedMs: null,
    lastSpeedAtMs: null,
    speedAboveSinceMs: null,
    speedBelowSinceMs: null,
    speedRecoveredSinceMs: null,
    lastStrongAccelerationAtMs: null,
    lastStrongDecelerationAtMs: null,
  });
}

type ResolvedPointClock = {
  wallAtMs: number;
  motionAtMs: number;
  monotonicSessionId: string | null;
  elapsedRealtimeMs: number | null;
  resetMotion: boolean;
};

function resolvePointClock(
  state: NativeExpresswayDetectionState,
  point: NativeResidentRoutePoint,
): { clock: ResolvedPointClock | null; invalidTime: boolean; outOfOrder: boolean } {
  const wallAtMs = Date.parse(point.ts);
  if (!Number.isFinite(wallAtMs)) {
    return { clock: null, invalidTime: true, outOfOrder: false };
  }
  const monotonicSessionId = typeof point.monotonicSessionId === 'string'
    && point.monotonicSessionId.trim()
    ? point.monotonicSessionId.trim()
    : null;
  const elapsedRealtimeMs = monotonicSessionId
    && typeof point.elapsedRealtimeMs === 'number'
    && Number.isFinite(point.elapsedRealtimeMs)
    && point.elapsedRealtimeMs >= 0
    ? point.elapsedRealtimeMs
    : null;

  if (monotonicSessionId && elapsedRealtimeMs != null) {
    if (
      state.lastMonotonicSessionId === monotonicSessionId
      && state.lastElapsedRealtimeMs != null
    ) {
      if (elapsedRealtimeMs <= state.lastElapsedRealtimeMs) {
        return { clock: null, invalidTime: false, outOfOrder: true };
      }
      return {
        clock: {
          wallAtMs,
          motionAtMs: (state.lastPointAtMs ?? wallAtMs)
            + (elapsedRealtimeMs - state.lastElapsedRealtimeMs),
          monotonicSessionId,
          elapsedRealtimeMs,
          resetMotion: false,
        },
        invalidTime: false,
        outOfOrder: false,
      };
    }
    return {
      clock: {
        wallAtMs,
        motionAtMs: state.lastPointAtMs == null
          ? wallAtMs
          : Math.max(state.lastPointAtMs + 1, wallAtMs),
        monotonicSessionId,
        elapsedRealtimeMs,
        resetMotion: state.lastPointAtMs != null,
      },
      invalidTime: false,
      outOfOrder: false,
    };
  }

  if (state.lastMonotonicSessionId != null) {
    return {
      clock: {
        wallAtMs,
        motionAtMs: Math.max((state.lastPointAtMs ?? wallAtMs) + 1, wallAtMs),
        monotonicSessionId: null,
        elapsedRealtimeMs: null,
        resetMotion: true,
      },
      invalidTime: false,
      outOfOrder: false,
    };
  }
  if (state.lastPointAtMs != null && wallAtMs <= state.lastPointAtMs) {
    return { clock: null, invalidTime: false, outOfOrder: true };
  }
  return {
    clock: {
      wallAtMs,
      motionAtMs: wallAtMs,
      monotonicSessionId: null,
      elapsedRealtimeMs: null,
      resetMotion: false,
    },
    invalidTime: false,
    outOfOrder: false,
  };
}

function consumePointWithoutDetection(
  state: NativeExpresswayDetectionState,
  point: NativeResidentRoutePoint,
) {
  const resolvedClock = resolvePointClock(state, point);
  const clock = resolvedClock.clock;
  if (
    point.tripId !== state.tripId
    || state.recentPointIds.includes(point.id)
    || !clock
  ) {
    return state;
  }
  const base = clock.resetMotion ? resetMotionAcrossClockSession(state) : state;
  return resetStartCandidate({
    ...base,
    recentPointIds: rememberPointId(state, point.id),
    lastMonotonicSessionId: clock.monotonicSessionId,
    lastElapsedRealtimeMs: clock.elapsedRealtimeMs,
    lastPointAtMs: clock.motionAtMs,
    lastSpeedMs: null,
    lastSpeedAtMs: null,
    speedAboveSinceMs: null,
    speedBelowSinceMs: null,
    speedRecoveredSinceMs: null,
    lastStrongAccelerationAtMs: null,
    lastStrongDecelerationAtMs: null,
  });
}

function validSpeedMs(speed: number | null | undefined): number | null {
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0) return null;
  if (speed * 3.6 > MAX_SENSOR_SPEED_KMH) return null;
  return speed;
}

function deriveAcceleration(
  previousSpeedMs: number | null,
  previousAtMs: number | null,
  speedMs: number | null,
  atMs: number,
) {
  if (previousSpeedMs == null || previousAtMs == null || speedMs == null) return null;
  const elapsedSec = (atMs - previousAtMs) / 1000;
  if (!Number.isFinite(elapsedSec) || elapsedSec < 1 || elapsedSec > 30) return null;
  return (speedMs - previousSpeedMs) / elapsedSec;
}

/**
 * Pure motion state machine. It never performs network, notification, or
 * repository work; callers execute only the returned conservative effect.
 */
export function advanceNativeExpresswayMotion(input: {
  state: NativeExpresswayDetectionState;
  point: NativeResidentRoutePoint;
  config: AutoExpresswayConfig;
  isOpen: boolean;
  hasPendingPrompt?: boolean;
  pendingEndDecision?: 'end' | 'keep' | null;
  pendingDecisionAtMs?: number | null;
}): NativeExpresswayMotionResult {
  const { point, config } = input;
  const original = input.state;
  if (point.tripId !== original.tripId) {
    return { state: original, effect: { type: 'none' }, ignoredReason: 'different-trip' };
  }
  if (original.recentPointIds.includes(point.id)) {
    return { state: original, effect: { type: 'none' }, ignoredReason: 'duplicate' };
  }
  const resolvedClock = resolvePointClock(original, point);
  if (resolvedClock.invalidTime) {
    return { state: original, effect: { type: 'none' }, ignoredReason: 'invalid-time' };
  }
  if (resolvedClock.outOfOrder || !resolvedClock.clock) {
    return { state: original, effect: { type: 'none' }, ignoredReason: 'out-of-order' };
  }
  const clock = resolvedClock.clock;
  const pointAtMs = clock.motionAtMs;
  const clockBase = clock.resetMotion
    ? resetMotionAcrossClockSession(original)
    : original;

  const recentPointIds = rememberPointId(clockBase, point.id);
  if (
    typeof point.accuracy === 'number'
    && Number.isFinite(point.accuracy)
    && point.accuracy > MAX_DETECTION_ACCURACY_M
  ) {
    return {
      state: {
        ...clockBase,
        recentPointIds,
        lastMonotonicSessionId: clock.monotonicSessionId,
        lastElapsedRealtimeMs: clock.elapsedRealtimeMs,
        lastPointAtMs: pointAtMs,
      },
      effect: { type: 'none' },
      ignoredReason: 'poor-accuracy',
    };
  }

  const speedMs = validSpeedMs(point.speed);
  const speedKmh = speedMs == null ? null : speedMs * 3.6;
  const accelerationMs2 = deriveAcceleration(
    clockBase.lastSpeedMs,
    clockBase.lastSpeedAtMs,
    speedMs,
    pointAtMs,
  );
  let state: NativeExpresswayDetectionState = {
    ...clockBase,
    recentPointIds,
    lastMonotonicSessionId: clock.monotonicSessionId,
    lastElapsedRealtimeMs: clock.elapsedRealtimeMs,
    lastPointAtMs: pointAtMs,
    lastSpeedMs: speedMs,
    lastSpeedAtMs: speedMs == null ? null : pointAtMs,
  };

  if (accelerationMs2 != null && accelerationMs2 >= START_ACCELERATION_MS2) {
    state = { ...state, lastStrongAccelerationAtMs: pointAtMs };
  }
  if (accelerationMs2 != null && accelerationMs2 <= END_DECELERATION_MS2) {
    state = { ...state, lastStrongDecelerationAtMs: pointAtMs };
  }
  if (speedKmh == null) {
    return {
      state: resetStartCandidate({
        ...state,
        speedAboveSinceMs: null,
        speedBelowSinceMs: null,
        speedRecoveredSinceMs: null,
      }),
      effect: { type: 'none' },
    };
  }

  if (input.isOpen) {
    state = resetStartCandidate({ ...state, speedAboveSinceMs: null });
    const recoveryThresholdKmh = config.endSpeedKmh + END_RECOVERY_MARGIN_KMH;
    const decisionAtMs = input.pendingDecisionAtMs ?? null;
    const keepAppliesToPoint = input.pendingEndDecision === 'keep'
      && (decisionAtMs == null || pointAtMs > decisionAtMs);
    const keepSuppressed = state.keepSuppressed || input.pendingEndDecision === 'keep';
    state = { ...state, keepSuppressed };

    if (input.pendingEndDecision === 'keep' && !keepAppliesToPoint) {
      return {
        state: { ...state, speedRecoveredSinceMs: null, speedBelowSinceMs: null },
        effect: { type: 'none' },
      };
    }

    if (speedKmh >= recoveryThresholdKmh) {
      const speedRecoveredSinceMs = state.speedRecoveredSinceMs ?? pointAtMs;
      state = { ...state, speedRecoveredSinceMs, speedBelowSinceMs: null };
      if (
        keepSuppressed
        && keepAppliesToPoint
        && pointAtMs - speedRecoveredSinceMs >= END_RECOVERY_HOLD_MS
      ) {
        return {
          state: { ...state, keepSuppressed: false, speedRecoveredSinceMs: null },
          effect: { type: 'clear-keep' },
        };
      }
      return { state, effect: { type: 'none' } };
    }

    state = { ...state, speedRecoveredSinceMs: null };
    if (keepSuppressed || input.pendingEndDecision === 'end' || input.hasPendingPrompt) {
      return { state, effect: { type: 'none' } };
    }
    if (speedKmh >= config.endSpeedKmh) {
      return { state: { ...state, speedBelowSinceMs: null }, effect: { type: 'none' } };
    }
    const speedBelowSinceMs = state.speedBelowSinceMs ?? pointAtMs;
    state = { ...state, speedBelowSinceMs };
    const lowSpeedElapsedMs = pointAtMs - speedBelowSinceMs;
    if (lowSpeedElapsedMs < config.endDurationSec * 1000) {
      return { state, effect: { type: 'none' } };
    }
    const strongDecelerationRecent = state.lastStrongDecelerationAtMs != null
      && pointAtMs - state.lastStrongDecelerationAtMs <= END_DECELERATION_WINDOW_MS;
    const stopLike = speedKmh <= 20;
    const longFallback = lowSpeedElapsedMs >= END_UNRESOLVED_FALLBACK_MS;
    if (!strongDecelerationRecent && !stopLike && !longFallback) {
      return { state, effect: { type: 'none' } };
    }
    if (
      state.lastEndProbeAtMs != null
      && pointAtMs - state.lastEndProbeAtMs < END_PROBE_MIN_INTERVAL_MS
    ) {
      return { state, effect: { type: 'none' } };
    }
    return {
      state: { ...state, lastEndProbeAtMs: pointAtMs },
      effect: {
        type: 'probe-end',
        pointAtMs,
        speedKmh,
        accelerationMs2,
        lowSpeedElapsedMs,
      },
    };
  }

  state = {
    ...state,
    keepSuppressed: false,
    speedBelowSinceMs: null,
    speedRecoveredSinceMs: null,
  };
  if (speedKmh < config.speedKmh) {
    return {
      state: resetStartCandidate({ ...state, speedAboveSinceMs: null }),
      effect: { type: 'none' },
    };
  }
  const speedAboveSinceMs = state.speedAboveSinceMs ?? pointAtMs;
  state = { ...state, speedAboveSinceMs };
  const strongAccelerationRecent = state.lastStrongAccelerationAtMs != null
    && pointAtMs - state.lastStrongAccelerationAtMs <= START_ACCELERATION_WINDOW_MS;
  if (!strongAccelerationRecent || pointAtMs - speedAboveSinceMs < config.durationSec * 1000) {
    return { state, effect: { type: 'none' } };
  }
  if (
    state.lastStartProbeAtMs != null
    && pointAtMs - state.lastStartProbeAtMs < START_PROBE_MIN_INTERVAL_MS
  ) {
    return { state, effect: { type: 'none' } };
  }
  return {
    state: { ...state, lastStartProbeAtMs: pointAtMs },
    effect: { type: 'probe-start', pointAtMs, speedKmh, accelerationMs2 },
  };
}

export function applyNativeExpresswayStartSignal(input: {
  state: NativeExpresswayDetectionState;
  pointAtMs: number;
  signal: ExpresswaySignal;
}) {
  const { signal, pointAtMs } = input;
  if (!signal.resolved || (!signal.onExpresswayRoad && !signal.nearEtcGate)) {
    return {
      state: resetStartCandidate(input.state),
      shouldStart: false,
      confirm: null as AutoExpresswayDecisionReason['confirm'] | null,
    };
  }
  const startsNewCandidate = input.state.startSignalFirstAtMs == null
    || input.state.startSignalLastAtMs == null
    || pointAtMs - input.state.startSignalLastAtMs > START_SIGNAL_MAX_GAP_MS;
  const firstAtMs = startsNewCandidate ? pointAtMs : input.state.startSignalFirstAtMs!;
  const hits = startsNewCandidate ? 1 : input.state.startSignalHits + 1;
  const elapsedMs = Math.max(0, pointAtMs - firstAtMs);
  const state = {
    ...input.state,
    startSignalFirstAtMs: firstAtMs,
    startSignalLastAtMs: pointAtMs,
    startSignalHits: hits,
  };
  const confirm = {
    hits,
    elapsedMs,
    minHits: START_SIGNAL_MIN_HITS,
    minHoldMs: START_SIGNAL_MIN_HOLD_MS,
  };
  return {
    state,
    shouldStart: hits >= START_SIGNAL_MIN_HITS && elapsedMs >= START_SIGNAL_MIN_HOLD_MS,
    confirm,
  };
}

export function shouldPromptForExpresswayEnd(
  signal: ExpresswaySignal,
  lowSpeedElapsedMs: number,
) {
  if (signal.resolved) {
    return signal.nearIc || signal.nearEtcGate || !signal.onExpresswayRoad;
  }
  return lowSpeedElapsedMs >= END_UNRESOLVED_FALLBACK_MS;
}

function expresswayEventWatermark(events: AppEvent[]) {
  let latest: number | null = null;
  for (const event of events) {
    if (event.type !== 'expressway_start' && event.type !== 'expressway_end' && event.type !== 'expressway') {
      continue;
    }
    const timestamp = Date.parse(event.ts);
    if (Number.isFinite(timestamp) && (latest == null || timestamp > latest)) latest = timestamp;
  }
  return latest;
}

function hasOpenExpressway(events: AppEvent[]) {
  return findOpenToggleStart(events, EXPRESSWAY_TOGGLE_DEFINITION) !== null;
}

const [REST_TOGGLE_DEFINITION, , , , FERRY_TOGGLE_DEFINITION] =
  PERSISTED_BASIC_TOGGLE_DEFINITIONS;

function isDetectionPaused(events: AppEvent[]) {
  return findOpenToggleStart(events, REST_TOGGLE_DEFINITION) !== null
    || findOpenToggleStart(events, FERRY_TOGGLE_DEFINITION) !== null;
}

function buildDecisionReason(input: {
  action: 'start' | 'end-prompt';
  point: NativeResidentRoutePoint;
  speedKmh: number;
  accelerationMs2: number | null;
  signal: ExpresswaySignal;
  config: AutoExpresswayConfig;
  confirm?: AutoExpresswayDecisionReason['confirm'];
}): AutoExpresswayDecisionReason {
  return {
    source: 'native-auto',
    action: input.action,
    evaluatedAt: input.point.ts,
    speedKmh: Math.round(input.speedKmh),
    ...(input.accelerationMs2 != null
      ? { accelerationMs2: Number(input.accelerationMs2.toFixed(3)) }
      : {}),
    ...(typeof input.point.accuracy === 'number'
      ? { accuracyM: Math.round(input.point.accuracy) }
      : {}),
    signalResolved: input.signal.resolved,
    onExpresswayRoad: input.signal.onExpresswayRoad,
    nearIc: input.signal.nearIc,
    nearEtcGate: input.signal.nearEtcGate,
    ...(input.signal.nearestIc?.icName
      ? { nearestIcName: input.signal.nearestIc.icName }
      : {}),
    ...(input.signal.nearestIc?.distanceM != null
      ? { nearestIcDistanceM: Math.round(input.signal.nearestIc.distanceM) }
      : {}),
    config: {
      startSpeedKmh: input.config.speedKmh,
      startDurationSec: input.config.durationSec,
      endSpeedKmh: input.config.endSpeedKmh,
      endDurationSec: input.config.endDurationSec,
    },
    ...(input.confirm ? { confirm: input.confirm } : {}),
  };
}

type DetectionDependencies = {
  getAutoExpresswayConfig: typeof getAutoExpresswayConfig;
  getActiveTripId: typeof getActiveTripId;
  getEventsByTripId: typeof getEventsByTripId;
  getPendingExpresswayEndDecision: typeof getPendingExpresswayEndDecision;
  getPendingExpresswayEndPrompt: typeof getPendingExpresswayEndPrompt;
  clearPendingExpresswayEndDecision: typeof clearPendingExpresswayEndDecision;
  clearPendingExpresswayEndPrompt: typeof clearPendingExpresswayEndPrompt;
  cancelNativeExpresswayEndPrompt: typeof cancelNativeExpresswayEndPrompt;
  detectExpresswaySignal: typeof detectExpresswaySignal;
  enqueueExpresswayIcResolution: typeof enqueueExpresswayIcResolution;
  setPendingExpresswayEndPrompt: typeof setPendingExpresswayEndPrompt;
  showNativeExpresswayEndPrompt: typeof showNativeExpresswayEndPrompt;
  startExpressway: typeof startExpressway;
};

const DEFAULT_DEPENDENCIES: DetectionDependencies = {
  getAutoExpresswayConfig,
  getActiveTripId,
  getEventsByTripId,
  getPendingExpresswayEndDecision,
  getPendingExpresswayEndPrompt,
  clearPendingExpresswayEndDecision,
  clearPendingExpresswayEndPrompt,
  cancelNativeExpresswayEndPrompt,
  detectExpresswaySignal,
  enqueueExpresswayIcResolution,
  setPendingExpresswayEndPrompt,
  showNativeExpresswayEndPrompt,
  startExpressway,
};

function unresolvedSignal(): ExpresswaySignal {
  return {
    resolved: false,
    provider: 'none',
    onExpresswayRoad: false,
    nearIc: false,
    nearEtcGate: false,
    nearestIc: null,
  };
}

async function withSignalTimeout(
  detect: () => Promise<ExpresswaySignal>,
): Promise<ExpresswaySignal> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      detect(),
      new Promise<ExpresswaySignal>(resolve => {
        timer = setTimeout(() => resolve(unresolvedSignal()), SIGNAL_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return unresolvedSignal();
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

export type NativeExpresswayDetectionProcessor = {
  process(input: {
    activeTripId: string | null;
    point: NativeResidentRoutePoint;
  }): Promise<NativeExpresswayDetectionWorkOutcome>;
  reset(): void;
  getState(): NativeExpresswayDetectionState | null;
};

export function createNativeExpresswayDetectionProcessor(
  overrides: Partial<DetectionDependencies> = {},
): NativeExpresswayDetectionProcessor {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  let state: NativeExpresswayDetectionState | null = null;
  let openCache: boolean | null = null;
  let detectionPausedCache = false;
  let persistedEventWatermarkMs: number | null = null;
  let openCacheReadAt = 0;
  let configCache = DEFAULT_AUTO_EXPRESSWAY_CONFIG;
  let configReadAt = 0;

  const reset = () => {
    state = null;
    openCache = null;
    detectionPausedCache = false;
    persistedEventWatermarkMs = null;
    openCacheReadAt = 0;
    configCache = DEFAULT_AUTO_EXPRESSWAY_CONFIG;
    configReadAt = 0;
  };

  const readEvents = async (tripId: string, force = false) => {
    const now = Date.now();
    if (!force && openCache != null && now - openCacheReadAt < 5_000) {
      return {
        isOpen: openCache,
        detectionPaused: detectionPausedCache,
        events: null as AppEvent[] | null,
      };
    }
    const events = await dependencies.getEventsByTripId(tripId);
    openCache = hasOpenExpressway(events);
    detectionPausedCache = isDetectionPaused(events);
    persistedEventWatermarkMs = expresswayEventWatermark(events);
    openCacheReadAt = now;
    return { isOpen: openCache, detectionPaused: detectionPausedCache, events };
  };

  const readConfig = async () => {
    const now = Date.now();
    if (now - configReadAt >= 15_000) {
      configReadAt = now;
      try {
        configCache = await dependencies.getAutoExpresswayConfig();
      } catch {
        // Retain the previous valid configuration without interrupting queue ack.
      }
    }
    return configCache;
  };

  const processInternal = async (input: {
    activeTripId: string | null;
    point: NativeResidentRoutePoint;
  }): Promise<NativeExpresswayDetectionWorkOutcome> => {
    const activeTripId = input.activeTripId?.trim() ?? '';
    if (!activeTripId || input.point.tripId !== activeTripId) return 'processed';

    if (!state || state.tripId !== activeTripId) {
      const initial = await readEvents(activeTripId, true);
      const watermark = expresswayEventWatermark(initial.events ?? []);
      state = createNativeExpresswayDetectionState(activeTripId, watermark);
    }
    const pointWallClockMs = Date.parse(input.point.ts);
    if (
      persistedEventWatermarkMs != null
      && Number.isFinite(pointWallClockMs)
      && pointWallClockMs <= persistedEventWatermarkMs
    ) {
      // A cold native spool replay must never walk around an already durable
      // start/end event merely because it also carries a new monotonic clock.
      return 'processed';
    }
    const config = await readConfig();
    const openSnapshot = await readEvents(activeTripId);
    if (openSnapshot.detectionPaused) {
      state = consumePointWithoutDetection(state, input.point);
      return 'processed';
    }
    const pendingPrompt = openSnapshot.isOpen
      ? await dependencies.getPendingExpresswayEndPrompt()
      : null;
    const pendingDecision = openSnapshot.isOpen
      ? await dependencies.getPendingExpresswayEndDecision()
      : null;
    const matchingPrompt = pendingPrompt?.tripId === activeTripId ? pendingPrompt : null;
    const matchingDecision = pendingDecision?.tripId === activeTripId ? pendingDecision : null;
    const decisionAtMs = matchingDecision ? Date.parse(matchingDecision.decidedAt) : Number.NaN;
    const motion = advanceNativeExpresswayMotion({
      state,
      point: input.point,
      config,
      isOpen: openSnapshot.isOpen,
      hasPendingPrompt: !!matchingPrompt,
      pendingEndDecision: matchingDecision?.action ?? null,
      pendingDecisionAtMs: Number.isFinite(decisionAtMs) ? decisionAtMs : null,
    });
    state = motion.state;
    if (motion.effect.type === 'none') return 'processed';

    if (motion.effect.type === 'clear-keep') {
      await dependencies.clearPendingExpresswayEndDecision(activeTripId);
      await dependencies.clearPendingExpresswayEndPrompt(activeTripId);
      await dependencies.cancelNativeExpresswayEndPrompt(activeTripId);
      return 'processed';
    }

    const signal = await withSignalTimeout(() => dependencies.detectExpresswaySignal(
      input.point.lat,
      input.point.lng,
    ));

    if (motion.effect.type === 'probe-start') {
      if (!signal.resolved) return 'retry';
      const applied = applyNativeExpresswayStartSignal({
        state,
        pointAtMs: motion.effect.pointAtMs,
        signal,
      });
      state = applied.state;
      if (!applied.shouldStart || !applied.confirm) return 'processed';

      const fresh = await readEvents(activeTripId, true);
      if (
        fresh.isOpen
        || fresh.detectionPaused
        || await dependencies.getActiveTripId() !== activeTripId
      ) {
        state = resetStartCandidate(state);
        return 'processed';
      }
      const reason = buildDecisionReason({
        action: 'start',
        point: input.point,
        speedKmh: motion.effect.speedKmh,
        accelerationMs2: motion.effect.accelerationMs2,
        signal,
        config,
        confirm: applied.confirm,
      });
      try {
        const { eventId } = await dependencies.startExpressway({
          tripId: activeTripId,
          geo: {
            lat: input.point.lat,
            lng: input.point.lng,
            ...(typeof input.point.accuracy === 'number'
              ? { accuracy: input.point.accuracy }
              : {}),
          },
          occurredAt: input.point.ts,
          autoDecision: reason,
        });
        openCache = true;
        openCacheReadAt = Date.now();
        persistedEventWatermarkMs = pointWallClockMs;
        state = resetStartCandidate({
          ...state,
          speedAboveSinceMs: null,
        });
        // Resolution performs its own distance/provenance checks. The road
        // signal's nearest name is diagnostic context, never an auto-accepted IC.
        dependencies.enqueueExpresswayIcResolution({
          eventId,
          geo: {
            lat: input.point.lat,
            lng: input.point.lng,
            ...(typeof input.point.accuracy === 'number'
              ? { accuracy: input.point.accuracy }
              : {}),
          },
          source: 'immediate',
        });
      } catch {
        // startExpressway's transaction is the final duplicate-start guard.
        const afterFailure = await readEvents(activeTripId, true);
        if (afterFailure.isOpen) {
          state = resetStartCandidate(state);
        } else {
          return 'retry';
        }
      }
      return 'processed';
    }

    if (!shouldPromptForExpresswayEnd(signal, motion.effect.lowSpeedElapsedMs)) return 'processed';
    const fresh = await readEvents(activeTripId, true);
    if (
      !fresh.isOpen
      || fresh.detectionPaused
      || await dependencies.getActiveTripId() !== activeTripId
    ) {
      return 'processed';
    }
    const freshPrompt = await dependencies.getPendingExpresswayEndPrompt();
    const freshDecision = await dependencies.getPendingExpresswayEndDecision();
    if (
      freshPrompt?.tripId === activeTripId
      || freshDecision?.tripId === activeTripId
    ) {
      return 'processed';
    }
    const reason = buildDecisionReason({
      action: 'end-prompt',
      point: input.point,
      speedKmh: motion.effect.speedKmh,
      accelerationMs2: motion.effect.accelerationMs2,
      signal,
      config,
    });
    const prompt: PendingExpresswayEndPrompt = {
      tripId: activeTripId,
      speedKmh: Math.round(motion.effect.speedKmh),
      detectedAt: input.point.ts,
      geo: {
        lat: input.point.lat,
        lng: input.point.lng,
        ...(typeof input.point.accuracy === 'number'
          ? { accuracy: input.point.accuracy }
          : {}),
      },
      reason,
    };
    await dependencies.setPendingExpresswayEndPrompt(prompt);
    try {
      await dependencies.showNativeExpresswayEndPrompt(prompt);
    } catch {
      // The durable prompt remains available to the foreground UI/retry path.
    }
    return 'processed';
  };

  const process = async (input: {
    activeTripId: string | null;
    point: NativeResidentRoutePoint;
  }): Promise<NativeExpresswayDetectionWorkOutcome> => {
    const stateBeforePoint = state;
    try {
      const outcome = await processInternal(input);
      if (outcome === 'retry') state = stateBeforePoint;
      return outcome;
    } catch {
      state = stateBeforePoint;
      return 'retry';
    }
  };

  return {
    process,
    reset,
    getState: () => state,
  };
}

const nativeExpresswayDetectionProcessor = createNativeExpresswayDetectionProcessor();

function defaultDetectionQueueStorage() {
  if (typeof window === 'undefined') return createMemoryQueueStorage();
  // Defer access until enqueue/run. If durable WebView storage is unavailable,
  // the call throws before native ack instead of silently losing detection work.
  return {
    getItem: (key: string) => window.localStorage.getItem(key),
    setItem: (key: string, value: string) => window.localStorage.setItem(key, value),
    removeItem: (key: string) => window.localStorage.removeItem(key),
  };
}

const nativeExpresswayDetectionWorkQueue = createNativeExpresswayDetectionWorkQueue({
  storage: defaultDetectionQueueStorage(),
  loadPoint: async pointId => {
    const point = await db.routePoints.get(pointId);
    return point ? { ...point } : null;
  },
  getActiveTripId,
  processPoint: async input => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return 'retry';
    return nativeExpresswayDetectionProcessor.process(input);
  },
});

/**
 * @deprecated Legacy migration/test entry point only. ResidentLocationService
 * owns every newly captured Android point and its prompt lifecycle.
 */
export function enqueueNativeExpresswayRoutePointDetection(input: {
  activeTripId: string | null;
  point: NativeResidentRoutePoint;
}) {
  nativeExpresswayDetectionWorkQueue.enqueue(input);
}

/** Wakes only pre-existing legacy work; no production path enqueues new work. */
export function resumePendingNativeExpresswayDetection() {
  nativeExpresswayDetectionWorkQueue.kick();
}

export async function processNativeExpresswayRoutePoint(input: {
  activeTripId: string | null;
  point: NativeResidentRoutePoint;
}) {
  return nativeExpresswayDetectionProcessor.process(input);
}

export function resetNativeExpresswayDetection() {
  nativeExpresswayDetectionProcessor.reset();
}
