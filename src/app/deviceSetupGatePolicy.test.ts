import assert from 'node:assert/strict';
import { didActiveTripEnd, shouldShowDeviceSetupGate } from './deviceSetupGatePolicy';

assert.equal(shouldShowDeviceSetupGate({
  approved: true,
  setupReady: false,
  activeTripKnown: true,
  activeTripId: 'active-trip',
}), false, 'an active trip keeps Home visible while setup needs repair');

assert.equal(shouldShowDeviceSetupGate({
  approved: true,
  setupReady: false,
  activeTripKnown: true,
  activeTripId: null,
}), true, 'the next trip stays blocked until setup is repaired');

assert.equal(shouldShowDeviceSetupGate({
  approved: true,
  setupReady: false,
  activeTripKnown: false,
  activeTripId: null,
}), false, 'unknown trip state never flashes the setup gate');

assert.equal(shouldShowDeviceSetupGate({
  approved: true,
  setupReady: true,
  activeTripKnown: true,
  activeTripId: null,
}), false);

const activeTrip = {
  approved: true,
  setupReady: true,
  activeTripKnown: true,
  activeTripId: 'active-trip',
};
assert.equal(shouldShowDeviceSetupGate(activeTrip), false, 'ready active trip shows Home');

const revokedDuringTrip = { ...activeTrip, setupReady: false };
assert.equal(
  shouldShowDeviceSetupGate(revokedDuringTrip),
  false,
  'permission revocation never replaces an active trip with the setup gate',
);
assert.equal(didActiveTripEnd({
  previousKnown: true,
  previousTripId: revokedDuringTrip.activeTripId,
  currentKnown: true,
  currentTripId: null,
}), true, 'ending the trip invalidates stale readiness and requests a fresh snapshot');
assert.equal(shouldShowDeviceSetupGate({
  ...revokedDuringTrip,
  activeTripId: null,
}), true, 'the setup gate appears immediately after the active trip ends');

assert.equal(didActiveTripEnd({
  previousKnown: false,
  previousTripId: null,
  currentKnown: true,
  currentTripId: null,
}), false, 'initial no-trip discovery is not a trip-end transition');

console.log('deviceSetupGatePolicy: active-trip continuity assertions passed');
