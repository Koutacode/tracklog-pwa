import assert from 'node:assert/strict';
import {
  createRemoteSyncScheduler,
  IMPORTANT_SYNC_DELAY_MS,
  ROUTE_SYNC_BATCH_SIZE,
} from './remoteSyncScheduler';

class Clock {
  now = 0;
  nextId = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  setTimer = (callback: () => void, delayMs: number) => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.now + delayMs, callback });
    return id;
  };
  clearTimer = (id: number) => { this.timers.delete(id); };
  advanceTo(at: number) {
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= at)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.now = at;
  }
}

function harness() {
  const clock = new Clock();
  const syncs: { reason: string; at: number }[] = [];
  const scheduler = createRemoteSyncScheduler({
    sync: reason => { syncs.push({ reason, at: clock.now }); },
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const point = () => {
    scheduler.request('route-points-create');
    scheduler.request('route-point');
  };
  return { clock, syncs, scheduler, point };
}

{
  const { clock, syncs, point } = harness();
  for (let second = 0; second < 30; second += 5) {
    clock.advanceTo(second * 1000);
    point();
  }
  clock.advanceTo(29_999);
  assert.equal(syncs.length, 0, 'routine route points are batched');
  clock.advanceTo(30_000);
  assert.deepEqual(syncs.map(sync => sync.at), [30_000], 'later points cannot postpone the first deadline');
}

{
  const { clock, syncs, scheduler, point } = harness();
  point();
  clock.advanceTo(2_000);
  scheduler.request('event-expressway_start');
  clock.advanceTo(2_500);
  point();
  clock.advanceTo(3_200);
  assert.deepEqual(syncs, [{ reason: 'event-expressway_start', at: 3_200 }]);
  clock.advanceTo(40_000);
  assert.equal(syncs.length, 1, 'the superseded route timer cannot issue an extra pull');
}

for (const reason of ['trip-end', 'events-update', 'report-save', 'trip-tombstone-create', 'route-points-delete']) {
  const { clock, syncs, scheduler, point } = harness();
  point();
  scheduler.request(reason);
  clock.advanceTo(IMPORTANT_SYNC_DELAY_MS);
  assert.equal(syncs[0]?.reason, reason, `${reason} retains the important-mutation deadline`);
}

{
  const { clock, syncs, point } = harness();
  for (let count = 0; count < ROUTE_SYNC_BATCH_SIZE - 1; count += 1) point();
  clock.advanceTo(IMPORTANT_SYNC_DELAY_MS);
  assert.equal(syncs.length, 0, 'duplicate hook/repository signals do not double the count');
  point();
  clock.advanceTo(IMPORTANT_SYNC_DELAY_MS * 2);
  assert.equal(syncs.length, 1, '100 route mutations bring the batch forward');
}

{
  const { clock, syncs, scheduler, point } = harness();
  point();
  scheduler.cancel(); // poll, manual, online, lifecycle flush, or unmount
  clock.advanceTo(60_000);
  assert.equal(syncs.length, 0, 'an external flush/unmount cancels the pending timer');
  point();
  clock.advanceTo(90_000);
  assert.equal(syncs.length, 1, 'new mutations can schedule after an external flush');
}

function simulateHour(pointIntervalMs: number, optimized: boolean) {
  const clock = new Clock();
  let pendingPoints = 0;
  let savedPoints = 0;
  let rpcCalls = 0;
  let syncRuns = 0;
  let legacyTimer: number | null = null;
  const scheduler = createRemoteSyncScheduler({
    sync: () => flush(), now: () => clock.now,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  function flush() {
    syncRuns += 1;
    if (optimized) scheduler.cancel();
    // Successful response, no remote backlog: the previous loop sent one
    // terminal empty pull after mutations. The protocol test verifies removal.
    rpcCalls += pendingPoints > 0 && !optimized ? 2 : 1;
    savedPoints += pendingPoints;
    pendingPoints = 0;
  }
  function poll() {
    flush();
    if (clock.now < 3_600_000) clock.setTimer(poll, 45_000);
  }
  clock.setTimer(poll, 45_000);
  for (let at = 0; at < 3_600_000; at += pointIntervalMs) {
    clock.advanceTo(at);
    pendingPoints += 1;
    for (const reason of ['route-points-create', 'route-point']) {
      if (optimized) scheduler.request(reason);
      else {
        if (legacyTimer !== null) clock.clearTimer(legacyTimer);
        legacyTimer = clock.setTimer(() => { legacyTimer = null; flush(); }, 1_200);
      }
    }
  }
  clock.advanceTo(3_600_000);
  assert.equal(pendingPoints, 0);
  return { savedPoints, syncRuns, rpcCalls };
}

for (const pointIntervalMs of [5_000, 10_000, 20_000]) {
  const before = simulateHour(pointIntervalMs, false);
  const after = simulateHour(pointIntervalMs, true);
  assert.equal(after.savedPoints, before.savedPoints, 'batching retains every route point');
  assert.ok(after.rpcCalls < before.rpcCalls);
  console.log(JSON.stringify({ simulation: 'one-hour-route-only-45s-poll', pointIntervalMs, before, after }));
}
console.log('remoteSyncScheduler tests passed');
