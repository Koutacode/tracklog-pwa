package com.tracklog.assist;

/** A location switch may pause an existing foreground service, never authorize a new one. */
final class ResidentLocationRecoveryPolicy {
    enum Mode { STOP, WAIT_FOR_LOCATION, RECORD }

    private ResidentLocationRecoveryPolicy() {}

    static Mode mode(
            boolean eligible,
            boolean foregroundLocation,
            boolean backgroundLocation,
            boolean notifications,
            boolean locationEnabled,
            boolean foregroundStarted
    ) {
        if (!eligible || !foregroundLocation || !backgroundLocation || !notifications) {
            return Mode.STOP;
        }
        if (locationEnabled) return Mode.RECORD;
        return foregroundStarted ? Mode.WAIT_FOR_LOCATION : Mode.STOP;
    }
}
