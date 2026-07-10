import assert from 'node:assert/strict';
import {
  inferSpeedKmh,
  normalizeRoutePointAccuracy,
  normalizeRoutePointHeading,
  normalizeRoutePointSpeed,
} from './routePointTelemetry';

assert.equal(inferSpeedKmh(100, 10_000), 36);
assert.equal(inferSpeedKmh(1_000, 60_000), 60);
assert.equal(inferSpeedKmh(0, 5_000), 0);
assert.equal(inferSpeedKmh(-1, 5_000), null);
assert.equal(inferSpeedKmh(100, 0), null);

assert.equal(normalizeRoutePointSpeed(12.5), 12.5);
assert.equal(normalizeRoutePointSpeed('15'), 15);
assert.equal(normalizeRoutePointSpeed(500), 500);
assert.equal(normalizeRoutePointSpeed(500.01), null);
assert.equal(normalizeRoutePointSpeed(-1), null);
assert.equal(normalizeRoutePointSpeed(Number.POSITIVE_INFINITY), null);
assert.equal(normalizeRoutePointSpeed(null), null);

assert.equal(normalizeRoutePointAccuracy(0), 0);
assert.equal(normalizeRoutePointAccuracy(100_000), 100_000);
assert.equal(normalizeRoutePointAccuracy(100_001), null);
assert.equal(normalizeRoutePointAccuracy(undefined), null);

assert.equal(normalizeRoutePointHeading(0), 0);
assert.equal(normalizeRoutePointHeading(360), 360);
assert.equal(normalizeRoutePointHeading(361), null);
assert.equal(normalizeRoutePointHeading(-0.1), null);

console.log('routePointTelemetry: 20 tests passed');
