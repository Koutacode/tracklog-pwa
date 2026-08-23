import assert from 'node:assert/strict';
import { MAX_FUTURE_POINT_SKEW_MS, MAX_STALE_POINT_AGE_MS } from './routeTracking';
import { resolveLocationHeartbeatPayload } from './locationHeartbeatPolicy';

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
