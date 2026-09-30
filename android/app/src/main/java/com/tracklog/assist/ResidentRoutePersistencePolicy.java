package com.tracklog.assist;

/** Reduces stationary history writes without reducing the live location/detection stream. */
final class ResidentRoutePersistencePolicy {
    static final long STATIONARY_HEARTBEAT_MS = 60_000L;
    static final float MAX_STATIONARY_SPEED_MPS = 0.5f;
    static final float MAX_STATIONARY_ACCURACY_M = 35f;
    static final double STATIONARY_RADIUS_M = 12d;

    private ResidentRoutePersistencePolicy() {}

    static boolean shouldPersist(
            ResidentLocationQualityPolicy.Fix previous,
            float previousSpeed,
            ResidentLocationQualityPolicy.Fix candidate,
            float candidateSpeed
    ) {
        // Missing speed is NaN. Uncertain fixes and the first point always remain in history.
        if (!isStationary(previous, previousSpeed) || !isStationary(candidate, candidateSpeed)) return true;
        long elapsedMs;
        if (previous.elapsedRealtimeNanos > 0L && candidate.elapsedRealtimeNanos > 0L) {
            elapsedMs = (candidate.elapsedRealtimeNanos - previous.elapsedRealtimeNanos) / 1_000_000L;
        } else {
            elapsedMs = candidate.timestampMs - previous.timestampMs;
        }
        if (elapsedMs <= 0L || elapsedMs >= STATIONARY_HEARTBEAT_MS) return true;
        double latDelta = Math.toRadians(candidate.latitude - previous.latitude);
        double lngDelta = Math.toRadians(candidate.longitude - previous.longitude);
        double sinLat = Math.sin(latDelta / 2d);
        double sinLng = Math.sin(lngDelta / 2d);
        double h = sinLat * sinLat + Math.cos(Math.toRadians(previous.latitude))
                * Math.cos(Math.toRadians(candidate.latitude)) * sinLng * sinLng;
        double distance = 2d * 6_371_000d * Math.asin(Math.sqrt(Math.min(1d, Math.max(0d, h))));
        return !Double.isFinite(distance) || distance > STATIONARY_RADIUS_M;
    }

    private static boolean isStationary(ResidentLocationQualityPolicy.Fix fix, float speed) {
        return fix != null && Float.isFinite(speed) && speed >= 0f && speed <= MAX_STATIONARY_SPEED_MPS
                && fix.hasAccuracy && Float.isFinite(fix.accuracyMeters)
                && fix.accuracyMeters >= 0f && fix.accuracyMeters <= MAX_STATIONARY_ACCURACY_M;
    }
}
