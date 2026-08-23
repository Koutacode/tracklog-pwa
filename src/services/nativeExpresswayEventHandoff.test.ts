import type { AutoExpresswayDecisionReason } from '../db/repositories';
import type { AppEvent } from '../domain/types';
import type { NativeResidentExpresswayEvent } from './nativeResidentLocation';
import {
  drainNativeResidentExpresswayEventQueue,
  normalizeNativeResidentExpresswayEvent,
  prepareNativeExpresswayEventsForTripEnd,
} from './nativeExpresswayEventHandoff';

const TRIP_ID = 'trip-native-events';
const BASE_CONFIG = {
  speedKmh: 78,
  durationSec: 6,
  endSpeedKmh: 34,
  endDurationSec: 24,
};

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function tripStart(): AppEvent {
  return {
    id: 'trip-start',
    tripId: TRIP_ID,
    type: 'trip_start',
    ts: '2026-08-23T00:00:00.000Z',
    syncStatus: 'pending',
    extras: { odoKm: 0 },
  };
}

function expresswayStart(
  id = 'existing-start',
  nativeDetectionId?: string,
  nativeGeneration?: number,
): AppEvent {
  return {
    id,
    tripId: TRIP_ID,
    type: 'expressway_start',
    ts: '2026-08-23T00:01:00.000Z',
    syncStatus: 'pending',
    extras: {
      expresswaySessionId: 'expressway-session',
      ...(nativeDetectionId
        ? { autoDecision: { nativeDetectionId, ...(nativeGeneration ? { nativeGeneration } : {}) } }
        : {}),
    },
  };
}

function nativeEvent(
  kind: NativeResidentExpresswayEvent['kind'],
  generation: number,
  id = `${kind}-${generation}`,
): NativeResidentExpresswayEvent {
  return {
    id,
    tripId: TRIP_ID,
    kind,
    generation,
    detectedAt: '2026-08-23T00:02:00.000Z',
    ...(kind === 'decision_end' || kind === 'decision_keep'
      ? { decidedAt: '2026-08-23T00:02:05.000Z' }
      : {}),
    ...(kind !== 'start' ? { promptId: 'prompt-1' } : {}),
    geo: { lat: 35.68, lon: 139.76, accuracy: 8 },
    speedKmh: kind === 'start' ? 84 : 18,
    monotonicSessionId: 'boot-1',
    elapsedRealtimeMs: generation * 10_000,
    reason: {
      nativeDetectionId: id,
      signalResolved: true,
      onExpresswayRoad: kind === 'start',
      nearIc: kind !== 'start',
      nearEtcGate: true,
    },
  };
}

function createHarness(options?: {
  queued?: NativeResidentExpresswayEvent[];
  events?: AppEvent[];
  activeTripId?: string | null;
}) {
  const queued = [...(options?.queued ?? [])];
  const events = [...(options?.events ?? [tripStart()])];
  const generations = new Map<string, number>();
  const acknowledgements: string[] = [];
  const pendingPromptIds = new Set<string>();
  const pendingDecisionIds = new Set<string>();
  let startMaterializations = 0;
  let endMaterializations = 0;
  let promptMaterializations = 0;
  let decisionMaterializations = 0;
  let keepDecisionClears = 0;
  let enqueueCalls = 0;
  const dependencies = {
    peek: async (limit: number) => ({
      events: queued.slice(0, limit),
      remaining: queued.length,
    }),
    acknowledge: async (ids: string[]) => {
      acknowledgements.push(...ids);
      for (const id of ids) {
        const index = queued.findIndex(event => event.id === id);
        if (index >= 0) queued.splice(index, 1);
      }
      return { remaining: queued.length };
    },
    getActiveTripId: async () => options?.activeTripId === undefined ? TRIP_ID : options.activeTripId,
    getEventsByTripId: async () => [...events],
    getAutoExpresswayConfig: async () => BASE_CONFIG,
    getGeneration: async (tripId: string) => generations.get(tripId) ?? 0,
    advanceGeneration: async (tripId: string, generation: number) => {
      const next = Math.max(generations.get(tripId) ?? 0, generation);
      generations.set(tripId, next);
      return next;
    },
    startExpressway: async (input: {
      tripId: string;
      occurredAt?: string;
      autoDecision?: AutoExpresswayDecisionReason;
    }) => {
      const nativeDetectionId = input.autoDecision?.nativeDetectionId;
      const existing = events.find(event => (
        event.type === 'expressway_start'
        && (event.extras?.autoDecision as Record<string, unknown> | undefined)?.nativeDetectionId
          === nativeDetectionId
      ));
      if (existing) {
        return {
          expresswaySessionId: 'expressway-session',
          eventId: existing.id,
          created: false,
        };
      }
      startMaterializations += 1;
      const eventId = `stored-start-${startMaterializations}`;
      events.push({
        ...expresswayStart(eventId, nativeDetectionId, input.autoDecision?.nativeGeneration),
        ts: input.occurredAt ?? '2026-08-23T00:02:00.000Z',
      });
      return { expresswaySessionId: 'expressway-session', eventId, created: true };
    },
    endExpressway: async (input: {
      tripId: string;
      occurredAt?: string;
      autoDecision?: AutoExpresswayDecisionReason;
    }) => {
      const nativeDetectionId = input.autoDecision?.nativeDetectionId;
      const existing = events.find(event => (
        event.type === 'expressway_end'
        && (event.extras?.autoDecision as Record<string, unknown> | undefined)?.nativeDetectionId
          === nativeDetectionId
      ));
      if (existing) return { eventId: existing.id, created: false };
      endMaterializations += 1;
      const eventId = `stored-end-${endMaterializations}`;
      events.push({
        id: eventId,
        tripId: TRIP_ID,
        type: 'expressway_end',
        ts: input.occurredAt ?? '2026-08-23T00:02:05.000Z',
        syncStatus: 'pending',
        extras: {
          expresswaySessionId: 'expressway-session',
          autoDecision: input.autoDecision as unknown as Record<string, unknown>,
        },
      });
      return { eventId, created: true };
    },
    setPendingPrompt: async (prompt: { promptId?: string }) => {
      const id = prompt.promptId ?? '';
      if (!pendingPromptIds.has(id)) {
        pendingPromptIds.add(id);
        promptMaterializations += 1;
      }
    },
    clearPendingPrompt: async () => undefined,
    clearPendingPromptIfMatches: async () => true,
    clearPendingKeepDecision: async () => {
      keepDecisionClears += 1;
      return true;
    },
    setPendingDecision: async (decision: { nativeDetectionId?: string }) => {
      const id = decision.nativeDetectionId ?? '';
      if (!pendingDecisionIds.has(id)) {
        pendingDecisionIds.add(id);
        decisionMaterializations += 1;
      }
    },
    enqueueIcResolution: () => {
      enqueueCalls += 1;
    },
  };
  return {
    queued,
    events,
    generations,
    acknowledgements,
    dependencies,
    counts: () => ({
      startMaterializations,
      endMaterializations,
      promptMaterializations,
      decisionMaterializations,
      keepDecisionClears,
      enqueueCalls,
    }),
  };
}

async function run() {
  const normalized = normalizeNativeResidentExpresswayEvent(nativeEvent('start', 1));
  assertEqual(normalized?.generation, 1, 'native generation is retained');
  assertEqual(normalized?.geo.lon, 139.76, 'native lon remains bridge-shaped');
  assertEqual(
    normalizeNativeResidentExpresswayEvent({ ...nativeEvent('start', 1), generation: 0 }),
    null,
    'non-positive native generations are rejected',
  );

  {
    const harness = createHarness({ queued: [nativeEvent('start', 1)] });
    const result = await drainNativeResidentExpresswayEventQueue({
      enabled: true,
      dependencies: harness.dependencies,
    });
    assertEqual(result.materialized, 1, 'confirmed native start is materialized');
    assertEqual(result.acknowledged, 1, 'start is acked after persistence');
    assertEqual(harness.counts().startMaterializations, 1, 'start is stored once');
    assertEqual(harness.counts().enqueueCalls, 1, 'start schedules durable IC resolution');
    assertEqual(harness.generations.get(TRIP_ID), 1, 'start advances durable generation');
  }

  {
    const event = nativeEvent('start', 2, 'process-kill-start');
    const harness = createHarness({ queued: [event] });
    const realAdvance = harness.dependencies.advanceGeneration;
    let failAdvance = true;
    harness.dependencies.advanceGeneration = async (...args) => {
      if (failAdvance) {
        failAdvance = false;
        throw new Error('simulated process death');
      }
      return realAdvance(...args);
    };
    let firstFailed = false;
    try {
      await drainNativeResidentExpresswayEventQueue({
        enabled: true,
        dependencies: harness.dependencies,
      });
    } catch {
      firstFailed = true;
    }
    assertEqual(firstFailed, true, 'crash before generation/ack leaves native start queued');
    assertEqual(harness.acknowledgements.length, 0, 'failed handoff does not ack');
    await drainNativeResidentExpresswayEventQueue({
      enabled: true,
      dependencies: harness.dependencies,
    });
    assertEqual(harness.counts().startMaterializations, 1, 'cold replay does not duplicate start');
    assertEqual(harness.acknowledgements.length, 1, 'cold replay eventually acks start');
  }

  {
    const end = nativeEvent('decision_end', 5, 'native-end-5');
    const staleStart = {
      ...nativeEvent('start', 4, 'native-start-4'),
      detectedAt: '2026-08-23T00:03:00.000Z',
    };
    const harness = createHarness({
      queued: [end, staleStart],
      events: [tripStart(), expresswayStart()],
    });
    const result = await drainNativeResidentExpresswayEventQueue({
      enabled: true,
      dependencies: harness.dependencies,
    });
    assertEqual(result.materialized, 1, 'newest end decision is materialized');
    assertEqual(result.terminal, 1, 'older pending start is terminal after end generation');
    assertEqual(harness.counts().endMaterializations, 1, 'end event is stored once');
    assertEqual(harness.counts().startMaterializations, 0, 'old strong start cannot reopen expressway');
    assertEqual(harness.acknowledgements.join(','), 'native-end-5,native-start-4', 'FIFO ack order is kept');
  }

  {
    const event = nativeEvent('decision_end', 7, 'process-kill-end');
    const harness = createHarness({
      queued: [event],
      events: [tripStart(), expresswayStart()],
    });
    const realAdvance = harness.dependencies.advanceGeneration;
    let failAdvance = true;
    harness.dependencies.advanceGeneration = async (...args) => {
      if (failAdvance) {
        failAdvance = false;
        throw new Error('simulated process death');
      }
      return realAdvance(...args);
    };
    try {
      await drainNativeResidentExpresswayEventQueue({
        enabled: true,
        dependencies: harness.dependencies,
      });
    } catch {
      // expected
    }
    await drainNativeResidentExpresswayEventQueue({
      enabled: true,
      dependencies: harness.dependencies,
    });
    assertEqual(harness.counts().endMaterializations, 1, 'native end action is exactly-once after replay');
    assertEqual(harness.counts().decisionMaterializations, 0, 'end action cannot leak a generic pending decision');
    assertEqual(harness.acknowledgements.length, 1, 'replayed action is acknowledged once');
  }

  {
    const restStart: AppEvent = {
      id: 'rest-start',
      tripId: TRIP_ID,
      type: 'rest_start',
      ts: '2026-08-23T00:01:30.000Z',
      syncStatus: 'pending',
      extras: { restSessionId: 'rest-session' },
    };
    const harness = createHarness({
      queued: [nativeEvent('end_prompt', 2), nativeEvent('decision_keep', 3)],
      events: [tripStart(), expresswayStart(), restStart],
    });
    const result = await drainNativeResidentExpresswayEventQueue({
      enabled: true,
      dependencies: harness.dependencies,
    });
    assertEqual(result.deferred, 1, 'rest defers native transitions at the FIFO head');
    assertEqual(result.acknowledged, 0, 'deferred head and following events remain native-owned');
    assertEqual(harness.counts().promptMaterializations, 0, 'rest does not create an end prompt');
  }

  {
    const harness = createHarness({
      queued: [nativeEvent('start', 1)],
      activeTripId: null,
    });
    const result = await drainNativeResidentExpresswayEventQueue({
      enabled: true,
      dependencies: harness.dependencies,
    });
    assertEqual(result.terminal, 1, 'signed-out or inactive trip transition is terminal');
    assertEqual(result.acknowledged, 1, 'inactive trip cannot poison the native queue');
    assertEqual(harness.counts().startMaterializations, 0, 'inactive trip is never reopened');
  }

  {
    const pendingStart = nativeEvent('start', 1, 'trip-end-start');
    const pendingPrompt = {
      ...nativeEvent('end_prompt', 2, 'trip-end-prompt'),
      detectedAt: '2026-08-23T00:02:20.000Z',
    };
    const pendingDecision = {
      ...nativeEvent('decision_end', 3, 'trip-end-decision'),
      detectedAt: '2026-08-23T00:02:20.000Z',
      decidedAt: '2026-08-23T00:02:25.000Z',
    };
    const harness = createHarness({
      queued: [pendingStart, pendingPrompt, pendingDecision],
    });
    const result = await prepareNativeExpresswayEventsForTripEnd({
      enabled: true,
      tripId: TRIP_ID,
      dependencies: harness.dependencies,
    });
    assertEqual(result.acknowledged, 3, 'trip close drains pending start, prompt, and decision');
    assertEqual(harness.counts().startMaterializations, 1, 'trip close persists pending start first');
    assertEqual(harness.counts().promptMaterializations, 1, 'trip close persists pending prompt');
    assertEqual(harness.counts().keepDecisionClears, 1, 'new prompt retires only prior keep suppression');
    assertEqual(harness.counts().endMaterializations, 1, 'trip close persists pending end action');
    assertEqual(harness.queued.length, 0, 'trip can close only after native FIFO is empty');
  }

  {
    const harness = createHarness({
      queued: [nativeEvent('start', 1, 'mismatched-trip-start')],
      activeTripId: 'newer-active-trip',
    });
    let failedClosed = false;
    try {
      await prepareNativeExpresswayEventsForTripEnd({
        enabled: true,
        tripId: TRIP_ID,
        dependencies: harness.dependencies,
      });
    } catch {
      failedClosed = true;
    }
    assertEqual(failedClosed, true, 'active trip mismatch blocks the destructive trip close');
    assertEqual(harness.acknowledgements.length, 0, 'mismatch never terminal-acks a pending transition');
    assertEqual(harness.queued.length, 1, 'mismatched transition remains available after restart');
  }

  {
    const harness = createHarness({ queued: [nativeEvent('start', 1, 'trip-end-retry')] });
    const realAcknowledge = harness.dependencies.acknowledge;
    let failAcknowledge = true;
    harness.dependencies.acknowledge = async ids => {
      if (failAcknowledge) {
        failAcknowledge = false;
        throw new Error('simulated WebView termination before native ack');
      }
      return realAcknowledge(ids);
    };
    let firstFailed = false;
    try {
      await prepareNativeExpresswayEventsForTripEnd({
        enabled: true,
        tripId: TRIP_ID,
        dependencies: harness.dependencies,
      });
    } catch {
      firstFailed = true;
    }
    assertEqual(firstFailed, true, 'ack failure blocks trip close');
    assertEqual(harness.queued.length, 1, 'unacked transition survives process restart');
    await prepareNativeExpresswayEventsForTripEnd({
      enabled: true,
      tripId: TRIP_ID,
      dependencies: harness.dependencies,
    });
    assertEqual(harness.counts().startMaterializations, 1, 'restart retry cannot duplicate the start');
    assertEqual(harness.queued.length, 0, 'restart retry safely completes native ack');
  }

  {
    const staleStart = {
      ...nativeEvent('start', 3),
      detectedAt: '2026-08-23T00:00:30.000Z',
    };
    const priorEnd: AppEvent = {
      id: 'prior-end',
      tripId: TRIP_ID,
      type: 'expressway_end',
      ts: '2026-08-23T00:01:30.000Z',
      syncStatus: 'pending',
      extras: { expresswaySessionId: 'older-session' },
    };
    const harness = createHarness({
      queued: [staleStart],
      events: [tripStart(), expresswayStart(), priorEnd],
    });
    const result = await drainNativeResidentExpresswayEventQueue({
      enabled: true,
      dependencies: harness.dependencies,
    });
    assertEqual(result.terminal, 1, 'event timestamp watermark rejects cold stale starts');
    assertEqual(harness.counts().startMaterializations, 0, 'stale timestamp cannot recreate start');
  }

  {
    const priorNativeStart = {
      ...expresswayStart('native-start-4', 'native-start-4', 4),
      ts: '2026-08-23T02:00:00.000Z',
    };
    const priorNativeEnd: AppEvent = {
      id: 'native-end-5',
      tripId: TRIP_ID,
      type: 'expressway_end',
      ts: '2026-08-23T02:10:00.000Z',
      syncStatus: 'pending',
      extras: {
        expresswaySessionId: 'expressway-session',
        autoDecision: { nativeDetectionId: 'native-end-5', nativeGeneration: 5 },
      },
    };
    const afterWallRollback = {
      ...nativeEvent('start', 6, 'native-start-6'),
      detectedAt: '2026-08-23T01:30:00.000Z',
    };
    const harness = createHarness({
      queued: [afterWallRollback],
      events: [tripStart(), priorNativeStart, priorNativeEnd],
    });
    const result = await drainNativeResidentExpresswayEventQueue({
      enabled: true,
      dependencies: harness.dependencies,
    });
    assertEqual(result.materialized, 1, 'newer native generation survives wall-clock rollback');
    assertEqual(harness.counts().startMaterializations, 1, 'generation, not wall time, owns native order');
  }

  {
    const newerStart = {
      ...expresswayStart('newer-start-10', 'newer-start-10', 10),
      ts: '2026-08-23T00:05:00.000Z',
    };
    const staleDecision = {
      ...nativeEvent('decision_end', 9, 'old-decision-9'),
      detectedAt: '2026-08-23T00:04:00.000Z',
      decidedAt: '2026-08-23T00:10:00.000Z',
    };
    const harness = createHarness({
      queued: [staleDecision],
      events: [tripStart(), newerStart],
    });
    const result = await drainNativeResidentExpresswayEventQueue({
      enabled: true,
      dependencies: harness.dependencies,
    });
    assertEqual(result.terminal, 1, 'old notification decision is terminal after a newer generation');
    assertEqual(harness.counts().endMaterializations, 0, 'old action cannot end the newer session');
    assertEqual(harness.counts().decisionMaterializations, 0, 'old action cannot leak to generic Supervisor');
  }

  console.log('nativeExpresswayEventHandoff: 41 tests passed');
}

void run().catch(error => {
  globalThis.setTimeout(() => {
    throw error;
  }, 0);
});
