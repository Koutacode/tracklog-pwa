package com.tracklog.assist;

/** Reconstruct the next retry from persisted state, including after process recreation. */
final class ResidentExpresswayRecoveryPolicy {
    private ResidentExpresswayRecoveryPolicy() {}

    static long nextProbeDelay(
            boolean applicable,
            boolean inFlight,
            long retryAfterAtMs,
            long nowMs,
            long maxRetryMs
    ) {
        if (!applicable || inFlight) return -1L;
        if (retryAfterAtMs <= 0L || nowMs >= retryAfterAtMs) return 0L;
        long remaining = retryAfterAtMs - nowMs;
        // Match the store's recovery for a clock moved backwards beyond its retry window.
        return remaining > maxRetryMs ? 0L : remaining;
    }
}
