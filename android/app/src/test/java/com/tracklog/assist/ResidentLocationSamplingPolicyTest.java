package com.tracklog.assist;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

public class ResidentLocationSamplingPolicyTest {
    @Test
    public void coldIdleAndRepeatedIdleDoNotSubscribeEvenAfterProviderBroadcasts() {
        ResidentLocationSamplingPolicy policy = new ResidentLocationSamplingPolicy();
        FakeRegistration registration = new FakeRegistration();
        for (int i = 0; i < 10; i++) assertFalse(policy.reconcile(null, registration));
        assertEquals(0, registration.starts);
        assertEquals(0, registration.stops);
        assertNull(policy.current());
    }

    @Test
    public void routineWebReconcilePreservesListenerAndRecordingCadence() {
        ResidentLocationSamplingPolicy policy = new ResidentLocationSamplingPolicy();
        FakeRegistration registration = new FakeRegistration();
        ResidentLocationSamplingPolicy.Request original = request("trip", true, true);
        assertTrue(policy.reconcile(original, registration));
        for (int i = 0; i < 100; i++) {
            assertFalse(policy.reconcile(request("trip", true, true), registration));
        }
        assertEquals(1, registration.starts);
        assertEquals(0, registration.stops);
        assertSame(original, policy.current());
        assertTrue(original.gpsAvailable);
        assertTrue(original.networkAvailable);
        assertEquals(10_000L, ResidentLocationSamplingPolicy.RECORDING_INTERVAL_MS);
        assertEquals(0f, ResidentLocationSamplingPolicy.MIN_DISTANCE_METERS, 0f);
    }

    @Test
    public void tripEndInvalidatesQueuedFixBeforeUnsubscribingAndDoesNotRestartInIdle() {
        ResidentLocationSamplingPolicy policy = new ResidentLocationSamplingPolicy();
        ResidentLocationSamplingPolicy.Request trip = request("trip", true, true);
        FakeRegistration registration = new FakeRegistration() {
            @Override
            public void stop() {
                assertFalse(policy.accepts(trip, "trip"));
                super.stop();
            }
        };
        policy.reconcile(trip, registration);
        // State is written by the bridge before the main-thread service reconcile arrives.
        assertFalse(policy.accepts(trip, ""));
        assertTrue(policy.reconcile(null, registration));
        assertFalse(policy.reconcile(null, registration));
        assertEquals(1, registration.starts);
        assertEquals(1, registration.stops);
    }

    @Test
    public void anotherTripCannotConsumeQueuedFixEvenBeforeMainThreadReconciles() {
        ResidentLocationSamplingPolicy policy = new ResidentLocationSamplingPolicy();
        FakeRegistration registration = new FakeRegistration();
        ResidentLocationSamplingPolicy.Request first = request("first", true, true);
        ResidentLocationSamplingPolicy.Request second = request("second", true, true);
        policy.reconcile(first, registration);
        assertFalse(policy.accepts(first, "second"));
        policy.reconcile(second, registration);
        assertFalse(policy.accepts(first, "first"));
        assertTrue(policy.accepts(second, "second"));
        assertEquals(2, registration.starts);
        assertEquals(1, registration.stops);
    }

    @Test
    public void locationOffOnInvalidatesOldGenerationEvenForTheSameTrip() {
        ResidentLocationSamplingPolicy policy = new ResidentLocationSamplingPolicy();
        FakeRegistration registration = new FakeRegistration();
        ResidentLocationSamplingPolicy.Request beforeOff = request("trip", true, true);
        policy.reconcile(beforeOff, registration);
        policy.reconcile(null, registration);
        ResidentLocationSamplingPolicy.Request afterOn = request("trip", true, true);
        policy.reconcile(afterOn, registration);
        assertFalse(policy.accepts(beforeOff, "trip"));
        assertTrue(policy.accepts(afterOn, "trip"));
        assertEquals(2, registration.starts);
        assertEquals(1, registration.stops);
    }

    @Test
    public void actualProviderStateChangesReregisterOnceButDuplicateBroadcastsDoNot() {
        ResidentLocationSamplingPolicy policy = new ResidentLocationSamplingPolicy();
        FakeRegistration registration = new FakeRegistration();
        policy.reconcile(request("trip", true, true), registration);
        assertTrue(policy.reconcile(request("trip", false, true), registration));
        assertFalse(policy.reconcile(request("trip", false, true), registration));
        assertTrue(policy.reconcile(request("trip", true, true), registration));
        assertFalse(policy.reconcile(request("trip", true, true), registration));
        assertEquals(3, registration.starts);
        assertEquals(2, registration.stops);
    }

    @Test
    public void newlyAvailableProviderAndNewServiceCannotReuseAnOldSubscription() {
        ResidentLocationSamplingPolicy policy = new ResidentLocationSamplingPolicy();
        FakeRegistration registration = new FakeRegistration();
        policy.reconcile(new ResidentLocationSamplingPolicy.Request("trip", true, true, false, false), registration);
        assertTrue(policy.reconcile(request("trip", true, true), registration));
        ResidentLocationSamplingPolicy freshService = new ResidentLocationSamplingPolicy();
        assertTrue(freshService.reconcile(request("trip", true, true), registration));
        assertEquals(3, registration.starts);
    }

    @Test
    public void partialRegistrationFailureCleansUpAndAllowsRetry() {
        ResidentLocationSamplingPolicy policy = new ResidentLocationSamplingPolicy();
        FakeRegistration registration = new FakeRegistration() {
            @Override
            public boolean start(ResidentLocationSamplingPolicy.Request request) {
                super.start(request);
                if (starts == 1) throw new SecurityException("Permission revoked between providers");
                return true;
            }
        };
        ResidentLocationSamplingPolicy.Request failed = request("trip", true, true);
        try {
            policy.reconcile(failed, registration);
            fail("Expected provider registration failure");
        } catch (SecurityException expected) {
            assertNull(policy.current());
            assertFalse(policy.accepts(failed, "trip"));
        }
        assertEquals(1, registration.stops);
        assertTrue(policy.reconcile(request("trip", true, true), registration));
        assertEquals(2, registration.starts);
    }

    @Test(expected = IllegalArgumentException.class)
    public void emptyTripCannotConstructAProviderSubscription() {
        request("", true, true);
    }

    @Test
    public void tripEndingDuringRegistrationRemovesPartialProvidersAndInvalidatesCallback() {
        ResidentLocationSamplingPolicy policy = new ResidentLocationSamplingPolicy();
        ResidentLocationSamplingPolicy.Request requested = request("trip", true, true);
        FakeRegistration registration = new FakeRegistration() {
            @Override
            public boolean start(ResidentLocationSamplingPolicy.Request request) {
                super.start(request);
                return false;
            }
        };
        policy.reconcile(requested, registration);
        assertNull(policy.current());
        assertFalse(policy.accepts(requested, "trip"));
        assertEquals(1, registration.starts);
        assertEquals(1, registration.stops);
        assertFalse(policy.reconcile(null, registration));
    }

    private static ResidentLocationSamplingPolicy.Request request(String tripId, boolean gps, boolean network) {
        return new ResidentLocationSamplingPolicy.Request(tripId, true, gps, true, network);
    }

    private static class FakeRegistration implements ResidentLocationSamplingPolicy.Registration {
        int starts;
        int stops;

        @Override
        public boolean start(ResidentLocationSamplingPolicy.Request request) {
            starts++;
            return true;
        }

        @Override
        public void stop() {
            stops++;
        }
    }
}
