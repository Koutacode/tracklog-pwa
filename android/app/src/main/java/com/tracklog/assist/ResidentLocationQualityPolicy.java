package com.tracklog.assist;

import java.util.Locale;

/**
 * Pure policy for rejecting unusable or duplicate native location fixes before they are queued.
 * The thresholds intentionally leave ample headroom above normal motorway truck movement.
 */
final class ResidentLocationQualityPolicy {
    static final float MAX_ACCURACY_METERS = 150f;
    static final long MAX_FIX_AGE_MS = 120_000L;
    static final long MAX_FUTURE_SKEW_MS = 60_000L;
    static final long LOWER_PRIORITY_PROVIDER_WINDOW_MS = 15_000L;
    static final long DUPLICATE_WINDOW_MS = 4_000L;
    static final double DUPLICATE_MIN_RADIUS_METERS = 25d;
    static final double MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND = 70d;

    private ResidentLocationQualityPolicy() {}

    static Decision evaluate(
            Fix previousAccepted,
            Fix candidate,
            long nowMs,
            long nowElapsedRealtimeNanos
    ) {
        if (candidate == null
                || !Double.isFinite(candidate.latitude)
                || !Double.isFinite(candidate.longitude)
                || candidate.latitude < -90d
                || candidate.latitude > 90d
                || candidate.longitude < -180d
                || candidate.longitude > 180d) {
            return Decision.reject(Rejection.INVALID_COORDINATES);
        }
        if (!hasFreshTimestamp(candidate, nowMs, nowElapsedRealtimeNanos)) {
            return Decision.reject(Rejection.STALE_TIMESTAMP);
        }
        if (candidate.hasAccuracy
                && (!Float.isFinite(candidate.accuracyMeters)
                || candidate.accuracyMeters < 0f
                || candidate.accuracyMeters > MAX_ACCURACY_METERS)) {
            return Decision.reject(Rejection.POOR_ACCURACY);
        }
        if (previousAccepted == null) return Decision.accept();
        ElapsedComparison elapsed = compareElapsed(previousAccepted, candidate);
        if (!elapsed.comparable) {
            // A wall-clock correction or a missing elapsed-realtime value must reset the
            // movement baseline instead of discarding an otherwise fresh fix.
            return Decision.accept();
        }
        if (elapsed.elapsedMs <= 0L) {
            return Decision.reject(Rejection.NON_MONOTONIC_TIMESTAMP);
        }
        long elapsedMs = elapsed.elapsedMs;
        if (elapsedMs <= LOWER_PRIORITY_PROVIDER_WINDOW_MS
                && isGps(previousAccepted.provider)
                && isNetwork(candidate.provider)) {
            return Decision.reject(Rejection.LOWER_PRIORITY_PROVIDER);
        }

        double distanceMeters = distanceMeters(previousAccepted, candidate);
        double previousAccuracy = normalizedAccuracy(previousAccepted);
        double candidateAccuracy = normalizedAccuracy(candidate);
        double duplicateRadius = Math.max(
                DUPLICATE_MIN_RADIUS_METERS,
                previousAccuracy + candidateAccuracy
        );
        boolean candidateMateriallyMoreAccurate =
                (isGps(candidate.provider) && isNetwork(previousAccepted.provider))
                        || candidateAccuracy < previousAccuracy * 0.6d;
        if (elapsedMs <= DUPLICATE_WINDOW_MS
                && distanceMeters <= duplicateRadius
                && !candidateMateriallyMoreAccurate) {
            return Decision.reject(Rejection.NEAR_DUPLICATE);
        }

        double uncertaintyAdjustedDistance = Math.max(
                0d,
                distanceMeters - previousAccuracy - candidateAccuracy
        );
        double elapsedSeconds = elapsedMs / 1000d;
        if (elapsedSeconds > 0d
                && uncertaintyAdjustedDistance / elapsedSeconds
                > MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND) {
            return Decision.reject(Rejection.IMPLAUSIBLE_JUMP);
        }
        return Decision.accept();
    }

    private static boolean hasFreshTimestamp(
            Fix candidate,
            long nowMs,
            long nowElapsedRealtimeNanos
    ) {
        if (candidate.elapsedRealtimeNanos > 0L && nowElapsedRealtimeNanos > 0L) {
            long ageNanos = nowElapsedRealtimeNanos - candidate.elapsedRealtimeNanos;
            long maxAgeNanos = MAX_FIX_AGE_MS * 1_000_000L;
            long maxFutureNanos = MAX_FUTURE_SKEW_MS * 1_000_000L;
            return ageNanos <= maxAgeNanos && ageNanos >= -maxFutureNanos;
        }
        if (candidate.timestampMs <= 0L || nowMs <= 0L) return false;
        long ageMs = nowMs - candidate.timestampMs;
        return ageMs <= MAX_FIX_AGE_MS && ageMs >= -MAX_FUTURE_SKEW_MS;
    }

    private static ElapsedComparison compareElapsed(Fix previous, Fix candidate) {
        if (previous.elapsedRealtimeNanos > 0L && candidate.elapsedRealtimeNanos > 0L) {
            long deltaNanos = candidate.elapsedRealtimeNanos - previous.elapsedRealtimeNanos;
            return new ElapsedComparison(true, deltaNanos / 1_000_000L);
        }
        if (previous.timestampMs <= 0L || candidate.timestampMs <= 0L) {
            return new ElapsedComparison(false, 0L);
        }
        long wallDeltaMs = candidate.timestampMs - previous.timestampMs;
        if (wallDeltaMs < 0L) return new ElapsedComparison(false, 0L);
        return new ElapsedComparison(true, wallDeltaMs);
    }

    private static double normalizedAccuracy(Fix fix) {
        if (!fix.hasAccuracy || !Float.isFinite(fix.accuracyMeters) || fix.accuracyMeters < 0f) {
            return MAX_ACCURACY_METERS;
        }
        return Math.min(MAX_ACCURACY_METERS, fix.accuracyMeters);
    }

    private static boolean isGps(String provider) {
        return "gps".equals(normalizeProvider(provider));
    }

    private static boolean isNetwork(String provider) {
        return "network".equals(normalizeProvider(provider));
    }

    private static String normalizeProvider(String provider) {
        return provider == null ? "" : provider.trim().toLowerCase(Locale.US);
    }

    private static double distanceMeters(Fix first, Fix second) {
        double firstLat = Math.toRadians(first.latitude);
        double secondLat = Math.toRadians(second.latitude);
        double deltaLat = secondLat - firstLat;
        double deltaLng = Math.toRadians(second.longitude - first.longitude);
        double sinLat = Math.sin(deltaLat / 2d);
        double sinLng = Math.sin(deltaLng / 2d);
        double haversine = sinLat * sinLat
                + Math.cos(firstLat) * Math.cos(secondLat) * sinLng * sinLng;
        double bounded = Math.min(1d, Math.max(0d, haversine));
        return 6_371_000d * 2d * Math.atan2(Math.sqrt(bounded), Math.sqrt(1d - bounded));
    }

    enum Rejection {
        NONE,
        INVALID_COORDINATES,
        STALE_TIMESTAMP,
        POOR_ACCURACY,
        NON_MONOTONIC_TIMESTAMP,
        LOWER_PRIORITY_PROVIDER,
        NEAR_DUPLICATE,
        IMPLAUSIBLE_JUMP
    }

    static final class Decision {
        final boolean accepted;
        final Rejection rejection;

        private Decision(boolean accepted, Rejection rejection) {
            this.accepted = accepted;
            this.rejection = rejection;
        }

        static Decision accept() {
            return new Decision(true, Rejection.NONE);
        }

        static Decision reject(Rejection rejection) {
            return new Decision(false, rejection);
        }
    }

    static final class Fix {
        final double latitude;
        final double longitude;
        final long timestampMs;
        final long elapsedRealtimeNanos;
        final boolean hasAccuracy;
        final float accuracyMeters;
        final String provider;

        Fix(
                double latitude,
                double longitude,
                long timestampMs,
                long elapsedRealtimeNanos,
                boolean hasAccuracy,
                float accuracyMeters,
                String provider
        ) {
            this.latitude = latitude;
            this.longitude = longitude;
            this.timestampMs = timestampMs;
            this.elapsedRealtimeNanos = elapsedRealtimeNanos;
            this.hasAccuracy = hasAccuracy;
            this.accuracyMeters = accuracyMeters;
            this.provider = provider;
        }
    }

    private static final class ElapsedComparison {
        final boolean comparable;
        final long elapsedMs;

        ElapsedComparison(boolean comparable, long elapsedMs) {
            this.comparable = comparable;
            this.elapsedMs = elapsedMs;
        }
    }
}
