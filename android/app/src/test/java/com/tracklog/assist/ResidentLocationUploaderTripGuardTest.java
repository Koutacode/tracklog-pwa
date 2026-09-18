package com.tracklog.assist;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Collections;

import org.junit.Test;

public class ResidentLocationUploaderTripGuardTest {
    @Test
    public void queuedIdleFixCannotBecomeValidWhenAnotherTripStarts() {
        assertFalse(ResidentLocationUploader.isExpectedTripActive(null, "trip-new"));
        assertFalse(ResidentLocationUploader.isExpectedTripActive("", "trip-new"));
        assertFalse(ResidentLocationUploader.isExpectedTripActive("  ", "trip-new"));
        assertFalse(ResidentLocationUploader.isExpectedTripActive("", ""));
    }

    @Test
    public void endingOrSwitchingTripInvalidatesFixCapturedBeforeRefresh() {
        String capturedTrip = "trip-original";
        assertTrue(ResidentLocationUploader.isExpectedTripActive(capturedTrip, "trip-original"));
        // The same captured value is used again after a token refresh returns.
        assertFalse(ResidentLocationUploader.isExpectedTripActive(capturedTrip, ""));
        assertFalse(ResidentLocationUploader.isExpectedTripActive(capturedTrip, null));
        assertFalse(ResidentLocationUploader.isExpectedTripActive(capturedTrip, "trip-next"));
        assertTrue(ResidentLocationUploader.isExpectedTripActive(" trip-original ", "trip-original"));
    }

    @Test
    public void probeStillNeedsMatchingRevisionAndPendingIdentityAfterRefresh() {
        ResidentExpresswayStore.Probe original = probe("probe-original", "trip-original", 3L);
        assertTrue(ResidentLocationUploader.isCurrentProbe(
                original, snapshot("trip-original", 3L, false, true, original)));
        assertFalse(ResidentLocationUploader.isCurrentProbe(
                original, snapshot("trip-original", 4L, false, true, original)));
        assertFalse(ResidentLocationUploader.isCurrentProbe(
                original, snapshot("trip-original", 3L, false, true,
                        probe("probe-next", "trip-original", 3L))));
        assertFalse(ResidentLocationUploader.isCurrentProbe(
                original, snapshot("trip-original", 3L, false, true, null)));
        assertFalse(ResidentLocationUploader.isCurrentProbe(
                original, snapshot("trip-next", 3L, false, true, original)));
    }

    @Test
    public void endedPausedOrUnreadableProbeCannotBeSent() {
        ResidentExpresswayStore.Probe original = probe("probe-original", "trip-original", 3L);
        assertFalse(ResidentLocationUploader.isCurrentProbe(
                original, snapshot("", 3L, false, true, original)));
        assertFalse(ResidentLocationUploader.isCurrentProbe(
                original, snapshot("trip-original", 3L, true, true, original)));
        assertFalse(ResidentLocationUploader.isCurrentProbe(
                original, snapshot("trip-original", 3L, false, false, original)));
        assertFalse(ResidentLocationUploader.isCurrentProbe(null, null));
        ResidentExpresswayStore.Probe idle = probe("probe-idle", "", 3L);
        assertFalse(ResidentLocationUploader.isCurrentProbe(
                idle, snapshot("", 3L, false, true, idle)));
    }

    private static ResidentExpresswayStore.Probe probe(String id, String tripId, long revision) {
        return new ResidentExpresswayStore.Probe(
                id, ResidentExpresswayStore.ProbeKind.START, tripId, revision,
                "2026-09-18T00:00:00Z", 0L, 0d, 0d, 10d, 80d,
                null, 0L, "test-session", 0L, null, 0, 0L, "", 0L
        );
    }

    private static ResidentExpresswayStore.Snapshot snapshot(
            String tripId,
            long revision,
            boolean paused,
            boolean healthy,
            ResidentExpresswayStore.Probe pending
    ) {
        return new ResidentExpresswayStore.Snapshot(
                tripId, revision, false, paused, false, "", Collections.emptyList(),
                null, pending, null, healthy
        );
    }
}
