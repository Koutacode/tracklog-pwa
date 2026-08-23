import type { NativeResidentRoutePoint } from '../app/nativeResidentLocationPolicy';
import { drainNativeResidentRoutePointQueue } from '../app/nativeResidentLocationPolicy';
import type { NativeResidentLocationPoint } from './nativeResidentLocation';
import {
  createMemoryQueueStorage,
  createNativeExpresswayDetectionWorkQueue,
} from './nativeExpresswayDetectionQueue';

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function nativePoint(id: string): NativeResidentLocationPoint {
  return {
    id,
    tripId: 'trip-queue',
    ts: `2026-08-23T00:00:${id.endsWith('2') ? '10' : '00'}.000Z`,
    lat: 35.68,
    lng: 139.76,
    accuracy: 8,
    speed: 20,
    heading: 90,
    source: 'background',
    provider: 'gps',
    monotonicSessionId: 'boot-queue',
    elapsedRealtimeMs: id.endsWith('2') ? 20_000 : 10_000,
  };
}

async function run() {
  const storage = createMemoryQueueStorage();
  const stored = new Map<string, NativeResidentRoutePoint>();
  let releaseNetwork!: () => void;
  let markNetworkStarted!: () => void;
  const networkStarted = new Promise<void>(resolve => {
    markNetworkStarted = resolve;
  });
  const delayedNetwork = new Promise<void>(resolve => {
    releaseNetwork = resolve;
  });
  let delayedProcessCalls = 0;
  const workQueue = createNativeExpresswayDetectionWorkQueue({
    storage,
    loadPoint: async id => stored.get(id) ?? null,
    getActiveTripId: async () => 'trip-queue',
    processPoint: async () => {
      delayedProcessCalls += 1;
      markNetworkStarted();
      await delayedNetwork;
      return 'processed';
    },
  });
  let acknowledged = false;
  const drain = drainNativeResidentRoutePointQueue({
    enabled: true,
    peek: async () => ({ points: [nativePoint('point-1')], remaining: 0 }),
    addRoutePoint: async point => {
      stored.set(point.id, point);
    },
    onPersistedPoint: async point => {
      workQueue.enqueue({ activeTripId: 'trip-queue', point });
    },
    acknowledge: async () => {
      acknowledged = true;
      return { remaining: 0 };
    },
  });
  await networkStarted;
  const drainResult = await Promise.race([
    drain.then(() => 'drained' as const),
    new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 100)),
  ]);
  assertEqual(drainResult, 'drained', 'slow Edge work does not block native queue drain');
  assertEqual(acknowledged, true, 'native point is acked while Edge worker remains in flight');
  assertEqual(workQueue.pendingCount(), 1, 'in-flight point remains durably queued');
  releaseNetwork();
  const sameFlightA = workQueue.runPending();
  const sameFlightB = workQueue.runPending();
  assertEqual(sameFlightA, sameFlightB, 'worker exposes one shared in-flight promise');
  await sameFlightA;
  assertEqual(delayedProcessCalls, 1, 'single-flight worker processes the head once');
  assertEqual(workQueue.pendingCount(), 0, 'completed Edge work removes the durable item');

  const retryStorage = createMemoryQueueStorage();
  const retryStored = new Map<string, NativeResidentRoutePoint>();
  const retryPoint: NativeResidentRoutePoint = {
    id: 'point-retry',
    tripId: 'trip-queue',
    ts: '2026-08-23T00:01:00.000Z',
    lat: 35.68,
    lng: 139.76,
    accuracy: 8,
    speed: 20,
    heading: 90,
    source: 'background',
  };
  retryStored.set(retryPoint.id, retryPoint);
  const scheduledRetries: Array<() => void> = [];
  const firstWorker = createNativeExpresswayDetectionWorkQueue({
    storage: retryStorage,
    loadPoint: async id => retryStored.get(id) ?? null,
    getActiveTripId: async () => 'trip-queue',
    processPoint: async () => 'retry',
    schedule: () => undefined,
    scheduleRetry: task => {
      scheduledRetries.push(task);
    },
  });
  firstWorker.enqueue({ activeTripId: 'trip-queue', point: retryPoint });
  const retryResult = await firstWorker.runPending();
  assertEqual(retryResult.retrying, true, 'temporary Edge failure retains the head item');
  assertEqual(firstWorker.pendingCount(), 1, 'failed work survives worker completion');
  assertEqual(scheduledRetries.length, 1, 'retry uses one bounded backoff wake');

  let recoveredCalls = 0;
  const recoveredWorker = createNativeExpresswayDetectionWorkQueue({
    storage: retryStorage,
    loadPoint: async id => retryStored.get(id) ?? null,
    getActiveTripId: async () => 'trip-queue',
    processPoint: async () => {
      recoveredCalls += 1;
      return 'processed';
    },
    schedule: () => undefined,
  });
  await recoveredWorker.runPending();
  assertEqual(recoveredCalls, 1, 'cold worker resumes the persisted point exactly once');
  assertEqual(recoveredWorker.pendingCount(), 0, 'recovered work is removed after success');

  const boundedStorage = createMemoryQueueStorage();
  const boundedWorker = createNativeExpresswayDetectionWorkQueue({
    storage: boundedStorage,
    loadPoint: async () => null,
    getActiveTripId: async () => 'trip-queue',
    processPoint: async () => 'processed',
    schedule: () => undefined,
    maxEntries: 1,
  });
  boundedWorker.enqueue({ activeTripId: 'trip-queue', point: retryPoint });
  let backpressureThrown = false;
  try {
    boundedWorker.enqueue({
      activeTripId: 'trip-queue',
      point: { ...retryPoint, id: 'point-overflow' },
    });
  } catch {
    backpressureThrown = true;
  }
  assertEqual(backpressureThrown, true, 'bounded backlog throws before native acknowledgement');
  assertEqual(boundedWorker.pendingCount(), 1, 'backpressure never evicts existing work');

  console.log('nativeExpresswayDetectionQueue: 14 tests passed');
}

void run().catch(error => {
  globalThis.setTimeout(() => {
    throw error;
  }, 0);
});
