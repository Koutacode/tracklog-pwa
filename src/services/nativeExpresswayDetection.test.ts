import type { AppEvent } from '../domain/types';
import type { NativeResidentRoutePoint } from '../app/nativeResidentLocationPolicy';
import {
  DEFAULT_AUTO_EXPRESSWAY_CONFIG,
  type PendingExpresswayEndPrompt,
} from '../db/repositories';
import type { ExpresswaySignal } from './icResolver';
import {
  advanceNativeExpresswayMotion,
  applyNativeExpresswayStartSignal,
  createNativeExpresswayDetectionProcessor,
  createNativeExpresswayDetectionState,
  shouldPromptForExpresswayEnd,
} from './nativeExpresswayDetection';

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

const BASE_MS = Date.parse('2026-08-23T00:00:00.000Z');
const TRIP_ID = 'trip-native-auto';
const CONFIG = DEFAULT_AUTO_EXPRESSWAY_CONFIG;

function point(seconds: number, speedKmh: number, id = `point-${seconds}`, tripId = TRIP_ID) {
  return {
    id,
    tripId,
    ts: new Date(BASE_MS + seconds * 1000).toISOString(),
    lat: 35.68,
    lng: 139.76,
    accuracy: 8,
    speed: speedKmh / 3.6,
    heading: 90,
    source: 'background',
  } satisfies NativeResidentRoutePoint;
}

const POSITIVE_START_SIGNAL: ExpresswaySignal = {
  resolved: true,
  provider: 'overpass',
  onExpresswayRoad: true,
  nearIc: false,
  nearEtcGate: false,
  nearestIc: { icName: '候補IC', distanceM: 500 },
};

const POSITIVE_END_SIGNAL: ExpresswaySignal = {
  resolved: true,
  provider: 'overpass',
  onExpresswayRoad: false,
  nearIc: true,
  nearEtcGate: true,
  nearestIc: { icName: '候補出口', distanceM: 300 },
};

const UNRESOLVED_SIGNAL: ExpresswaySignal = {
  resolved: false,
  provider: 'none',
  onExpresswayRoad: false,
  nearIc: false,
  nearEtcGate: false,
  nearestIc: null,
};

function advanceStartState() {
  let state = createNativeExpresswayDetectionState(TRIP_ID);
  for (const observation of [point(0, 40), point(10, 82)]) {
    state = advanceNativeExpresswayMotion({
      state,
      point: observation,
      config: CONFIG,
      isOpen: false,
    }).state;
  }

  let shouldStart = false;
  for (const seconds of [20, 30, 40]) {
    const motion = advanceNativeExpresswayMotion({
      state,
      point: point(seconds, 84),
      config: CONFIG,
      isOpen: false,
    });
    state = motion.state;
    assertEqual(motion.effect.type, 'probe-start', `sustained speed probe at ${seconds}s`);
    if (motion.effect.type === 'probe-start') {
      const applied = applyNativeExpresswayStartSignal({
        state,
        pointAtMs: motion.effect.pointAtMs,
        signal: POSITIVE_START_SIGNAL,
      });
      state = applied.state;
      shouldStart = applied.shouldStart;
    }
  }
  return { state, shouldStart };
}

const startResult = advanceStartState();
assertEqual(startResult.shouldStart, true, 'start requires multiple positive road-signal hits and hold');
assertEqual(startResult.state.startSignalHits, 3, 'start confirmation records all positive hits');

const duplicate = advanceNativeExpresswayMotion({
  state: startResult.state,
  point: point(40, 84),
  config: CONFIG,
  isOpen: false,
});
assertEqual(duplicate.ignoredReason, 'duplicate', 'duplicate native UUID is ignored');

const reversed = advanceNativeExpresswayMotion({
  state: startResult.state,
  point: point(35, 84, 'reversed-point'),
  config: CONFIG,
  isOpen: false,
});
assertEqual(reversed.ignoredReason, 'out-of-order', 'timestamp regression is ignored');

const wrongTrip = advanceNativeExpresswayMotion({
  state: startResult.state,
  point: point(50, 84, 'wrong-trip-point', 'stale-trip'),
  config: CONFIG,
  isOpen: false,
});
assertEqual(wrongTrip.ignoredReason, 'different-trip', 'a stale trip point cannot alter active state');

let monotonicState = createNativeExpresswayDetectionState(TRIP_ID);
const monotonicFirst: NativeResidentRoutePoint = {
  ...point(10, 40, 'monotonic-first'),
  monotonicSessionId: 'boot-a',
  elapsedRealtimeMs: 1_000,
};
const monotonicWallClockBack: NativeResidentRoutePoint = {
  ...point(0, 42, 'monotonic-wall-back'),
  monotonicSessionId: 'boot-a',
  elapsedRealtimeMs: 11_000,
};
const monotonicInitial = advanceNativeExpresswayMotion({
  state: monotonicState,
  point: monotonicFirst,
  config: CONFIG,
  isOpen: false,
});
monotonicState = monotonicInitial.state;
const logicalFirstAt = monotonicState.lastPointAtMs!;
const monotonicAccepted = advanceNativeExpresswayMotion({
  state: monotonicState,
  point: monotonicWallClockBack,
  config: CONFIG,
  isOpen: false,
});
assertEqual(
  monotonicAccepted.ignoredReason,
  undefined,
  'same-boot elapsedRealtime accepts a point after wall-clock reversal',
);
assertEqual(
  monotonicAccepted.state.lastPointAtMs,
  logicalFirstAt + 10_000,
  'motion hold time follows same-boot elapsedRealtime',
);
const monotonicReversed = advanceNativeExpresswayMotion({
  state: monotonicAccepted.state,
  point: {
    ...point(20, 44, 'monotonic-reversed'),
    monotonicSessionId: 'boot-a',
    elapsedRealtimeMs: 5_000,
  },
  config: CONFIG,
  isOpen: false,
});
assertEqual(monotonicReversed.ignoredReason, 'out-of-order', 'same-boot monotonic reversal is ignored');
const nextBootAccepted = advanceNativeExpresswayMotion({
  state: monotonicAccepted.state,
  point: {
    ...point(-100, 45, 'next-boot-wall-back'),
    monotonicSessionId: 'boot-b',
    elapsedRealtimeMs: 100,
  },
  config: CONFIG,
  isOpen: false,
});
assertEqual(
  nextBootAccepted.ignoredReason,
  undefined,
  'cross-boot FIFO accepts a new monotonic session despite wall-clock reversal',
);
assertEqual(
  nextBootAccepted.state.lastSpeedAtMs,
  nextBootAccepted.state.lastPointAtMs,
  'new boot starts a fresh motion sample without cross-boot acceleration',
);

let endState = createNativeExpresswayDetectionState(TRIP_ID);
endState = advanceNativeExpresswayMotion({
  state: endState,
  point: point(0, 82),
  config: CONFIG,
  isOpen: true,
}).state;
endState = advanceNativeExpresswayMotion({
  state: endState,
  point: point(10, 18),
  config: CONFIG,
  isOpen: true,
}).state;
const endProbe = advanceNativeExpresswayMotion({
  state: endState,
  point: point(40, 12),
  config: CONFIG,
  isOpen: true,
});
assertEqual(endProbe.effect.type, 'probe-end', 'sustained deceleration requests an end signal');
if (endProbe.effect.type === 'probe-end') {
  assertEqual(
    shouldPromptForExpresswayEnd(POSITIVE_END_SIGNAL, endProbe.effect.lowSpeedElapsedMs),
    true,
    'exit-side road signal permits only a confirmation prompt',
  );
  assertEqual(
    shouldPromptForExpresswayEnd(UNRESOLVED_SIGNAL, endProbe.effect.lowSpeedElapsedMs),
    false,
    'short resolver outage does not prompt from speed alone',
  );
}
endState = endProbe.state;
const fallbackProbe = advanceNativeExpresswayMotion({
  state: endState,
  point: point(100, 10),
  config: CONFIG,
  isOpen: true,
});
assertEqual(fallbackProbe.effect.type, 'probe-end', 'long low-speed state retries the signal conservatively');
if (fallbackProbe.effect.type === 'probe-end') {
  assertEqual(
    shouldPromptForExpresswayEnd(UNRESOLVED_SIGNAL, fallbackProbe.effect.lowSpeedElapsedMs),
    true,
    'resolver-unavailable fallback requires ninety seconds of low speed',
  );
}

let keepState = createNativeExpresswayDetectionState(TRIP_ID);
keepState = advanceNativeExpresswayMotion({
  state: keepState,
  point: point(0, 15),
  config: CONFIG,
  isOpen: true,
  pendingEndDecision: 'keep',
  pendingDecisionAtMs: BASE_MS,
}).state;
const keepRecoveryStart = advanceNativeExpresswayMotion({
  state: keepState,
  point: point(10, 50),
  config: CONFIG,
  isOpen: true,
  pendingEndDecision: 'keep',
  pendingDecisionAtMs: BASE_MS,
});
assertEqual(keepRecoveryStart.effect.type, 'none', 'keep remains suppressed while recovery begins');
const keepRecovered = advanceNativeExpresswayMotion({
  state: keepRecoveryStart.state,
  point: point(30, 52),
  config: CONFIG,
  isOpen: true,
  pendingEndDecision: 'keep',
  pendingDecisionAtMs: BASE_MS,
});
assertEqual(keepRecovered.effect.type, 'clear-keep', 'keep suppression clears only after speed recovery hold');

function tripStart(): AppEvent {
  return {
    id: 'trip-start',
    tripId: TRIP_ID,
    type: 'trip_start',
    ts: new Date(BASE_MS - 60_000).toISOString(),
    geo: undefined,
    syncStatus: 'pending',
    extras: { odoKm: 0 },
  };
}

async function runProcessorTests() {
  const events: AppEvent[] = [tripStart()];
  let startCalls = 0;
  let enqueueCalls = 0;
  const shared = {
    getAutoExpresswayConfig: async () => CONFIG,
    getActiveTripId: async () => TRIP_ID,
    getEventsByTripId: async () => [...events],
    getPendingExpresswayEndDecision: async () => null,
    getPendingExpresswayEndPrompt: async () => null,
    clearPendingExpresswayEndDecision: async () => undefined,
    clearPendingExpresswayEndPrompt: async () => undefined,
    cancelNativeExpresswayEndPrompt: async () => undefined,
    detectExpresswaySignal: async () => POSITIVE_START_SIGNAL,
    enqueueExpresswayIcResolution: () => {
      enqueueCalls += 1;
    },
    setPendingExpresswayEndPrompt: async () => undefined,
    showNativeExpresswayEndPrompt: async () => true,
    startExpressway: async (input: { tripId: string; occurredAt?: string }) => {
      startCalls += 1;
      events.push({
        id: 'auto-start-event',
        tripId: input.tripId,
        type: 'expressway_start',
        ts: input.occurredAt!,
        syncStatus: 'pending',
        extras: { expresswaySessionId: 'auto-session' },
      });
      return { expresswaySessionId: 'auto-session', eventId: 'auto-start-event', created: true };
    },
  };
  const processor = createNativeExpresswayDetectionProcessor(shared);
  for (const observation of [
    point(0, 40),
    point(10, 82),
    point(20, 84),
    point(30, 84),
    point(40, 84),
  ]) {
    await processor.process({ activeTripId: TRIP_ID, point: observation });
  }
  assertEqual(startCalls, 1, 'confirmed native replay persists one automatic start');
  assertEqual(enqueueCalls, 1, 'automatic start enqueues IC resolution without trusting a raw nearest name');

  for (const observation of [point(20, 84), point(30, 84), point(40, 84)]) {
    await processor.process({ activeTripId: TRIP_ID, point: observation });
  }
  assertEqual(startCalls, 1, 'same-process replay cannot duplicate a start');

  const coldProcessor = createNativeExpresswayDetectionProcessor(shared);
  for (const observation of [
    point(0, 40),
    point(10, 82),
    point(20, 84),
    point(30, 84),
    point(40, 84),
  ]) {
    await coldProcessor.process({ activeTripId: TRIP_ID, point: observation });
  }
  assertEqual(startCalls, 1, 'event watermark prevents duplicate start after a cold replay');

  const closedEvents: AppEvent[] = [
    tripStart(),
    {
      id: 'durable-start',
      tripId: TRIP_ID,
      type: 'expressway_start',
      ts: new Date(BASE_MS + 40_000).toISOString(),
      syncStatus: 'pending',
      extras: { expresswaySessionId: 'durable-session' },
    },
    {
      id: 'durable-end',
      tripId: TRIP_ID,
      type: 'expressway_end',
      ts: new Date(BASE_MS + 50_000).toISOString(),
      syncStatus: 'pending',
      extras: { expresswaySessionId: 'durable-session' },
    },
  ];
  let coldReplaySignalCalls = 0;
  const monotonicColdReplay = createNativeExpresswayDetectionProcessor({
    ...shared,
    getEventsByTripId: async () => [...closedEvents],
    detectExpresswaySignal: async () => {
      coldReplaySignalCalls += 1;
      return POSITIVE_START_SIGNAL;
    },
  });
  for (const observation of [
    { ...point(0, 40), monotonicSessionId: 'cold-boot', elapsedRealtimeMs: 1_000 },
    { ...point(10, 82), monotonicSessionId: 'cold-boot', elapsedRealtimeMs: 11_000 },
    { ...point(20, 84), monotonicSessionId: 'cold-boot', elapsedRealtimeMs: 21_000 },
    { ...point(30, 84), monotonicSessionId: 'cold-boot', elapsedRealtimeMs: 31_000 },
    { ...point(40, 84), monotonicSessionId: 'cold-boot', elapsedRealtimeMs: 41_000 },
  ]) {
    await monotonicColdReplay.process({ activeTripId: TRIP_ID, point: observation });
  }
  assertEqual(
    coldReplaySignalCalls,
    0,
    'monotonic metadata cannot bypass the latest durable expressway event watermark',
  );
  assertEqual(startCalls, 1, 'processed monotonic spool points cannot reopen a closed expressway');

  const openEvents: AppEvent[] = [
    tripStart(),
    {
      id: 'existing-start',
      tripId: TRIP_ID,
      type: 'expressway_start',
      ts: new Date(BASE_MS - 1_000).toISOString(),
      syncStatus: 'pending',
      extras: { expresswaySessionId: 'existing-session' },
    },
  ];
  let pendingPrompt: PendingExpresswayEndPrompt | null = null;
  let pendingPromptTripId = '';
  let promptCalls = 0;
  const endProcessor = createNativeExpresswayDetectionProcessor({
    ...shared,
    getEventsByTripId: async () => [...openEvents],
    getPendingExpresswayEndPrompt: async () => pendingPrompt,
    detectExpresswaySignal: async () => POSITIVE_END_SIGNAL,
    setPendingExpresswayEndPrompt: async promptValue => {
      pendingPrompt = promptValue;
      pendingPromptTripId = promptValue.tripId;
    },
    showNativeExpresswayEndPrompt: async () => {
      promptCalls += 1;
      return true;
    },
  });
  for (const observation of [point(0, 82), point(10, 18), point(40, 12), point(80, 10)]) {
    await endProcessor.process({ activeTripId: TRIP_ID, point: observation });
  }
  assertEqual(promptCalls, 1, 'durable pending prompt prevents duplicate native notifications');
  assertEqual(pendingPromptTripId, TRIP_ID, 'end detection persists confirmation instead of ending directly');

  console.log('nativeExpresswayDetection: 26 tests passed');
}

void runProcessorTests().catch(error => {
  globalThis.setTimeout(() => {
    throw error;
  }, 0);
});
