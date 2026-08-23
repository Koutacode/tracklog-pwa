package com.tracklog.assist;

/**
 * Deterministic expressway motion policy. It deliberately has no Android, network, storage, or
 * notification dependencies so every threshold and clock transition can be regression tested.
 */
final class ResidentExpresswayDetectionPolicy {
    static final double MAX_DETECTION_ACCURACY_M = 100d;
    static final double MAX_SENSOR_SPEED_KMH = 220d;
    static final double START_ACCELERATION_MS2 = 0.18d;
    static final long START_ACCELERATION_WINDOW_MS = 75_000L;
    static final int START_SIGNAL_MIN_HITS = 2;
    static final long START_SIGNAL_MIN_HOLD_MS = 12_000L;
    static final long START_SIGNAL_MAX_GAP_MS = 25_000L;
    static final long START_PROBE_MIN_INTERVAL_MS = 10_000L;
    static final double END_DECELERATION_MS2 = -0.28d;
    static final long END_DECELERATION_WINDOW_MS = 90_000L;
    static final long END_PROBE_MIN_INTERVAL_MS = 30_000L;
    static final long END_UNRESOLVED_FALLBACK_MS = 90_000L;
    static final double END_RECOVERY_MARGIN_KMH = 8d;
    static final long END_RECOVERY_HOLD_MS = 20_000L;

    private ResidentExpresswayDetectionPolicy() {}

    static final class Config {
        static final Config DEFAULT = new Config(78d, 6L, 34d, 24L);

        final double startSpeedKmh;
        final long startDurationSec;
        final double endSpeedKmh;
        final long endDurationSec;

        Config(
                double startSpeedKmh,
                long startDurationSec,
                double endSpeedKmh,
                long endDurationSec
        ) {
            this.startSpeedKmh = clamp(startSpeedKmh, 30d, 160d, 78d);
            this.startDurationSec = clamp(startDurationSec, 3L, 300L, 6L);
            this.endSpeedKmh = clamp(endSpeedKmh, 0d, 120d, 34d);
            this.endDurationSec = clamp(endDurationSec, 5L, 600L, 24L);
        }

        private static double clamp(double value, double min, double max, double fallback) {
            if (!Double.isFinite(value)) return fallback;
            return Math.max(min, Math.min(max, value));
        }

        private static long clamp(long value, long min, long max, long fallback) {
            if (value < min || value > max) return fallback;
            return value;
        }
    }

    static final class Point {
        final String tripId;
        final long wallAtMs;
        final String monotonicSessionId;
        final long elapsedRealtimeMs;
        final boolean hasAccuracy;
        final double accuracyM;
        final boolean hasSpeed;
        final double speedMs;

        Point(
                String tripId,
                long wallAtMs,
                String monotonicSessionId,
                long elapsedRealtimeMs,
                boolean hasAccuracy,
                double accuracyM,
                boolean hasSpeed,
                double speedMs
        ) {
            this.tripId = tripId == null ? "" : tripId.trim();
            this.wallAtMs = wallAtMs;
            this.monotonicSessionId = monotonicSessionId == null
                    ? ""
                    : monotonicSessionId.trim();
            this.elapsedRealtimeMs = elapsedRealtimeMs;
            this.hasAccuracy = hasAccuracy;
            this.accuracyM = accuracyM;
            this.hasSpeed = hasSpeed;
            this.speedMs = speedMs;
        }
    }

    enum EffectKind {
        NONE,
        PROBE_START,
        PROBE_END,
        CLEAR_KEEP
    }

    enum IgnoredReason {
        NONE,
        DIFFERENT_TRIP,
        OUT_OF_ORDER,
        INVALID_TIME,
        POOR_ACCURACY,
        INVALID_SPEED
    }

    static final class Effect {
        final EffectKind kind;
        final long motionAtMs;
        final double speedKmh;
        final Double accelerationMs2;
        final long lowSpeedElapsedMs;

        private Effect(
                EffectKind kind,
                long motionAtMs,
                double speedKmh,
                Double accelerationMs2,
                long lowSpeedElapsedMs
        ) {
            this.kind = kind;
            this.motionAtMs = motionAtMs;
            this.speedKmh = speedKmh;
            this.accelerationMs2 = accelerationMs2;
            this.lowSpeedElapsedMs = lowSpeedElapsedMs;
        }

        static Effect none() {
            return new Effect(EffectKind.NONE, 0L, 0d, null, 0L);
        }
    }

    static final class Result {
        final State state;
        final Effect effect;
        final IgnoredReason ignoredReason;

        Result(State state, Effect effect, IgnoredReason ignoredReason) {
            this.state = state;
            this.effect = effect;
            this.ignoredReason = ignoredReason;
        }
    }

    static final class Signal {
        final boolean resolved;
        final boolean onExpresswayRoad;
        final boolean nearIc;
        final boolean nearEtcGate;

        Signal(boolean resolved, boolean onExpresswayRoad, boolean nearIc, boolean nearEtcGate) {
            this.resolved = resolved;
            this.onExpresswayRoad = onExpresswayRoad;
            this.nearIc = nearIc;
            this.nearEtcGate = nearEtcGate;
        }
    }

    static final class StartSignalResult {
        final State state;
        final boolean shouldStart;
        final int hits;
        final long holdMs;

        StartSignalResult(State state, boolean shouldStart, int hits, long holdMs) {
            this.state = state;
            this.shouldStart = shouldStart;
            this.hits = hits;
            this.holdMs = holdMs;
        }
    }

    static final class State {
        final String tripId;
        String lastMonotonicSessionId = "";
        long lastElapsedRealtimeMs = -1L;
        long lastMotionAtMs = -1L;
        Double lastSpeedMs;
        long lastSpeedAtMs = -1L;
        long speedAboveSinceMs = -1L;
        long speedBelowSinceMs = -1L;
        long speedRecoveredSinceMs = -1L;
        long lastStrongAccelerationAtMs = -1L;
        long lastStrongDecelerationAtMs = -1L;
        long lastStartProbeAtMs = -1L;
        long lastEndProbeAtMs = -1L;
        long startSignalFirstAtMs = -1L;
        long startSignalLastAtMs = -1L;
        int startSignalHits = 0;
        boolean keepSuppressed = false;

        State(String tripId) {
            this.tripId = tripId == null ? "" : tripId.trim();
        }

        State(State source) {
            tripId = source.tripId;
            lastMonotonicSessionId = source.lastMonotonicSessionId;
            lastElapsedRealtimeMs = source.lastElapsedRealtimeMs;
            lastMotionAtMs = source.lastMotionAtMs;
            lastSpeedMs = source.lastSpeedMs;
            lastSpeedAtMs = source.lastSpeedAtMs;
            speedAboveSinceMs = source.speedAboveSinceMs;
            speedBelowSinceMs = source.speedBelowSinceMs;
            speedRecoveredSinceMs = source.speedRecoveredSinceMs;
            lastStrongAccelerationAtMs = source.lastStrongAccelerationAtMs;
            lastStrongDecelerationAtMs = source.lastStrongDecelerationAtMs;
            lastStartProbeAtMs = source.lastStartProbeAtMs;
            lastEndProbeAtMs = source.lastEndProbeAtMs;
            startSignalFirstAtMs = source.startSignalFirstAtMs;
            startSignalLastAtMs = source.startSignalLastAtMs;
            startSignalHits = source.startSignalHits;
            keepSuppressed = source.keepSuppressed;
        }
    }

    static Result advance(
            State previous,
            Point point,
            Config config,
            boolean isOpen,
            boolean hasPendingPrompt
    ) {
        if (previous == null || point == null || config == null) {
            throw new IllegalArgumentException("state, point, and config are required");
        }
        if (!previous.tripId.equals(point.tripId)) {
            return new Result(previous, Effect.none(), IgnoredReason.DIFFERENT_TRIP);
        }

        State state = new State(previous);
        Clock clock = resolveClock(state, point);
        if (clock.ignored != IgnoredReason.NONE) {
            return new Result(previous, Effect.none(), clock.ignored);
        }
        if (clock.resetMotion) resetMotion(state);
        state.lastMonotonicSessionId = clock.sessionId;
        state.lastElapsedRealtimeMs = clock.elapsedRealtimeMs;
        state.lastMotionAtMs = clock.motionAtMs;

        if (point.hasAccuracy
                && (!Double.isFinite(point.accuracyM)
                || point.accuracyM < 0d
                || point.accuracyM > MAX_DETECTION_ACCURACY_M)) {
            return new Result(state, Effect.none(), IgnoredReason.POOR_ACCURACY);
        }

        if (!point.hasSpeed
                || !Double.isFinite(point.speedMs)
                || point.speedMs < 0d
                || point.speedMs * 3.6d > MAX_SENSOR_SPEED_KMH) {
            resetSpeedWindows(state);
            return new Result(state, Effect.none(), IgnoredReason.INVALID_SPEED);
        }

        double speedKmh = point.speedMs * 3.6d;
        Double acceleration = deriveAcceleration(
                state.lastSpeedMs,
                state.lastSpeedAtMs,
                point.speedMs,
                clock.motionAtMs
        );
        state.lastSpeedMs = point.speedMs;
        state.lastSpeedAtMs = clock.motionAtMs;
        if (acceleration != null && acceleration >= START_ACCELERATION_MS2) {
            state.lastStrongAccelerationAtMs = clock.motionAtMs;
        }
        if (acceleration != null && acceleration <= END_DECELERATION_MS2) {
            state.lastStrongDecelerationAtMs = clock.motionAtMs;
        }

        if (isOpen) {
            resetStartCandidate(state);
            state.speedAboveSinceMs = -1L;
            double recoveryThreshold = config.endSpeedKmh + END_RECOVERY_MARGIN_KMH;
            if (speedKmh >= recoveryThreshold) {
                if (state.speedRecoveredSinceMs < 0L) state.speedRecoveredSinceMs = clock.motionAtMs;
                state.speedBelowSinceMs = -1L;
                if (state.keepSuppressed
                        && clock.motionAtMs - state.speedRecoveredSinceMs >= END_RECOVERY_HOLD_MS) {
                    state.keepSuppressed = false;
                    state.speedRecoveredSinceMs = -1L;
                    return new Result(
                            state,
                            new Effect(EffectKind.CLEAR_KEEP, clock.motionAtMs, speedKmh, acceleration, 0L),
                            IgnoredReason.NONE
                    );
                }
                return new Result(state, Effect.none(), IgnoredReason.NONE);
            }
            state.speedRecoveredSinceMs = -1L;
            if (state.keepSuppressed || hasPendingPrompt) {
                return new Result(state, Effect.none(), IgnoredReason.NONE);
            }
            if (speedKmh >= config.endSpeedKmh) {
                state.speedBelowSinceMs = -1L;
                return new Result(state, Effect.none(), IgnoredReason.NONE);
            }
            if (state.speedBelowSinceMs < 0L) state.speedBelowSinceMs = clock.motionAtMs;
            long lowSpeedElapsedMs = clock.motionAtMs - state.speedBelowSinceMs;
            if (lowSpeedElapsedMs < config.endDurationSec * 1000L) {
                return new Result(state, Effect.none(), IgnoredReason.NONE);
            }
            boolean recentDeceleration = state.lastStrongDecelerationAtMs >= 0L
                    && clock.motionAtMs - state.lastStrongDecelerationAtMs
                    <= END_DECELERATION_WINDOW_MS;
            boolean stopLike = speedKmh <= 20d;
            boolean longFallback = lowSpeedElapsedMs >= END_UNRESOLVED_FALLBACK_MS;
            if (!recentDeceleration && !stopLike && !longFallback) {
                return new Result(state, Effect.none(), IgnoredReason.NONE);
            }
            if (state.lastEndProbeAtMs >= 0L
                    && clock.motionAtMs - state.lastEndProbeAtMs < END_PROBE_MIN_INTERVAL_MS) {
                return new Result(state, Effect.none(), IgnoredReason.NONE);
            }
            state.lastEndProbeAtMs = clock.motionAtMs;
            return new Result(
                    state,
                    new Effect(
                            EffectKind.PROBE_END,
                            clock.motionAtMs,
                            speedKmh,
                            acceleration,
                            lowSpeedElapsedMs
                    ),
                    IgnoredReason.NONE
            );
        }

        state.keepSuppressed = false;
        state.speedBelowSinceMs = -1L;
        state.speedRecoveredSinceMs = -1L;
        if (speedKmh < config.startSpeedKmh) {
            state.speedAboveSinceMs = -1L;
            resetStartCandidate(state);
            return new Result(state, Effect.none(), IgnoredReason.NONE);
        }
        if (state.speedAboveSinceMs < 0L) state.speedAboveSinceMs = clock.motionAtMs;
        boolean recentAcceleration = state.lastStrongAccelerationAtMs >= 0L
                && clock.motionAtMs - state.lastStrongAccelerationAtMs
                <= START_ACCELERATION_WINDOW_MS;
        if (!recentAcceleration
                || clock.motionAtMs - state.speedAboveSinceMs < config.startDurationSec * 1000L) {
            return new Result(state, Effect.none(), IgnoredReason.NONE);
        }
        if (state.lastStartProbeAtMs >= 0L
                && clock.motionAtMs - state.lastStartProbeAtMs < START_PROBE_MIN_INTERVAL_MS) {
            return new Result(state, Effect.none(), IgnoredReason.NONE);
        }
        state.lastStartProbeAtMs = clock.motionAtMs;
        return new Result(
                state,
                new Effect(EffectKind.PROBE_START, clock.motionAtMs, speedKmh, acceleration, 0L),
                IgnoredReason.NONE
        );
    }

    static StartSignalResult applyStartSignal(State previous, long motionAtMs, Signal signal) {
        State state = new State(previous);
        if (signal == null
                || !signal.resolved
                || (!signal.onExpresswayRoad && !signal.nearEtcGate)) {
            resetStartCandidate(state);
            return new StartSignalResult(state, false, 0, 0L);
        }
        boolean startsNew = state.startSignalFirstAtMs < 0L
                || state.startSignalLastAtMs < 0L
                || motionAtMs < state.startSignalLastAtMs
                || motionAtMs - state.startSignalLastAtMs > START_SIGNAL_MAX_GAP_MS;
        if (startsNew) {
            state.startSignalFirstAtMs = motionAtMs;
            state.startSignalHits = 1;
        } else {
            state.startSignalHits = Math.min(Integer.MAX_VALUE, state.startSignalHits + 1);
        }
        state.startSignalLastAtMs = motionAtMs;
        long holdMs = Math.max(0L, motionAtMs - state.startSignalFirstAtMs);
        return new StartSignalResult(
                state,
                state.startSignalHits >= START_SIGNAL_MIN_HITS
                        && holdMs >= START_SIGNAL_MIN_HOLD_MS,
                state.startSignalHits,
                holdMs
        );
    }

    static boolean shouldPromptForEnd(Signal signal, long lowSpeedElapsedMs) {
        if (signal != null && signal.resolved) {
            return signal.nearIc || signal.nearEtcGate || !signal.onExpresswayRoad;
        }
        return lowSpeedElapsedMs >= END_UNRESOLVED_FALLBACK_MS;
    }

    static State afterTransition(State previous, boolean keepSuppressed) {
        State state = new State(previous);
        resetMotion(state);
        state.keepSuppressed = keepSuppressed;
        return state;
    }

    private static Clock resolveClock(State state, Point point) {
        boolean hasMonotonic = !point.monotonicSessionId.isEmpty()
                && point.elapsedRealtimeMs >= 0L;
        if (hasMonotonic) {
            if (point.monotonicSessionId.equals(state.lastMonotonicSessionId)
                    && state.lastElapsedRealtimeMs >= 0L) {
                if (point.elapsedRealtimeMs <= state.lastElapsedRealtimeMs) {
                    return Clock.ignored(IgnoredReason.OUT_OF_ORDER);
                }
                return new Clock(
                        point.monotonicSessionId,
                        point.elapsedRealtimeMs,
                        point.elapsedRealtimeMs,
                        false,
                        IgnoredReason.NONE
                );
            }
            return new Clock(
                    point.monotonicSessionId,
                    point.elapsedRealtimeMs,
                    point.elapsedRealtimeMs,
                    state.lastMotionAtMs >= 0L,
                    IgnoredReason.NONE
            );
        }
        if (point.wallAtMs <= 0L) return Clock.ignored(IgnoredReason.INVALID_TIME);
        if (!state.lastMonotonicSessionId.isEmpty()) {
            return new Clock("", -1L, point.wallAtMs, true, IgnoredReason.NONE);
        }
        if (state.lastMotionAtMs >= 0L && point.wallAtMs <= state.lastMotionAtMs) {
            return Clock.ignored(IgnoredReason.OUT_OF_ORDER);
        }
        return new Clock("", -1L, point.wallAtMs, false, IgnoredReason.NONE);
    }

    private static Double deriveAcceleration(
            Double previousSpeedMs,
            long previousAtMs,
            double speedMs,
            long atMs
    ) {
        if (previousSpeedMs == null || previousAtMs < 0L) return null;
        double elapsedSec = (atMs - previousAtMs) / 1000d;
        if (!Double.isFinite(elapsedSec) || elapsedSec < 1d || elapsedSec > 30d) return null;
        return (speedMs - previousSpeedMs) / elapsedSec;
    }

    private static void resetMotion(State state) {
        state.lastSpeedMs = null;
        state.lastSpeedAtMs = -1L;
        state.speedAboveSinceMs = -1L;
        state.speedBelowSinceMs = -1L;
        state.speedRecoveredSinceMs = -1L;
        state.lastStrongAccelerationAtMs = -1L;
        state.lastStrongDecelerationAtMs = -1L;
        state.lastStartProbeAtMs = -1L;
        state.lastEndProbeAtMs = -1L;
        resetStartCandidate(state);
    }

    private static void resetSpeedWindows(State state) {
        state.lastSpeedMs = null;
        state.lastSpeedAtMs = -1L;
        state.speedAboveSinceMs = -1L;
        state.speedBelowSinceMs = -1L;
        state.speedRecoveredSinceMs = -1L;
        resetStartCandidate(state);
    }

    private static void resetStartCandidate(State state) {
        state.startSignalFirstAtMs = -1L;
        state.startSignalLastAtMs = -1L;
        state.startSignalHits = 0;
    }

    private static final class Clock {
        final String sessionId;
        final long elapsedRealtimeMs;
        final long motionAtMs;
        final boolean resetMotion;
        final IgnoredReason ignored;

        Clock(
                String sessionId,
                long elapsedRealtimeMs,
                long motionAtMs,
                boolean resetMotion,
                IgnoredReason ignored
        ) {
            this.sessionId = sessionId;
            this.elapsedRealtimeMs = elapsedRealtimeMs;
            this.motionAtMs = motionAtMs;
            this.resetMotion = resetMotion;
            this.ignored = ignored;
        }

        static Clock ignored(IgnoredReason reason) {
            return new Clock("", -1L, -1L, false, reason);
        }
    }
}
