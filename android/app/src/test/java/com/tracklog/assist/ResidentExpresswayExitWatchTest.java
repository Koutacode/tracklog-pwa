package com.tracklog.assist;

import static org.junit.Assert.*;
import org.junit.Test;

public class ResidentExpresswayExitWatchTest {
    private static final ResidentExpresswayDetectionPolicy.Signal MOTORWAY = signal(true, true, false, false);
    private static final ResidentExpresswayDetectionPolicy.Signal OUTSIDE = signal(true, false, false, false);
    private static final ResidentExpresswayDetectionPolicy.Signal GATE = signal(true, true, true, true);
    private static final ResidentExpresswayDetectionPolicy.Signal UNKNOWN = signal(false, false, false, false);

    @Test public void tenSecondDecelerationThenAccelerationKeepsTheGateCandidate() {
        ResidentExpresswayExitWatch.State state = observe(empty(), fix(1_000, 0, 80), false);
        ResidentExpresswayExitWatch.Fix gate = fix(11_000, .001, 18);
        state = observe(state, gate, true);
        state = observe(state, fix(21_000, .003, 65), false);
        ResidentExpresswayExitWatch.Selection selected = ResidentExpresswayExitWatch.select(state, fix(21_000, .003, 65));
        assertEquals(ResidentExpresswayExitWatch.BRIEF, selected.mode);
        assertSame(gate, selected.fix);
        assertTrue(ResidentExpresswayExitWatch.shouldPrompt(state, selected, GATE));
        assertFalse(ResidentExpresswayExitWatch.shouldPrompt(state, selected, MOTORWAY));
        assertFalse(ResidentExpresswayExitWatch.shouldPrompt(state, selected, UNKNOWN));
    }

    @Test public void missedLowSpeedSampleUsesTwoMovingRoadChecksAtNormalSpeed() {
        ResidentExpresswayExitWatch.State state = observe(empty(), fix(1_000, 0, 65), false);
        assertNull(ResidentExpresswayExitWatch.select(state, fix(60_999, .01, 65)));
        ResidentExpresswayExitWatch.Selection first = ResidentExpresswayExitWatch.select(state, fix(61_000, .01, 65));
        assertEquals(ResidentExpresswayExitWatch.ROAD, first.mode);
        assertFalse(ResidentExpresswayExitWatch.shouldPrompt(state, first, OUTSIDE));
        state = ResidentExpresswayExitWatch.resolved(state.queried(first.fix, first.mode), first.fix, OUTSIDE);
        ResidentExpresswayExitWatch.Selection second = ResidentExpresswayExitWatch.select(state, fix(121_000, .02, 65));
        assertTrue(ResidentExpresswayExitWatch.shouldPrompt(state, second, OUTSIDE));
        assertFalse(ResidentExpresswayExitWatch.shouldPrompt(state, second, MOTORWAY));
    }

    @Test public void periodicCheckDoesNotTreatNearbyIcOrMainlineTollAsExit() {
        ResidentExpresswayExitWatch.Selection road = new ResidentExpresswayExitWatch.Selection(ResidentExpresswayExitWatch.ROAD, fix(61_000, .01, 80));
        assertFalse(ResidentExpresswayExitWatch.shouldPrompt(empty(), road, GATE));
        ResidentExpresswayExitWatch.Selection brief = new ResidentExpresswayExitWatch.Selection(ResidentExpresswayExitWatch.BRIEF, road.fix);
        assertFalse(ResidentExpresswayExitWatch.shouldPrompt(empty(), brief, signal(true, true, true, false)));
    }

    @Test public void stoppedSaAndJamDoNotGenerateStationarySupplementalPolling() {
        ResidentExpresswayExitWatch.State state = observe(empty(), fix(1_000, 0, 0), false);
        for (long at = 11_000; at <= 600_000; at += 10_000) {
            assertNull(ResidentExpresswayExitWatch.select(state, fix(at, .0001, 0)));
        }
        // Existing 24-second / unresolved 90-second SA path remains independent.
        assertTrue(ResidentExpresswayDetectionPolicy.shouldPromptForEnd(OUTSIDE, 24_000));
        assertTrue(ResidentExpresswayDetectionPolicy.shouldPromptForEnd(UNKNOWN, 90_000));
        assertFalse(ResidentExpresswayDetectionPolicy.shouldPromptForEnd(MOTORWAY, 90_000));
    }

    @Test public void roadEvidenceRequiresDifferentLocationsNotDuplicateResponses() {
        ResidentExpresswayExitWatch.Fix first = fix(61_000, .01, 60);
        ResidentExpresswayExitWatch.State state = ResidentExpresswayExitWatch.resolved(empty(), first, OUTSIDE);
        assertFalse(ResidentExpresswayExitWatch.shouldPrompt(state, new ResidentExpresswayExitWatch.Selection(ResidentExpresswayExitWatch.ROAD, first), OUTSIDE));
        assertFalse(ResidentExpresswayExitWatch.shouldPrompt(state, new ResidentExpresswayExitWatch.Selection(ResidentExpresswayExitWatch.ROAD, fix(121_000, .0101, 60)), OUTSIDE));
        assertTrue(ResidentExpresswayExitWatch.shouldPrompt(state, new ResidentExpresswayExitWatch.Selection(ResidentExpresswayExitWatch.ROAD, fix(121_000, .02, 60)), OUTSIDE));
    }

    @Test public void unresolvedOrMotorwayResultBreaksConsecutiveOutsideEvidence() {
        ResidentExpresswayExitWatch.State state = ResidentExpresswayExitWatch.resolved(empty(), fix(61_000, .01, 60), OUTSIDE);
        state = ResidentExpresswayExitWatch.resolved(state, fix(121_000, .02, 60), UNKNOWN);
        assertNull(state.outside);
        state = ResidentExpresswayExitWatch.resolved(state, fix(181_000, .03, 60), OUTSIDE);
        state = ResidentExpresswayExitWatch.resolved(state, fix(241_000, .04, 60), MOTORWAY);
        assertNull(state.outside);
    }

    @Test public void delayedBriefWaitsBehindPendingWorkAndIsNotReplacedByAcceleration() {
        ResidentExpresswayExitWatch.State state = observe(empty(), fix(1_000, 0, 80), false);
        ResidentExpresswayExitWatch.Fix previous = fix(61_000, .01, 80);
        state = state.queried(previous, ResidentExpresswayExitWatch.ROAD);
        ResidentExpresswayExitWatch.Fix gate = fix(71_000, .011, 18);
        state = observe(state, gate, true);
        assertNull(ResidentExpresswayExitWatch.select(state, gate));
        state = observe(state, fix(91_000, .02, 70), false);
        assertSame(gate, ResidentExpresswayExitWatch.select(state, fix(91_000, .02, 70)).fix);
    }

    @Test public void offlineEvidenceExpiresAndFreshMovingChecksCanResume() {
        ResidentExpresswayExitWatch.State state = observe(empty(), fix(1_000, 0, 80), false);
        state = observe(state, fix(11_000, .001, 18), true);
        state = ResidentExpresswayExitWatch.resolved(state, fix(11_000, .001, 18), OUTSIDE);
        state = observe(state, fix(400_000, .1, 60), false);
        assertNull(state.brief);
        assertNull(state.outside);
        assertEquals(ResidentExpresswayExitWatch.ROAD, ResidentExpresswayExitWatch.select(state, fix(400_000, .1, 60)).mode);
    }

    @Test public void keepAtSaSuppressesSamePlaceButAllowsLaterExitBelowRecoverySpeed() {
        ResidentExpresswayExitWatch.State state = empty().kept(fix(1_000, 0, 0));
        for (long at = 61_000; at < 300_000; at += 60_000) {
            state = ResidentExpresswayExitWatch.observe(state, fix(at, .001, 20), true, true);
            assertNull(ResidentExpresswayExitWatch.select(state, fix(at, .001, 20)));
        }
        // Entire later sequence stays under the old 42 km/h recovery threshold.
        ResidentExpresswayExitWatch.Fix first = fix(301_000, .01, 30);
        state = ResidentExpresswayExitWatch.observe(state, first, false, true);
        ResidentExpresswayExitWatch.Selection selection = ResidentExpresswayExitWatch.select(state, first);
        assertNotNull(selection);
        assertFalse(ResidentExpresswayExitWatch.shouldPrompt(state, selection, OUTSIDE));
        state = ResidentExpresswayExitWatch.resolved(state.queried(first, selection.mode), first, OUTSIDE);
        selection = ResidentExpresswayExitWatch.select(state, fix(361_000, .02, 30));
        assertTrue(ResidentExpresswayExitWatch.shouldPrompt(state, selection, OUTSIDE));
    }

    @Test public void rehydratedStateRetainsKeepAnchorBriefAndOutsideEvidence() {
        ResidentExpresswayExitWatch.State state = empty().kept(fix(1_000, 0, 0));
        state = ResidentExpresswayExitWatch.observe(state, fix(61_000, .01, 20), true, true);
        state = ResidentExpresswayExitWatch.resolved(state, fix(61_000, .01, 20), OUTSIDE);
        // Pure state rehydration; SharedPreferences JSON round-trip is tested in androidTest.
        ResidentExpresswayExitWatch.State restored = new ResidentExpresswayExitWatch.State(state.origin, state.lastProbe, state.outside, state.keep, state.brief);
        assertNotNull(ResidentExpresswayExitWatch.select(restored, fix(71_000, .02, 70)));
        assertSame(state.keep, restored.keep);
        assertSame(state.outside, restored.outside);
    }

    @Test public void steadyMovingRoadCheckIsAtMostOncePerMinute() {
        ResidentExpresswayExitWatch.State state = observe(empty(), fix(1_000, 0, 80), false);
        int probes = 0;
        for (int sample = 1; sample <= 360; sample++) {
            ResidentExpresswayExitWatch.Fix fix = fix(1_000 + sample * 10_000L, sample * .002, 80);
            state = observe(state, fix, false);
            ResidentExpresswayExitWatch.Selection selection = ResidentExpresswayExitWatch.select(state, fix);
            if (selection != null) {
                probes++;
                state = ResidentExpresswayExitWatch.resolved(state.queried(fix, selection.mode), fix, MOTORWAY);
            }
        }
        assertEquals(60, probes);
    }

    @Test public void noisyRepeatedBriefCandidatesAreRateLimitedToTwoPerMinute() {
        ResidentExpresswayExitWatch.State state = observe(empty(), fix(1_000, 0, 80), false);
        int probes = 0;
        for (int sample = 1; sample <= 360; sample++) {
            ResidentExpresswayExitWatch.Fix fix = fix(1_000 + sample * 10_000L, sample * .002, 18);
            state = observe(state, fix, true);
            ResidentExpresswayExitWatch.Selection selection = ResidentExpresswayExitWatch.select(state, fix);
            if (selection != null) {
                probes++;
                state = ResidentExpresswayExitWatch.resolved(state.queried(fix, selection.mode), selection.fix, MOTORWAY);
            }
        }
        assertEquals(120, probes);
    }

    @Test public void poorOrMissingAccuracyDoesNotCreateSupplementalEvidence() {
        ResidentExpresswayExitWatch.State state = empty();
        for (double accuracy : new double[] {51d, Double.NaN, -1d}) {
            ResidentExpresswayExitWatch.Fix fix = new ResidentExpresswayExitWatch.Fix(1_000, 0, 0, accuracy, 20);
            assertSame(state, observe(state, fix, true));
            assertNull(ResidentExpresswayExitWatch.select(state, fix));
        }
    }

    @Test public void clockRollbackClearsEvidenceAndDoesNotStrandChecks() {
        ResidentExpresswayExitWatch.State state = observe(empty(), fix(1_000_000, 0, 80), false);
        state = ResidentExpresswayExitWatch.resolved(state, fix(1_010_000, .01, 60), OUTSIDE);
        state = observe(state, fix(1_000, .02, 60), false);
        assertNull(state.outside);
        assertNotNull(ResidentExpresswayExitWatch.select(state, fix(61_000, .03, 60)));
    }

    @Test public void expiredOrOutOfOrderOutsideEvidenceNeverConfirms() {
        ResidentExpresswayExitWatch.State state = ResidentExpresswayExitWatch.resolved(empty(), fix(61_000, .01, 60), OUTSIDE);
        for (long at : new long[] {1_000, 361_001}) {
            assertFalse(ResidentExpresswayExitWatch.shouldPrompt(state,
                    new ResidentExpresswayExitWatch.Selection(ResidentExpresswayExitWatch.ROAD, fix(at, .02, 60)), OUTSIDE));
        }
    }

    private static ResidentExpresswayExitWatch.State empty() { return ResidentExpresswayExitWatch.State.empty(); }
    private static ResidentExpresswayExitWatch.State observe(ResidentExpresswayExitWatch.State state, ResidentExpresswayExitWatch.Fix fix, boolean brief) {
        return ResidentExpresswayExitWatch.observe(state, fix, brief, false);
    }
    private static ResidentExpresswayExitWatch.Fix fix(long at, double lon, double speed) {
        return new ResidentExpresswayExitWatch.Fix(at, 0d, lon, 10d, speed);
    }
    private static ResidentExpresswayDetectionPolicy.Signal signal(boolean resolved, boolean onRoad, boolean nearIc, boolean gate) {
        return new ResidentExpresswayDetectionPolicy.Signal(resolved, onRoad, nearIc, gate);
    }
}
