package com.tracklog.assist;

import static org.junit.Assert.assertEquals;
import org.junit.Test;

public class ResidentExpresswayRecoveryPolicyTest {
    private static final long MAX_RETRY_MS = 300_000L;

    @Test
    public void restartBeforeDeadlineRestoresRemainingDelayAndExecutesAtDeadline() {
        assertEquals(30_000L, delay(40_000L, 10_000L));
        // A repeated start replacing the callback must retain a future reservation.
        assertEquals(20_000L, delay(40_000L, 20_000L));
        assertEquals(0L, delay(40_000L, 40_000L));
    }

    @Test
    public void restoredNewProbeAndOverdueProbeRunImmediately() {
        assertEquals(0L, delay(0L, 10_000L));
        assertEquals(0L, delay(5_000L, 10_000L));
    }

    @Test
    public void noDuplicateDispatchWhileAProbeIsAlreadyInFlight() {
        assertEquals(-1L, ResidentExpresswayRecoveryPolicy.nextProbeDelay(
                true, true, 0L, 10_000L, MAX_RETRY_MS));
        assertEquals(20_000L, delay(30_000L, 10_000L));
    }

    @Test
    public void missingPausedUnhealthyOrStaleProbeDoesNotCreateRetryLoop() {
        assertEquals(-1L, ResidentExpresswayRecoveryPolicy.nextProbeDelay(
                false, false, 20_000L, 10_000L, MAX_RETRY_MS));
    }

    @Test
    public void clockMovedBackBeyondRetryWindowDoesNotBlockRecovery() {
        assertEquals(0L, delay(MAX_RETRY_MS + 10_001L, 10_000L));
        assertEquals(MAX_RETRY_MS, delay(MAX_RETRY_MS + 10_000L, 10_000L));
    }

    private static long delay(long retryAfterAtMs, long nowMs) {
        return ResidentExpresswayRecoveryPolicy.nextProbeDelay(
                true, false, retryAfterAtMs, nowMs, MAX_RETRY_MS);
    }
}
