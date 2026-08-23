package com.tracklog.assist;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ResidentLocationQualityPolicyTest {
    private static final long NOW_MS = 1_800_000_000_000L;
    private static final long ELAPSED_NOW_NANOS = 900_000_000_000L;

    @Test
    public void acceptsNormalMotorwayMovement() {
        ResidentLocationQualityPolicy.Fix previous = fix(35.0000, 139.0000, NOW_MS - 10_000L, 5f, "gps");
        ResidentLocationQualityPolicy.Fix candidate = fix(35.0032, 139.0000, NOW_MS, 6f, "gps");

        ResidentLocationQualityPolicy.Decision decision =
                ResidentLocationQualityPolicy.evaluate(previous, candidate, NOW_MS, ELAPSED_NOW_NANOS);

        assertTrue(decision.accepted);
        assertEquals(ResidentLocationQualityPolicy.Rejection.NONE, decision.rejection);
    }

    @Test
    public void documentedThresholdBoundariesRemainConservativeForMotorwayTravel() {
        assertEquals(150f, ResidentLocationQualityPolicy.MAX_ACCURACY_METERS, 0f);
        assertEquals(120_000L, ResidentLocationQualityPolicy.MAX_FIX_AGE_MS);
        assertEquals(60_000L, ResidentLocationQualityPolicy.MAX_FUTURE_SKEW_MS);
        assertEquals(15_000L, ResidentLocationQualityPolicy.LOWER_PRIORITY_PROVIDER_WINDOW_MS);
        assertEquals(4_000L, ResidentLocationQualityPolicy.DUPLICATE_WINDOW_MS);
        assertEquals(70d, ResidentLocationQualityPolicy.MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND, 0d);

        ResidentLocationQualityPolicy.Fix previous = fix(
                35d,
                139d,
                NOW_MS - 10_000L,
                ResidentLocationQualityPolicy.MAX_ACCURACY_METERS,
                "gps"
        );
        ResidentLocationQualityPolicy.Fix candidate = fix(
                35.0062,
                139d,
                NOW_MS,
                ResidentLocationQualityPolicy.MAX_ACCURACY_METERS,
                "gps"
        );
        assertTrue(ResidentLocationQualityPolicy.evaluate(
                previous,
                candidate,
                NOW_MS,
                ELAPSED_NOW_NANOS
        ).accepted);
    }

    @Test
    public void rejectsInvalidCoordinatesAndVeryPoorAccuracy() {
        ResidentLocationQualityPolicy.Decision invalid = ResidentLocationQualityPolicy.evaluate(
                null,
                fix(91d, 139d, NOW_MS, 5f, "gps"),
                NOW_MS,
                ELAPSED_NOW_NANOS
        );
        ResidentLocationQualityPolicy.Decision inaccurate = ResidentLocationQualityPolicy.evaluate(
                null,
                fix(35d, 139d, NOW_MS, 151f, "network"),
                NOW_MS,
                ELAPSED_NOW_NANOS
        );

        assertFalse(invalid.accepted);
        assertEquals(ResidentLocationQualityPolicy.Rejection.INVALID_COORDINATES, invalid.rejection);
        assertFalse(inaccurate.accepted);
        assertEquals(ResidentLocationQualityPolicy.Rejection.POOR_ACCURACY, inaccurate.rejection);
    }

    @Test
    public void rejectsStaleFutureAndNonMonotonicTimestamps() {
        ResidentLocationQualityPolicy.Fix previous = fix(35d, 139d, NOW_MS - 1_000L, 5f, "gps");

        assertEquals(
                ResidentLocationQualityPolicy.Rejection.STALE_TIMESTAMP,
                ResidentLocationQualityPolicy.evaluate(
                        null,
                        fix(35d, 139d, NOW_MS - ResidentLocationQualityPolicy.MAX_FIX_AGE_MS - 1L, 5f, "gps"),
                        NOW_MS,
                        ELAPSED_NOW_NANOS
                ).rejection
        );
        assertEquals(
                ResidentLocationQualityPolicy.Rejection.STALE_TIMESTAMP,
                ResidentLocationQualityPolicy.evaluate(
                        null,
                        fix(35d, 139d, NOW_MS + ResidentLocationQualityPolicy.MAX_FUTURE_SKEW_MS + 1L, 5f, "gps"),
                        NOW_MS,
                        ELAPSED_NOW_NANOS
                ).rejection
        );
        assertEquals(
                ResidentLocationQualityPolicy.Rejection.NON_MONOTONIC_TIMESTAMP,
                ResidentLocationQualityPolicy.evaluate(
                        previous,
                        fix(35d, 139d, previous.timestampMs, 5f, "gps"),
                        NOW_MS,
                        ELAPSED_NOW_NANOS
                ).rejection
        );
    }

    @Test
    public void prefersRecentGpsOverNetworkAndDropsNearDuplicates() {
        ResidentLocationQualityPolicy.Fix gps = fix(35d, 139d, NOW_MS - 10_000L, 5f, "gps");
        assertEquals(
                ResidentLocationQualityPolicy.Rejection.LOWER_PRIORITY_PROVIDER,
                ResidentLocationQualityPolicy.evaluate(
                        gps,
                        fix(35.0001, 139.0001, NOW_MS, 20f, "network"),
                        NOW_MS,
                        ELAPSED_NOW_NANOS
                ).rejection
        );

        ResidentLocationQualityPolicy.Fix previousNetwork =
                fix(35d, 139d, NOW_MS - 2_000L, 20f, "network");
        assertEquals(
                ResidentLocationQualityPolicy.Rejection.NEAR_DUPLICATE,
                ResidentLocationQualityPolicy.evaluate(
                        previousNetwork,
                        fix(35.00001, 139.00001, NOW_MS, 20f, "network"),
                        NOW_MS,
                        ELAPSED_NOW_NANOS
                ).rejection
        );
        assertTrue(ResidentLocationQualityPolicy.evaluate(
                previousNetwork,
                fix(35.00001, 139.00001, NOW_MS, 20f, "gps"),
                NOW_MS,
                ELAPSED_NOW_NANOS
        ).accepted);
    }

    @Test
    public void rejectsOnlyJumpsFarAboveRoadSpeed() {
        ResidentLocationQualityPolicy.Fix previous = fix(35d, 139d, NOW_MS - 10_000L, 5f, "gps");
        ResidentLocationQualityPolicy.Decision jump = ResidentLocationQualityPolicy.evaluate(
                previous,
                fix(35.0100, 139d, NOW_MS, 5f, "gps"),
                NOW_MS,
                ELAPSED_NOW_NANOS
        );

        assertFalse(jump.accepted);
        assertEquals(ResidentLocationQualityPolicy.Rejection.IMPLAUSIBLE_JUMP, jump.rejection);
    }

    @Test
    public void elapsedRealtimeWinsWhenWallClockMovesBackward() {
        ResidentLocationQualityPolicy.Fix previous = new ResidentLocationQualityPolicy.Fix(
                35d,
                139d,
                NOW_MS,
                ELAPSED_NOW_NANOS - 10_000_000_000L,
                true,
                5f,
                "gps"
        );
        ResidentLocationQualityPolicy.Fix candidate = new ResidentLocationQualityPolicy.Fix(
                35.0032,
                139d,
                NOW_MS - ResidentLocationQualityPolicy.MAX_FIX_AGE_MS - 60_000L,
                ELAPSED_NOW_NANOS,
                true,
                5f,
                "gps"
        );

        assertTrue(ResidentLocationQualityPolicy.evaluate(
                previous,
                candidate,
                NOW_MS,
                ELAPSED_NOW_NANOS
        ).accepted);
    }

    @Test
    public void missingElapsedRealtimeUsesSafeWallClockFallbackAfterRestart() {
        ResidentLocationQualityPolicy.Fix afterRestart = new ResidentLocationQualityPolicy.Fix(
                35d,
                139d,
                NOW_MS,
                0L,
                true,
                5f,
                "network"
        );
        assertTrue(ResidentLocationQualityPolicy.evaluate(
                null,
                afterRestart,
                NOW_MS,
                ELAPSED_NOW_NANOS
        ).accepted);

        ResidentLocationQualityPolicy.Fix previous = new ResidentLocationQualityPolicy.Fix(
                35d,
                139d,
                NOW_MS,
                0L,
                true,
                5f,
                "network"
        );
        ResidentLocationQualityPolicy.Fix clockCorrectedBackward = new ResidentLocationQualityPolicy.Fix(
                35.0001,
                139d,
                NOW_MS - 1_000L,
                0L,
                true,
                5f,
                "network"
        );
        assertTrue(ResidentLocationQualityPolicy.evaluate(
                previous,
                clockCorrectedBackward,
                NOW_MS,
                ELAPSED_NOW_NANOS
        ).accepted);
    }

    private static ResidentLocationQualityPolicy.Fix fix(
            double latitude,
            double longitude,
            long timestampMs,
            float accuracy,
            String provider
    ) {
        return new ResidentLocationQualityPolicy.Fix(
                latitude,
                longitude,
                timestampMs,
                ELAPSED_NOW_NANOS + (timestampMs - NOW_MS) * 1_000_000L,
                true,
                accuracy,
                provider
        );
    }
}
