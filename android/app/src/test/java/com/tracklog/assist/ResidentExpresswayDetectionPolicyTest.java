package com.tracklog.assist;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ResidentExpresswayDetectionPolicyTest {
    private static final ResidentExpresswayDetectionPolicy.Config CONFIG =
            ResidentExpresswayDetectionPolicy.Config.DEFAULT;

    @Test
    public void startRequiresAccelerationSustainedSpeedAndTwoStrongSignalsHeldTwelveSeconds() {
        ResidentExpresswayDetectionPolicy.State state = state("trip");
        state = advance(state, point(1_000L, 50d), false).state;
        state = advance(state, point(11_000L, 80d), false).state;

        ResidentExpresswayDetectionPolicy.Result firstProbe =
                advance(state, point(17_000L, 82d), false);
        assertEquals(
                ResidentExpresswayDetectionPolicy.EffectKind.PROBE_START,
                firstProbe.effect.kind
        );
        ResidentExpresswayDetectionPolicy.StartSignalResult firstSignal =
                ResidentExpresswayDetectionPolicy.applyStartSignal(
                        firstProbe.state,
                        17_000L,
                        strongSignal()
                );
        assertFalse(firstSignal.shouldStart);
        assertEquals(1, firstSignal.hits);

        ResidentExpresswayDetectionPolicy.Result secondProbe =
                advance(firstSignal.state, point(27_000L, 83d), false);
        ResidentExpresswayDetectionPolicy.StartSignalResult secondSignal =
                ResidentExpresswayDetectionPolicy.applyStartSignal(
                        secondProbe.state,
                        27_000L,
                        strongSignal()
                );
        assertFalse(secondSignal.shouldStart);
        assertEquals(10_000L, secondSignal.holdMs);

        ResidentExpresswayDetectionPolicy.Result thirdProbe =
                advance(secondSignal.state, point(37_000L, 84d), false);
        ResidentExpresswayDetectionPolicy.StartSignalResult thirdSignal =
                ResidentExpresswayDetectionPolicy.applyStartSignal(
                        thirdProbe.state,
                        37_000L,
                        strongSignal()
                );
        assertTrue(thirdSignal.shouldStart);
        assertEquals(3, thirdSignal.hits);
        assertEquals(20_000L, thirdSignal.holdMs);
    }

    @Test
    public void speedAloneNeverStartsWithoutRecentAcceleration() {
        ResidentExpresswayDetectionPolicy.State state = state("trip");
        state = advance(state, point(1_000L, 82d), false).state;
        state = advance(state, point(11_000L, 82d), false).state;
        ResidentExpresswayDetectionPolicy.Result result =
                advance(state, point(31_000L, 84d), false);

        assertEquals(ResidentExpresswayDetectionPolicy.EffectKind.NONE, result.effect.kind);
    }

    @Test
    public void weakRoadSignalResetsStartConfirmation() {
        ResidentExpresswayDetectionPolicy.State state = state("trip");
        ResidentExpresswayDetectionPolicy.StartSignalResult first =
                ResidentExpresswayDetectionPolicy.applyStartSignal(state, 1_000L, strongSignal());
        ResidentExpresswayDetectionPolicy.StartSignalResult weak =
                ResidentExpresswayDetectionPolicy.applyStartSignal(
                        first.state,
                        14_000L,
                        new ResidentExpresswayDetectionPolicy.Signal(true, false, false, false)
                );

        assertFalse(weak.shouldStart);
        assertEquals(0, weak.hits);
        assertEquals(0, weak.state.startSignalHits);
    }

    @Test
    public void endOnlyProducesPromptProbeAndStillRequiresRoadExitEvidence() {
        ResidentExpresswayDetectionPolicy.State state = state("trip");
        state = advance(state, point(1_000L, 80d), true).state;
        state = advance(state, point(11_000L, 15d), true).state;
        ResidentExpresswayDetectionPolicy.Result result =
                advance(state, point(35_000L, 10d), true);

        assertEquals(ResidentExpresswayDetectionPolicy.EffectKind.PROBE_END, result.effect.kind);
        assertFalse(ResidentExpresswayDetectionPolicy.shouldPromptForEnd(
                new ResidentExpresswayDetectionPolicy.Signal(true, true, false, false),
                result.effect.lowSpeedElapsedMs
        ));
        assertTrue(ResidentExpresswayDetectionPolicy.shouldPromptForEnd(
                new ResidentExpresswayDetectionPolicy.Signal(true, false, true, false),
                result.effect.lowSpeedElapsedMs
        ));
        assertFalse(ResidentExpresswayDetectionPolicy.shouldPromptForEnd(
                new ResidentExpresswayDetectionPolicy.Signal(false, false, false, false),
                89_999L
        ));
        assertTrue(ResidentExpresswayDetectionPolicy.shouldPromptForEnd(
                new ResidentExpresswayDetectionPolicy.Signal(false, false, false, false),
                90_000L
        ));
    }

    @Test
    public void keepSuppressesNewPromptUntilTwentySecondsOfRecovery() {
        ResidentExpresswayDetectionPolicy.State state = state("trip");
        state.keepSuppressed = true;
        ResidentExpresswayDetectionPolicy.Result first =
                advance(state, point(1_000L, 50d), true);
        ResidentExpresswayDetectionPolicy.Result recovered =
                advance(first.state, point(21_000L, 55d), true);

        assertEquals(ResidentExpresswayDetectionPolicy.EffectKind.CLEAR_KEEP, recovered.effect.kind);
        assertFalse(recovered.state.keepSuppressed);
    }

    @Test
    public void monotonicClockRejectsReverseAndResetsAcrossBootSession() {
        ResidentExpresswayDetectionPolicy.State state = state("trip");
        state = advance(state, point(10_000L, 50d), false).state;
        ResidentExpresswayDetectionPolicy.Result reverse =
                ResidentExpresswayDetectionPolicy.advance(
                        state,
                        new ResidentExpresswayDetectionPolicy.Point(
                                "trip", 2_000_000L, "boot", 9_000L,
                                true, 10d, true, 20d
                        ),
                        CONFIG,
                        false,
                        false
                );
        assertEquals(ResidentExpresswayDetectionPolicy.IgnoredReason.OUT_OF_ORDER, reverse.ignoredReason);

        ResidentExpresswayDetectionPolicy.Result nextBoot =
                ResidentExpresswayDetectionPolicy.advance(
                        state,
                        new ResidentExpresswayDetectionPolicy.Point(
                                "trip", 1L, "next-boot", 100L,
                                true, 10d, true, 30d
                        ),
                        CONFIG,
                        false,
                        false
                );
        assertEquals(ResidentExpresswayDetectionPolicy.EffectKind.NONE, nextBoot.effect.kind);
        assertEquals("next-boot", nextBoot.state.lastMonotonicSessionId);
        assertEquals(100L, nextBoot.state.lastElapsedRealtimeMs);
        assertEquals(-1L, nextBoot.state.lastStrongAccelerationAtMs);
    }

    @Test
    public void poorAccuracyAndImpossibleSpeedAreRejectedForDetection() {
        ResidentExpresswayDetectionPolicy.State state = state("trip");
        ResidentExpresswayDetectionPolicy.Result accuracy =
                ResidentExpresswayDetectionPolicy.advance(
                        state,
                        new ResidentExpresswayDetectionPolicy.Point(
                                "trip", 1_000L, "boot", 1_000L,
                                true, 101d, true, 20d
                        ),
                        CONFIG,
                        false,
                        false
                );
        assertEquals(ResidentExpresswayDetectionPolicy.IgnoredReason.POOR_ACCURACY, accuracy.ignoredReason);

        ResidentExpresswayDetectionPolicy.Result speed =
                ResidentExpresswayDetectionPolicy.advance(
                        accuracy.state,
                        new ResidentExpresswayDetectionPolicy.Point(
                                "trip", 2_000L, "boot", 2_000L,
                                true, 10d, true, 62d
                        ),
                        CONFIG,
                        false,
                        false
                );
        assertEquals(ResidentExpresswayDetectionPolicy.IgnoredReason.INVALID_SPEED, speed.ignoredReason);
    }

    @Test
    public void durableProbeRevisionPreventsOldSignalFromReopeningAfterDecision() {
        assertTrue(ResidentExpresswayStore.canApplyProbe("trip", 4L, "trip", 4L));
        assertFalse(ResidentExpresswayStore.canApplyProbe("trip", 4L, "trip", 5L));
        assertFalse(ResidentExpresswayStore.canApplyProbe("trip-old", 4L, "trip", 4L));
    }

    @Test
    public void durableProbeBackoffIsBoundedAndClockRollbackCannotStrandIt() {
        assertEquals(30_000L, ResidentExpresswayStore.probeRetryDelayMs(1));
        assertEquals(60_000L, ResidentExpresswayStore.probeRetryDelayMs(2));
        assertEquals(15L * 60L * 1000L, ResidentExpresswayStore.probeRetryDelayMs(30));
        assertFalse(ResidentExpresswayStore.isProbeRetryDue(99_999L, 100_000L));
        assertTrue(ResidentExpresswayStore.isProbeRetryDue(100_000L, 100_000L));
        assertTrue(ResidentExpresswayStore.isProbeRetryDue(1L, 2_000_000L));
    }

    @Test
    public void notificationClosesOnlyAfterDurableDecisionCommit() {
        assertFalse(ResidentExpresswayNotificationReceiver.shouldCloseNotification(false));
        assertTrue(ResidentExpresswayNotificationReceiver.shouldCloseNotification(true));
    }

    @Test
    public void resolverAuthFailuresRemainRetryableInsteadOfStoppingService() {
        assertEquals(
                ResidentLocationUploader.ExpresswayProbeOutcome.AUTHORIZATION_RETRY,
                ResidentLocationUploader.classifyExpresswayProbeStatus(401)
        );
        assertEquals(
                ResidentLocationUploader.ExpresswayProbeOutcome.AUTHORIZATION_RETRY,
                ResidentLocationUploader.classifyExpresswayProbeStatus(403)
        );
        assertEquals(
                ResidentLocationUploader.ExpresswayProbeOutcome.SERVER_RETRY,
                ResidentLocationUploader.classifyExpresswayProbeStatus(503)
        );
    }

    @Test
    public void activeQueueSealsOnlyAfterTwoMinutesIdle() {
        assertFalse(ResidentLocationQueue.shouldSealActiveForIdle(true, 10L, 1_000L, 120_999L, 120_000L));
        assertTrue(ResidentLocationQueue.shouldSealActiveForIdle(true, 10L, 1_000L, 121_000L, 120_000L));
        assertFalse(ResidentLocationQueue.shouldSealActiveForIdle(true, 10L, 2_000L, 1_000L, 120_000L));
        assertFalse(ResidentLocationQueue.shouldSealActiveForIdle(false, 10L, 1_000L, 200_000L, 120_000L));
    }

    private static ResidentExpresswayDetectionPolicy.State state(String tripId) {
        return new ResidentExpresswayDetectionPolicy.State(tripId);
    }

    private static ResidentExpresswayDetectionPolicy.Result advance(
            ResidentExpresswayDetectionPolicy.State state,
            ResidentExpresswayDetectionPolicy.Point point,
            boolean open
    ) {
        return ResidentExpresswayDetectionPolicy.advance(state, point, CONFIG, open, false);
    }

    private static ResidentExpresswayDetectionPolicy.Point point(long elapsedMs, double speedKmh) {
        return new ResidentExpresswayDetectionPolicy.Point(
                "trip",
                1_700_000_000_000L + elapsedMs,
                "boot",
                elapsedMs,
                true,
                10d,
                true,
                speedKmh / 3.6d
        );
    }

    private static ResidentExpresswayDetectionPolicy.Signal strongSignal() {
        return new ResidentExpresswayDetectionPolicy.Signal(true, true, false, false);
    }
}
