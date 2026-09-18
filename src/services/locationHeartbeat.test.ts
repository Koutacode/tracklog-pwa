import assert from 'node:assert/strict';
import { MAX_FUTURE_POINT_SKEW_MS, MAX_STALE_POINT_AGE_MS } from './routeTracking';
import { requestLocationHeartbeatForActiveTrip, resolveLocationHeartbeatPayload } from './locationHeartbeatPolicy';
import { createLocationHeartbeatSubscription } from './locationHeartbeatSubscription';

const nowMs = Date.parse('2026-08-23T10:00:00.000Z');
const base = {
  lat: 35.68,
  lng: 139.76,
  accuracy: 8,
  speed: 0,
  heading: null,
  source: 'foreground' as const,
};

assert.equal(
  resolveLocationHeartbeatPayload({ ...base, time: nowMs + MAX_FUTURE_POINT_SKEW_MS + 1 }, nowMs, null),
  null,
  'future provider timestamps never reach the cloud heartbeat',
);
assert.equal(
  resolveLocationHeartbeatPayload({ ...base, time: nowMs - MAX_STALE_POINT_AGE_MS - 1 }, nowMs, null),
  null,
  'stale provider timestamps never reach the cloud heartbeat',
);
assert.equal(
  resolveLocationHeartbeatPayload({ ...base, time: nowMs }, nowMs, nowMs),
  null,
  'out-of-order or duplicate provider timestamps never reach the cloud heartbeat',
);
assert.equal(
  resolveLocationHeartbeatPayload({ ...base, lat: Number.NaN, time: nowMs }, nowMs, null),
  null,
  'non-finite coordinates never reach the cloud heartbeat',
);
assert.deepEqual(
  resolveLocationHeartbeatPayload({ ...base, time: nowMs + 2_000 }, nowMs, nowMs),
  { ...base, time: nowMs + 2_000 },
  'a normal small clock skew keeps the complete location-sharing payload eligible for upload',
);

console.log('locationHeartbeat: future, stale, ordering, coordinate, and normal assertions passed');

function testAutomaticHeartbeatOwnership() {
  const point = { ...base, time: nowMs };
  for (const nativeOwnsHeartbeat of [true, false]) {
    const listeners = new Set<(location: typeof point) => void>();
    let subscriptions = 0;
    let sends = 0;
    let starts = 0;
    const automatic = createLocationHeartbeatSubscription({
      nativeOwnsHeartbeat: () => nativeOwnsHeartbeat,
      subscribe: listener => {
        subscriptions += 1;
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      onStart: () => { starts += 1; },
      onLocation: () => { sends += 1; },
    });
    for (let tick = 0; tick < 4; tick += 1) automatic.start();
    for (const listener of listeners) listener(point);
    assert.equal(subscriptions, nativeOwnsHeartbeat ? 0 : 1,
      'Android must not subscribe; repeated PWA supervisor ticks retain one subscription');
    assert.equal(sends, nativeOwnsHeartbeat ? 0 : 1,
      'the automatic Android path never reaches Web sending while PWA still receives updates');
    assert.equal(starts, nativeOwnsHeartbeat ? 0 : 1,
      'ongoing PWA subscriptions must retain their timestamp ordering state');
    automatic.stop();
    assert.equal(listeners.size, 0, 'stopping removes the source listener');
    automatic.start();
    assert.equal(subscriptions, nativeOwnsHeartbeat ? 0 : 2, 'PWA can resume after stop');
    automatic.stop();
  }
}

testAutomaticHeartbeatOwnership();
console.log('locationHeartbeat: native ownership, PWA stream, repeated start, and stop/resume assertions passed');

async function testExplicitRequestIsBoundToActiveTrip() {
  for (const [initialTrip, resultingTrip, expectedAcquisitions, expectedSends] of [
    [null, null, 0, 0],
    ['trip-a', 'trip-a', 1, 1],
    ['trip-a', null, 1, 0],
    ['trip-a', 'trip-b', 1, 0],
  ] as const) {
    let currentTrip: string | null = initialTrip;
    let acquisitions = 0;
    let sends = 0;
    await requestLocationHeartbeatForActiveTrip({
      getActiveTripId: async () => currentTrip,
      acquireLocation: async () => {
        acquisitions += 1;
        currentTrip = resultingTrip;
        return { ...base, time: nowMs };
      },
      send: async (_location, tripId) => {
        assert.equal(tripId, initialTrip);
        sends += 1;
      },
    });
    assert.equal(acquisitions, expectedAcquisitions, 'explicit location requests cannot start GPS outside a trip');
    assert.equal(sends, expectedSends, 'trip end/switch invalidates a pending location request');
  }
}

void testExplicitRequestIsBoundToActiveTrip().then(() => {
  console.log('locationHeartbeat: explicit request trip gating and end/switch races passed');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
