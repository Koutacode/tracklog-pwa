package com.tracklog.assist;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

/** Synthetic motion and isolated JVM preferences only; no device, GPS, or network access. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, manifest = Config.NONE)
public class ResidentExpresswayUnavailableEndTest {
    private static final String TRIP = "synthetic-unavailable-trip";
    private static final String SESSION = "synthetic-unavailable-boot";
    private static final long WALL_BASE = 1_767_225_600_000L;
    private static final long LOW_START = 1_000L;
    private static final long PROBE_AT = 25_000L;
    private static final double LAT = 35d;
    private static final double LON = 139d;
    private static final ResidentExpresswayDetectionPolicy.Config CONFIG =
            ResidentExpresswayDetectionPolicy.Config.DEFAULT;
    private Context context;

    @Before public void setup() {
        context = RuntimeEnvironment.getApplication();
        assertTrue(ResidentExpresswayStore.clearPrivateData(context));
        assertTrue(ResidentExpresswayStore.reconcile(context, TRIP, true, CONFIG));
    }

    @Test public void serverFailureUsesFreshLowSpeedEvidenceAndPreservesOriginalDetection() throws Exception {
        Fixture fixture = failedProbe("server");
        reach(fixture, LOW_START + 90_000L);
        // Each new low-speed probe was blocked by the durable first request before this fix.
        assertNull(ResidentExpresswayStore.createProbe(context, ResidentExpresswayStore.ProbeKind.END,
                TRIP, iso(91_000), WALL_BASE + 91_000, LAT + .01, LON + .01, 10d,
                5d, null, 90_000, SESSION, 91_000));
        String promptId = prompt(fixture);
        assertFalse(promptId.isEmpty());
        ResidentExpresswayStore.Snapshot snapshot = ResidentExpresswayStore.snapshot(context);
        assertTrue("The driver must still choose end or keep", snapshot.open);
        assertNull(snapshot.pendingProbe);
        assertEquals(1, snapshot.events.size());
        ResidentExpresswayStore.Event event = snapshot.pendingPrompt;
        assertEquals(ResidentExpresswayStore.EventKind.END_PROMPT, event.kind);
        assertEquals(fixture.probe.detectedAt, event.detectedAt);
        assertEquals(LAT, event.latitude, 0d);
        assertEquals(LON, event.longitude, 0d);
        assertEquals(PROBE_AT, event.elapsedRealtimeMs);
        assertEquals(fixture.probe.detectedAt, event.reason.getString("evaluatedAt"));
        assertFalse(event.reason.getBoolean("signalResolved"));
        assertFalse(event.reason.getBoolean("onExpresswayRoad"));
        assertFalse(event.reason.getBoolean("nearIc"));
        assertFalse(event.reason.getBoolean("nearEtcGate"));
        assertFalse(event.reason.has("nearestIcName"));
        assertTrue(ResidentExpresswayStore.recordDecision(context, promptId, true,
                WALL_BASE + 120_000).stored);
        ResidentExpresswayStore.Snapshot ended = ResidentExpresswayStore.snapshot(context);
        assertFalse(ended.open);
        ResidentExpresswayStore.Event decision = ended.events.get(1);
        assertEquals(event.detectedAt, decision.detectedAt);
        assertEquals(iso(120_000), decision.decidedAt);
        assertEquals(LAT, decision.latitude, 0d);
        assertEquals(LON, decision.longitude, 0d);
    }

    @Test public void networkFailureCanBeKeptWithoutAutomaticallyEnding() {
        Fixture fixture = failedProbe("network");
        reach(fixture, LOW_START + 90_000);
        String promptId = prompt(fixture);
        assertFalse(promptId.isEmpty());
        assertTrue(ResidentExpresswayStore.recordDecision(context, promptId, false,
                WALL_BASE + 120_000).stored);
        ResidentExpresswayStore.Snapshot kept = ResidentExpresswayStore.snapshot(context);
        assertTrue(kept.open);
        assertTrue(kept.keepSuppressed);
        assertEquals(2, kept.events.size());
        assertEquals(ResidentExpresswayStore.EventKind.DECISION_KEEP, kept.events.get(1).kind);
        assertEquals(fixture.probe.detectedAt, kept.events.get(1).detectedAt);
        assertEquals("", prompt(fixture));
    }

    @Test public void ninetySecondThresholdUsesLatestGpsRatherThanOriginalTwentyFourSeconds() {
        Fixture fixture = failedProbe("server");
        reach(fixture, LOW_START + 89_999);
        assertEquals(24_000, fixture.probe.lowSpeedElapsedMs);
        assertEquals("", prompt(fixture));
        assertEquals(fixture.probe.id, ResidentExpresswayStore.snapshot(context).pendingProbe.id);
        reach(fixture, LOW_START + 90_000);
        assertFalse(prompt(fixture).isEmpty());
    }

    @Test public void authorizationResponseAndUnfailedRequestsRetainTheirOriginalBackoff() {
        for (String failure : new String[] {"authorization", "response", ""}) {
            setup();
            Fixture fixture = failedProbe(failure);
            reach(fixture, LOW_START + 90_000);
            String before = encodedState();
            assertEquals(failure, "", prompt(fixture));
            assertEquals("No failure classification or retry delay is rewritten", before, encodedState());
        }
    }

    @Test public void fallbackRejectsStartAndSupplementalProbeKinds() throws Exception {
        for (String mode : new String[] {"start", ResidentExpresswayExitWatch.BRIEF,
                ResidentExpresswayExitWatch.ROAD}) {
            setup();
            Fixture fixture = failedProbe("network");
            reach(fixture, LOW_START + 90_000);
            JSONObject root = new JSONObject(encodedState());
            JSONObject probe = root.getJSONObject("pendingProbe");
            if ("start".equals(mode)) probe.put("kind", "start");
            else probe.put("endMode", mode);
            saveState(root);
            assertEquals(mode, "", prompt(fixture));
            assertEquals(0, ResidentExpresswayStore.snapshot(context).events.size());
        }
    }

    @Test public void staleRevisionOtherTripAndOtherClockSessionCannotPrompt() {
        Fixture fixture = failedProbe("server");
        reach(fixture, LOW_START + 90_000);
        assertEquals("", ResidentExpresswayStore.tryCommitUnavailableEndPrompt(context,
                fixture.revision + 1, fixture.motion));
        assertEquals("", ResidentExpresswayStore.tryCommitUnavailableEndPrompt(context,
                fixture.revision, new ResidentExpresswayDetectionPolicy.State("other-trip")));
        fixture.motion = sample(fixture.motion, 92_000, 5d, 10d, "different-boot");
        reach(fixture, 182_000, "different-boot");
        assertEquals("", prompt(fixture));
        assertEquals(fixture.probe.id, ResidentExpresswayStore.snapshot(context).pendingProbe.id);
    }

    @Test public void pausedOrManuallyClosedSectionsCannotProducePrompt() {
        for (boolean pause : new boolean[] {true, false}) {
            setup();
            Fixture fixture = failedProbe("server");
            reach(fixture, LOW_START + 90_000);
            assertTrue(ResidentExpresswayStore.reconcile(context, pause ? "" : TRIP,
                    pause, CONFIG));
            assertEquals("", prompt(fixture));
            assertEquals(0, ResidentExpresswayStore.snapshot(context).events.size());
        }
    }

    @Test public void persistedKeepSuppressionRejectsEvenPreviouslyReadyMotion() throws Exception {
        Fixture fixture = failedProbe("server");
        reach(fixture, LOW_START + 90_000);
        JSONObject root = new JSONObject(encodedState()).put("keepSuppressed", true);
        saveState(root);
        assertEquals("", prompt(fixture));
        assertTrue(ResidentExpresswayStore.snapshot(context).open);
        assertEquals(0, ResidentExpresswayStore.snapshot(context).events.size());
    }

    @Test public void brokenLowSpeedEpisodesNeverReuseTheOldDetectionPoint() {
        for (String interruption : new String[] {"acceleration", "poor-accuracy", "missing-accuracy",
                "invalid-speed", "sample-gap"}) {
            setup();
            Fixture fixture = failedProbe("network");
            reach(fixture, 45_000);
            long interruptionAt = "sample-gap".equals(interruption) ? 76_001 : 55_000;
            double speed = "acceleration".equals(interruption) ? 50d
                    : "invalid-speed".equals(interruption) ? Double.NaN : 5d;
            Double accuracy = 10d;
            if ("poor-accuracy".equals(interruption)) accuracy = 101d;
            if ("missing-accuracy".equals(interruption)) accuracy = null;
            fixture.motion = sample(fixture.motion, interruptionAt, speed, accuracy, SESSION);
            reach(fixture, interruptionAt + 120_000);
            assertTrue("New low-speed episode is otherwise long enough: " + interruption,
                    fixture.motion.lastMotionAtMs - fixture.motion.continuousLowSpeedSinceMs >= 90_000);
            assertEquals(interruption, "", prompt(fixture));
            assertEquals(fixture.probe.id, ResidentExpresswayStore.snapshot(context).pendingProbe.id);
            assertEquals(fixture.probe.detectedAt,
                    ResidentExpresswayStore.snapshot(context).pendingProbe.detectedAt);
        }
    }

    @Test public void restoredLegacyProbeWithoutMonotonicEvidenceDoesNotGuess() throws Exception {
        Fixture fixture = failedProbe("network");
        reach(fixture, LOW_START + 90_000);
        JSONObject root = new JSONObject(encodedState());
        root.getJSONObject("pendingProbe").remove("monotonicSessionId");
        root.getJSONObject("pendingProbe").remove("elapsedRealtimeMs");
        saveState(root);
        assertTrue(ResidentExpresswayStore.snapshot(context).storageHealthy);
        assertEquals("", prompt(fixture));
    }

    @Test public void lateResponsesAndRepeatedReadyFixesCannotDuplicateThePrompt() {
        Fixture fixture = failedProbe("server");
        reach(fixture, LOW_START + 90_000);
        String promptId = prompt(fixture);
        assertFalse(promptId.isEmpty());
        assertEquals("", prompt(fixture));
        assertEquals("", ResidentExpresswayStore.commitEndPrompt(context, fixture.probe.id,
                new ResidentExpresswayStore.SignalDetails(true, false, true, true, "Synthetic IC", 10d)));
        assertFalse(ResidentExpresswayStore.markProbeFailure(context, fixture.probe.id,
                "server", WALL_BASE + 92_000));
        assertEquals(promptId, ResidentExpresswayStore.snapshot(context).promptId);
        assertEquals(1, ResidentExpresswayStore.snapshot(context).events.size());
    }

    @Test public void longerConfiguredHoldCannotBeBypassedWithoutAnExistingEndProbe() {
        ResidentExpresswayDetectionPolicy.Config custom =
                new ResidentExpresswayDetectionPolicy.Config(78d, 6L, 34d, 240L);
        assertTrue(ResidentExpresswayStore.reconcile(context, TRIP, true, custom));
        ResidentExpresswayDetectionPolicy.State motion =
                new ResidentExpresswayDetectionPolicy.State(TRIP);
        for (long at : new long[] {1_000, 21_000, 41_000, 61_000, 81_000, 91_000}) {
            ResidentExpresswayDetectionPolicy.Result result = ResidentExpresswayDetectionPolicy.advance(
                    motion, new ResidentExpresswayDetectionPolicy.Point(TRIP, WALL_BASE + at,
                            SESSION, at, true, 10d, true, 5d / 3.6d), custom, true, false);
            assertEquals(ResidentExpresswayDetectionPolicy.EffectKind.NONE, result.effect.kind);
            motion = result.state;
        }
        assertTrue(ResidentExpresswayDetectionPolicy.canPromptForUnavailableEnd(motion, SESSION, PROBE_AT));
        ResidentExpresswayStore.Snapshot snapshot = ResidentExpresswayStore.snapshot(context);
        assertNull(snapshot.pendingProbe);
        assertEquals("", ResidentExpresswayStore.tryCommitUnavailableEndPrompt(context,
                snapshot.revision, motion));
        assertEquals(0, ResidentExpresswayStore.snapshot(context).events.size());
    }

    @Test public void longParkingOnlyPromptsAndKeepPreservesTheOpenSection() {
        verifyLongLowSpeedOnlyPrompts(0d);
    }

    @Test public void motorwayTrafficOnlyPromptsAndKeepPreservesTheOpenSection() {
        verifyLongLowSpeedOnlyPrompts(25d);
    }

    private void verifyLongLowSpeedOnlyPrompts(double speedKmh) {
        Fixture fixture = failedProbe("server");
        String promptId = "";
        for (long at = 45_000; at <= 925_000; at += 20_000) {
            fixture.motion = sample(fixture.motion, at, speedKmh, 10d, SESSION);
            String created = prompt(fixture);
            if (!created.isEmpty()) {
                assertEquals("Only one confirmation is created", "", promptId);
                promptId = created;
            }
            assertTrue("Parking/traffic never closes the expressway", ResidentExpresswayStore.snapshot(context).open);
        }
        assertFalse(promptId.isEmpty());
        ResidentExpresswayStore.Snapshot waiting = ResidentExpresswayStore.snapshot(context);
        assertEquals(1, waiting.events.size());
        assertEquals(ResidentExpresswayStore.EventKind.END_PROMPT, waiting.events.get(0).kind);
        assertTrue(ResidentExpresswayStore.recordDecision(context, promptId, false, WALL_BASE + 930_000).stored);
        for (long at = 945_000; at <= 1_825_000; at += 20_000) {
            fixture.motion = sample(fixture.motion, at, speedKmh, 10d, SESSION);
            assertEquals("", prompt(fixture));
        }
        ResidentExpresswayStore.Snapshot kept = ResidentExpresswayStore.snapshot(context);
        assertTrue(kept.open);
        assertTrue(kept.keepSuppressed);
        assertEquals(2, kept.events.size());
        assertEquals(ResidentExpresswayStore.EventKind.DECISION_KEEP, kept.events.get(1).kind);
    }

    @Test public void fullQueuePreservesPendingPointAndRetryBudgetWithoutDroppingEvents() throws Exception {
        Fixture fixture = failedProbe("server");
        reach(fixture, LOW_START + 90_000);
        JSONObject root = new JSONObject(encodedState());
        JSONArray events = new JSONArray();
        for (int index = 0; index < ResidentExpresswayStore.MAX_EVENT_COUNT; index++) {
            events.put(new JSONObject().put("id", "synthetic-full-event-" + index)
                    .put("tripId", TRIP).put("kind", "end_prompt")
                    .put("detectedAt", iso(1_000))
                    .put("geo", new JSONObject().put("lat", LAT).put("lon", LON)));
        }
        root.put("events", events);
        saveState(root);
        String before = encodedState();
        assertEquals("", prompt(fixture));
        assertEquals("", prompt(fixture));
        assertEquals(before, encodedState());
        ResidentExpresswayStore.Snapshot full = ResidentExpresswayStore.snapshot(context);
        assertEquals(ResidentExpresswayStore.MAX_EVENT_COUNT, full.events.size());
        assertTrue(full.open);
        assertEquals(fixture.probe.id, full.pendingProbe.id);
        assertEquals(fixture.probe.detectedAt, full.pendingProbe.detectedAt);
        assertEquals(1, full.pendingProbe.attemptCount);
        assertEquals(WALL_BASE + 56_000, full.pendingProbe.retryAfterAtMs);
    }

    private Fixture failedProbe(String failure) {
        ResidentExpresswayDetectionPolicy.State motion =
                new ResidentExpresswayDetectionPolicy.State(TRIP);
        motion = sample(motion, LOW_START, 10d, 10d, SESSION);
        ResidentExpresswayDetectionPolicy.Result result = advance(motion, PROBE_AT, 5d, 10d, SESSION);
        assertEquals(ResidentExpresswayDetectionPolicy.EffectKind.PROBE_END, result.effect.kind);
        assertEquals(24_000, result.effect.lowSpeedElapsedMs);
        ResidentExpresswayStore.Probe probe = ResidentExpresswayStore.createProbe(context,
                ResidentExpresswayStore.ProbeKind.END, TRIP, iso(PROBE_AT), WALL_BASE + PROBE_AT,
                LAT, LON, 10d, 5d, result.effect.accelerationMs2, result.effect.lowSpeedElapsedMs,
                SESSION, PROBE_AT);
        assertNotNull(probe);
        if (!failure.isEmpty()) assertTrue(ResidentExpresswayStore.markProbeFailure(context,
                probe.id, failure, WALL_BASE + 26_000));
        return new Fixture(result.state, probe, ResidentExpresswayStore.snapshot(context).revision);
    }

    private void reach(Fixture fixture, long target) { reach(fixture, target, SESSION); }

    private void reach(Fixture fixture, long target, String session) {
        while (fixture.motion.lastMotionAtMs < target) {
            long at = Math.min(target, fixture.motion.lastMotionAtMs + 20_000);
            fixture.motion = sample(fixture.motion, at, 5d, 10d, session);
        }
    }

    private String prompt(Fixture fixture) {
        return ResidentExpresswayStore.tryCommitUnavailableEndPrompt(context,
                fixture.revision, fixture.motion);
    }

    private static ResidentExpresswayDetectionPolicy.State sample(
            ResidentExpresswayDetectionPolicy.State previous, long at, double speed,
            Double accuracy, String session) {
        return advance(previous, at, speed, accuracy, session).state;
    }

    private static ResidentExpresswayDetectionPolicy.Result advance(
            ResidentExpresswayDetectionPolicy.State previous, long at, double speed,
            Double accuracy, String session) {
        return ResidentExpresswayDetectionPolicy.advance(previous,
                new ResidentExpresswayDetectionPolicy.Point(TRIP, WALL_BASE + at, session, at,
                        accuracy != null, accuracy == null ? 0d : accuracy, true, speed / 3.6d),
                CONFIG, true, false);
    }

    private SharedPreferences preferences() {
        return context.getSharedPreferences(ResidentExpresswayStore.PREFERENCES_NAME, 0);
    }

    private String encodedState() {
        return preferences().getString(ResidentExpresswayStore.KEY_STATE_JSON, "");
    }

    private void saveState(JSONObject root) {
        assertTrue(preferences().edit().putString(ResidentExpresswayStore.KEY_STATE_JSON,
                root.toString()).commit());
    }

    private static String iso(long at) { return ResidentLocationQueue.toIsoTimestamp(WALL_BASE + at); }

    private static final class Fixture {
        ResidentExpresswayDetectionPolicy.State motion;
        final ResidentExpresswayStore.Probe probe;
        final long revision;

        Fixture(ResidentExpresswayDetectionPolicy.State motion,
                ResidentExpresswayStore.Probe probe, long revision) {
            this.motion = motion;
            this.probe = probe;
            this.revision = revision;
        }
    }
}
