package com.tracklog.assist;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import org.junit.Test;

public class ResidentRoutePersistencePolicyTest {
    private ResidentLocationQualityPolicy.Fix fix(long seconds, double meters, float accuracy) {
        return new ResidentLocationQualityPolicy.Fix(0d, Math.toDegrees(meters / 6_371_000d),
                1_800_000_000_000L + seconds * 1_000L, (seconds + 1_000L) * 1_000_000_000L,
                Float.isFinite(accuracy), accuracy, "gps");
    }

    @Test public void stationaryHeartbeatAndDistanceBoundaries() {
        ResidentLocationQualityPolicy.Fix previous = fix(0, 0, 5);
        assertTrue(ResidentRoutePersistencePolicy.shouldPersist(null, 0, previous, 0));
        assertFalse(ResidentRoutePersistencePolicy.shouldPersist(previous, 0, fix(10, 0, 5), 0));
        assertFalse(ResidentRoutePersistencePolicy.shouldPersist(previous, 0, fix(59, 11.9, 35), 0.5f));
        assertTrue(ResidentRoutePersistencePolicy.shouldPersist(previous, 0, fix(60, 0, 5), 0));
        assertTrue(ResidentRoutePersistencePolicy.shouldPersist(previous, 0, fix(10, 12.1, 5), 0));
    }

    @Test public void uncertainFixesAndMovementRemainRecorded() {
        ResidentLocationQualityPolicy.Fix previous = fix(0, 0, 5);
        assertTrue(ResidentRoutePersistencePolicy.shouldPersist(previous, 0, fix(10, 0, 5), Float.NaN));
        assertTrue(ResidentRoutePersistencePolicy.shouldPersist(previous, Float.NaN, fix(10, 0, 5), 0));
        assertTrue(ResidentRoutePersistencePolicy.shouldPersist(previous, 0, fix(10, 0, 36), 0));
        assertTrue(ResidentRoutePersistencePolicy.shouldPersist(previous, 0, fix(10, 0, Float.NaN), 0));
        assertTrue(ResidentRoutePersistencePolicy.shouldPersist(previous, 0, fix(10, 0, 5), -1));
        assertTrue(ResidentRoutePersistencePolicy.shouldPersist(previous, 0, fix(10, 0, 5), 0.6f));
        assertTrue(ResidentRoutePersistencePolicy.shouldPersist(previous, 10, fix(10, 0, 5), 0));
    }

    @Test public void monotonicClockSurvivesWallClockCorrection() {
        ResidentLocationQualityPolicy.Fix previous = fix(0, 0, 5);
        ResidentLocationQualityPolicy.Fix next = fix(10, 0, 5);
        ResidentLocationQualityPolicy.Fix corrected = new ResidentLocationQualityPolicy.Fix(
                next.latitude, next.longitude, previous.timestampMs - 60_000,
                next.elapsedRealtimeNanos, true, 5, "gps");
        assertFalse(ResidentRoutePersistencePolicy.shouldPersist(previous, 0, corrected, 0));
        assertTrue(ResidentRoutePersistencePolicy.shouldPersist(previous, 0, previous, 0));
    }

    @Test public void oneHourSimulationsPreserveMovementAndReduceStationaryWrites() {
        assertEquals(60, countHour(false));
        assertEquals(360, countHour(true));
        System.out.println("synthetic 1h / 10s: stationary 360 -> 60, moving 360 -> 360");
    }

    private int countHour(boolean moving) {
        int persisted = 0;
        ResidentLocationQualityPolicy.Fix previous = null;
        float speed = moving ? 15f : 0f;
        for (int seconds = 0; seconds < 3_600; seconds += 10) {
            ResidentLocationQualityPolicy.Fix next = fix(seconds, moving ? seconds * 15d : seconds % 3, 5);
            if (ResidentRoutePersistencePolicy.shouldPersist(previous, speed, next, speed)) {
                previous = next;
                persisted++;
            }
        }
        return persisted;
    }
}
