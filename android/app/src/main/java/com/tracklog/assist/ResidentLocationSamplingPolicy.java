package com.tracklog.assist;

/** Main-thread subscription changes; a volatile generation rejects already queued old fixes. */
final class ResidentLocationSamplingPolicy {
    static final long RECORDING_INTERVAL_MS = 10_000L;
    static final float MIN_DISTANCE_METERS = 0f;

    static final class Request {
        final String tripId;
        final boolean gpsAvailable;
        final boolean gpsEnabled;
        final boolean networkAvailable;
        final boolean networkEnabled;

        Request(String tripId, boolean gpsAvailable, boolean gpsEnabled,
                boolean networkAvailable, boolean networkEnabled) {
            if (tripId == null || tripId.trim().isEmpty()) {
                throw new IllegalArgumentException("A location subscription requires an active trip");
            }
            this.tripId = tripId;
            this.gpsAvailable = gpsAvailable;
            this.gpsEnabled = gpsAvailable && gpsEnabled;
            this.networkAvailable = networkAvailable;
            this.networkEnabled = networkAvailable && networkEnabled;
        }

        private boolean sameConditions(Request other) {
            return other != null && tripId.equals(other.tripId)
                    && gpsAvailable == other.gpsAvailable && gpsEnabled == other.gpsEnabled
                    && networkAvailable == other.networkAvailable
                    && networkEnabled == other.networkEnabled;
        }
    }

    interface Registration {
        boolean start(Request request);
        void stop();
    }

    private volatile Request current;

    Request current() {
        return current;
    }

    boolean accepts(Request capturedRequest, String activeTripId) {
        return capturedRequest != null && current == capturedRequest
                && capturedRequest.tripId.equals(activeTripId);
    }

    /** Null means no trip or device location OFF; repeated reconciles are no-ops. */
    boolean reconcile(Request desired, Registration registration) {
        Request previous = current;
        if (previous == null ? desired == null : previous.sameConditions(desired)) return false;
        current = null; // Invalidate callbacks before removing the old listener.
        if (previous != null) registration.stop();
        if (desired != null) {
            current = desired;
            try {
                if (!registration.start(desired)) {
                    current = null;
                    registration.stop();
                }
            } catch (RuntimeException exception) {
                current = null;
                try {
                    registration.stop(); // Also remove a partially registered provider pair.
                } catch (RuntimeException cleanupException) {
                    exception.addSuppressed(cleanupException);
                }
                throw exception;
            }
        }
        return true;
    }
}
