import {
  MAX_FUTURE_POINT_SKEW_MS,
  MAX_STALE_POINT_AGE_MS,
  RouteRecordQueue,
  createRouteRecordSession,
  resolveLocationUpdatePayload,
  resolveRoutePointTimestamp,
} from './routeTracking';

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function runAsyncTests() {
  {
    const nowMs = Date.parse('2026-08-23T09:00:00.000Z');
    assertEqual(
      resolveRoutePointTimestamp(nowMs + 2_000, nowMs, null),
      nowMs + 2_000,
      'a normal small provider clock skew remains accepted',
    );
    assertEqual(
      resolveRoutePointTimestamp(nowMs + MAX_FUTURE_POINT_SKEW_MS, nowMs, null),
      nowMs + MAX_FUTURE_POINT_SKEW_MS,
      'the documented one-minute future-skew boundary is accepted',
    );
    assertEqual(
      resolveRoutePointTimestamp(nowMs + MAX_FUTURE_POINT_SKEW_MS + 1, nowMs, null),
      null,
      'a point beyond the future-skew boundary is rejected',
    );
    assertEqual(
      resolveRoutePointTimestamp(Number.NaN, nowMs, null),
      null,
      'a non-finite timestamp is rejected',
    );
    assertEqual(
      resolveRoutePointTimestamp(Number.POSITIVE_INFINITY, nowMs, null),
      null,
      'an infinite timestamp is rejected',
    );
    assertEqual(
      resolveRoutePointTimestamp(nowMs - 1, nowMs, nowMs),
      null,
      'a timestamp older than the last accepted point is rejected',
    );
    assertEqual(
      resolveRoutePointTimestamp(nowMs, nowMs, nowMs),
      null,
      'a duplicate timestamp is rejected',
    );
    assertEqual(
      resolveRoutePointTimestamp(nowMs + 1, nowMs, nowMs),
      nowMs + 1,
      'a monotonic point after the last accepted timestamp remains accepted',
    );
    assertEqual(
      resolveLocationUpdatePayload({
        latitude: 35,
        longitude: 139,
        time: nowMs + MAX_FUTURE_POINT_SKEW_MS + 1,
      }, 'foreground', nowMs, null),
      null,
      'a future point is rejected before any location listener can receive it',
    );
    assertEqual(
      resolveLocationUpdatePayload({
        latitude: 35,
        longitude: 139,
        time: nowMs - MAX_STALE_POINT_AGE_MS - 1,
      }, 'foreground', nowMs, null),
      null,
      'a stale point is rejected before any location listener can receive it',
    );
    assertEqual(
      resolveLocationUpdatePayload({ latitude: Number.NaN, longitude: 139, time: nowMs }, 'foreground', nowMs, null),
      null,
      'non-finite coordinates are rejected before listener emission',
    );
    assertEqual(
      resolveLocationUpdatePayload({ latitude: 35, longitude: 139, time: nowMs }, 'foreground', nowMs, nowMs),
      null,
      'a non-monotonic stream point is rejected before listener emission',
    );
    assertEqual(
      resolveLocationUpdatePayload({ latitude: 35, longitude: 139, time: nowMs + 1 }, 'foreground', nowMs, nowMs)?.payload.time,
      nowMs + 1,
      'a normal monotonic point reaches listeners with its validated timestamp',
    );
  }

  {
    const oldWrite = deferred();
    const writes: string[] = [];
    const oldQueue = new RouteRecordQueue<string>('trip-old', 1, async (tripId, payload) => {
      await oldWrite.promise;
      writes.push(`${tripId}:${payload}`);
    });
    const newQueue = new RouteRecordQueue<string>('trip-new', 2, async (tripId, payload) => {
      writes.push(`${tripId}:${payload}`);
    });

    oldQueue.enqueue('old-point');
    const oldDrain = oldQueue.closeAndDrain();
    oldQueue.enqueue('late-old-callback');
    await newQueue.enqueue('new-point');

    assertEqual(
      writes.join(','),
      'trip-new:new-point',
      'a new trip can write without inheriting the blocked old trip queue',
    );
    oldWrite.resolve();
    await oldDrain;
    assertEqual(
      writes.sort().join(','),
      'trip-new:new-point,trip-old:old-point',
      'accepted old points retain their captured trip and callbacks after close are ignored',
    );
  }

  {
    const firstWrite = deferred();
    const writes: string[] = [];
    const queue = new RouteRecordQueue<number>('trip-drain', 3, async (tripId, payload) => {
      if (payload === 1) await firstWrite.promise;
      writes.push(`${tripId}:${payload}`);
    });
    queue.enqueue(1);
    queue.enqueue(2);
    let drained = false;
    const drain = queue.closeAndDrain().then(() => {
      drained = true;
    });

    await Promise.resolve();
    assertEqual(drained, false, 'stop drain waits for a delayed accepted write');
    firstWrite.resolve();
    await drain;
    assertEqual(
      writes.join(','),
      'trip-drain:1,trip-drain:2',
      'accepted points drain serially before stop completes',
    );
  }

  {
    const writes: number[] = [];
    const queue = new RouteRecordQueue<number>('trip-recovery', 4, async (_tripId, payload) => {
      if (payload === 1) throw new Error('simulated storage failure');
      writes.push(payload);
    });
    const outcomes = await Promise.allSettled([queue.enqueue(1), queue.enqueue(2)]);
    await queue.closeAndDrain();
    assertEqual(outcomes[0].status, 'rejected', 'the failed enqueue caller observes its storage failure');
    assertEqual(outcomes[1].status, 'fulfilled', 'a later enqueue still completes after the failure');
    assertEqual(
      writes.join(','),
      '2',
      'one failed write does not poison subsequent writes in the session queue',
    );
  }

  {
    const baseMs = Date.now();
    let attempts = 0;
    const saved: Array<{ ts: string; speed?: number | null }> = [];
    const session = createRouteRecordSession('trip-durable-baseline', 'precision', async point => {
      attempts += 1;
      if (attempts === 1) throw new Error('simulated Dexie failure');
      saved.push({ ts: point.ts, speed: point.speed });
    });
    const first = await Promise.allSettled([
      session.queue.enqueue({
        lat: 35,
        lng: 139,
        accuracy: 5,
        speed: 10,
        heading: null,
        time: baseMs,
        source: 'foreground',
      }),
    ]);
    assertEqual(first[0].status, 'rejected', 'the first failed durable write remains observable');
    await session.queue.enqueue({
      lat: 35.000001,
      lng: 139.000001,
      accuracy: 5,
      speed: 20,
      heading: null,
      time: baseMs + 1_000,
      source: 'foreground',
    });
    await session.queue.closeAndDrain();
    assertEqual(attempts, 2, 'an unsaved nearby point does not become the next point filtering baseline');
    assertEqual(saved.length, 1, 'the normal point after failure is durably written');
    assertEqual(
      Math.round((saved[0].speed ?? 0) * 10) / 10,
      20,
      'failed-point smoothing does not distort the next durable speed',
    );
  }

  {
    const blockedWrite = deferred();
    const writes: string[] = [];
    let drops = 0;
    const queue = new RouteRecordQueue<string>(
      'trip-capacity',
      5,
      async (_tripId, payload) => {
        await blockedWrite.promise;
        writes.push(payload);
      },
      1,
      () => {
        drops += 1;
      },
    );
    queue.enqueue('accepted');
    queue.enqueue('dropped');
    blockedWrite.resolve();
    await queue.closeAndDrain();
    assertEqual(writes.join(','), 'accepted', 'a saturated queue does not exceed its bound');
    assertEqual(drops, 1, 'queue saturation reports one dropped point without exposing its payload');
  }

  console.log('routeTracking: timestamp, listener, durable-state, and queue-boundary assertions passed');
}

void runAsyncTests().catch(error => {
  globalThis.setTimeout(() => {
    throw error;
  }, 0);
});
