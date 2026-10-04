package com.tracklog.assist;

/** Supplemental exit evidence only: never starts/ends a trip or an expressway section. */
final class ResidentExpresswayExitWatch {
    static final String LEGACY = "legacy";
    static final String BRIEF = "brief-deceleration";
    static final String ROAD = "moving-road-check";
    static final long PROBE_INTERVAL_MS = 60_000L;
    static final long BRIEF_INTERVAL_MS = 30_000L;
    static final long EVIDENCE_MAX_AGE_MS = 5 * 60_000L;
    static final double MOVE_METERS = 200d;
    static final double KEEP_MOVE_METERS = 500d;
    static final double MAX_ACCURACY_METERS = 50d;

    static final class Fix {
        final long atMs;
        final double lat;
        final double lon;
        final double accuracy;
        final double speedKmh;
        Fix(long atMs, double lat, double lon, double accuracy, double speedKmh) {
            this.atMs = atMs;
            this.lat = lat;
            this.lon = lon;
            this.accuracy = accuracy;
            this.speedKmh = speedKmh;
        }
        boolean valid() {
            return atMs > 0 && Double.isFinite(lat) && Math.abs(lat) <= 90
                    && Double.isFinite(lon) && Math.abs(lon) <= 180
                    && Double.isFinite(accuracy) && accuracy >= 0 && accuracy <= MAX_ACCURACY_METERS
                    && Double.isFinite(speedKmh) && speedKmh >= 0 && speedKmh <= 220;
        }
    }

    /** Bounded, durable auxiliary state; the existing route/event queues are not modified. */
    static final class State {
        final Fix origin;
        final Fix lastProbe;
        final Fix outside;
        final Fix keep;
        final Fix brief;
        State(Fix origin, Fix lastProbe, Fix outside, Fix keep, Fix brief) {
            this.origin = origin;
            this.lastProbe = lastProbe;
            this.outside = outside;
            this.keep = keep;
            this.brief = brief;
        }
        static State empty() { return new State(null, null, null, null, null); }
        State kept(Fix anchor) { return new State(anchor, null, null, anchor, null); }
        State queried(Fix fix, String mode) {
            return new State(origin, fix, outside, keep, BRIEF.equals(mode) ? null : brief);
        }
    }

    static final class Selection {
        final String mode;
        final Fix fix;
        Selection(String mode, Fix fix) { this.mode = mode; this.fix = fix; }
    }

    static boolean isBriefDeceleration(Double previousSpeedMs, double speedKmh,
            ResidentExpresswayDetectionPolicy.Config config,
            ResidentExpresswayDetectionPolicy.Result result) {
        return result.ignoredReason == ResidentExpresswayDetectionPolicy.IgnoredReason.NONE
                && previousSpeedMs != null && previousSpeedMs * 3.6d >= config.endSpeedKmh
                && speedKmh < config.endSpeedKmh
                && result.state.lastStrongDecelerationAtMs == result.state.lastMotionAtMs;
    }

    static State observe(State state, Fix fix, boolean briefDeceleration, boolean keepSuppressed) {
        if (!fix.valid()) return state;
        // A backward wall clock must not keep the watcher asleep indefinitely. Do not join
        // road evidence across the clock discontinuity. Native motion uses its monotonic clock.
        boolean clockReset = state.origin != null && fix.atMs < state.origin.atMs
                || state.lastProbe != null && fix.atMs < state.lastProbe.atMs;
        if (clockReset) return new State(fix, null, null, keepSuppressed ? fix : null, null);
        Fix origin = state.origin == null ? fix : state.origin;
        Fix keep = keepSuppressed ? (state.keep == null ? fix : state.keep) : null;
        Fix brief = fresh(state.brief, fix.atMs) ? state.brief : null;
        if (brief == null && briefDeceleration && movedAfterKeep(keep, fix)) brief = fix;
        Fix outside = fresh(state.outside, fix.atMs) ? state.outside : null;
        if (origin == state.origin && keep == state.keep && brief == state.brief && outside == state.outside) {
            return state;
        }
        return new State(origin, state.lastProbe, outside, keep, brief);
    }

    static Selection select(State state, Fix current) {
        if (!current.valid() || state.origin == null) return null;
        if (fresh(state.brief, current.atMs) && movedAfterKeep(state.keep, state.brief)
                && elapsed(state.lastProbe, current.atMs, BRIEF_INTERVAL_MS)) {
            return new Selection(BRIEF, state.brief);
        }
        Fix anchor = state.lastProbe == null ? state.origin : state.lastProbe;
        if (elapsed(anchor, current.atMs, PROBE_INTERVAL_MS)
                && distance(anchor, current) >= MOVE_METERS
                && movedAfterKeep(state.keep, current)) {
            return new Selection(ROAD, current);
        }
        return null;
    }

    static boolean shouldPrompt(State state, Selection selection,
            ResidentExpresswayDetectionPolicy.Signal signal) {
        if (signal == null || !signal.resolved) return false;
        if (BRIEF.equals(selection.mode) && signal.nearEtcGate) return true;
        return !signal.onExpresswayRoad && fresh(state.outside, selection.fix.atMs)
                && selection.fix.atMs > state.outside.atMs
                && distance(state.outside, selection.fix) >= MOVE_METERS;
    }

    static State resolved(State state, Fix fix, ResidentExpresswayDetectionPolicy.Signal signal) {
        Fix outside = signal != null && signal.resolved && !signal.onExpresswayRoad ? fix : null;
        return new State(state.origin, state.lastProbe, outside, state.keep, state.brief);
    }

    static boolean fresh(Fix fix, long nowMs) {
        return fix != null && nowMs >= fix.atMs && nowMs - fix.atMs <= EVIDENCE_MAX_AGE_MS;
    }

    private static boolean elapsed(Fix fix, long nowMs, long interval) {
        return fix == null || nowMs >= fix.atMs && nowMs - fix.atMs >= interval;
    }

    private static boolean movedAfterKeep(Fix keep, Fix fix) {
        return keep == null || elapsed(keep, fix.atMs, PROBE_INTERVAL_MS)
                && distance(keep, fix) >= KEEP_MOVE_METERS;
    }

    static double distance(Fix first, Fix second) {
        double dLat = Math.toRadians(second.lat - first.lat);
        double dLon = Math.toRadians(second.lon - first.lon);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(first.lat)) * Math.cos(Math.toRadians(second.lat))
                * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 6_371_000d * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0d, 1d - a)));
    }
}
