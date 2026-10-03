package com.tracklog.assist;

import static org.junit.Assert.*;
import android.content.Context;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

/** Isolated JVM Android sandbox. Never uses an attached device or its preferences. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, manifest = Config.NONE)
public class ResidentExpresswayExitStoreTest {
    private Context context;
    @Before public void setup() {
        context = RuntimeEnvironment.getApplication();
        assertTrue(ResidentExpresswayStore.clearPrivateData(context));
        assertTrue(ResidentExpresswayStore.reconcile(context, "synthetic-trip", true,
                ResidentExpresswayDetectionPolicy.Config.DEFAULT));
    }

    @Test public void briefOfflineRetrySurvivesReadsAccelerationAndOnlyCreatesOnePrompt() {
        observe(1_000, 0, 80, false);
        ResidentExpresswayStore.Probe candidate = observe(11_000, .001, 18, true);
        assertNotNull(candidate);
        assertEquals(ResidentExpresswayExitWatch.BRIEF, candidate.endMode);
        assertTrue(ResidentExpresswayStore.markProbeFailure(context, candidate.id, "network", 12_000));
        assertNull(observe(21_000, .003, 65, false));
        ResidentExpresswayStore.Probe restored = ResidentExpresswayStore.snapshot(context).pendingProbe;
        assertEquals(candidate.id, restored.id);
        assertEquals(11_000, restored.detectedAtMs);
        assertEquals(1, restored.attemptCount);
        assertEquals(ResidentExpresswayExitWatch.BRIEF, restored.endMode);
        assertNull(ResidentExpresswayStore.dueProbe(context, 41_999));
        assertNotNull(ResidentExpresswayStore.dueProbe(context, 42_000));
        String prompt = ResidentExpresswayStore.resolveSupplementalEnd(context, restored.id, gate(), 42_000);
        assertFalse(prompt.isEmpty());
        assertEquals("", ResidentExpresswayStore.resolveSupplementalEnd(context, restored.id, gate(), 43_000));
        assertNull(observe(61_000, .01, 65, false));
        ResidentExpresswayStore.Snapshot snapshot = ResidentExpresswayStore.snapshot(context);
        assertTrue(snapshot.open);
        assertEquals(1, snapshot.events.size());
        assertEquals(ResidentExpresswayStore.EventKind.END_PROMPT, snapshot.events.get(0).kind);
        assertEquals(prompt, snapshot.pendingPrompt.id);
        assertTrue(ResidentExpresswayStore.recordDecision(context, prompt, true, 70_000).stored);
        assertTrue(ResidentExpresswayStore.recordDecision(context, prompt, true, 71_000).stored);
        assertFalse(ResidentExpresswayStore.snapshot(context).open);
        assertEquals(2, ResidentExpresswayStore.snapshot(context).events.size());
    }

    @Test public void outsideEvidenceSurvivesFreshReadsWithoutWebviewAndNeedsTwoPlaces() {
        observe(1_000, 0, 65, false);
        ResidentExpresswayStore.Probe first = observe(61_000, .01, 65, false);
        assertEquals("", resolve(first, outside(), 62_000));
        assertNotNull(ResidentExpresswayStore.snapshot(context).exitWatch.outside);
        assertNull(observe(100_000, .015, 65, false));
        ResidentExpresswayStore.Probe second = observe(121_000, .02, 65, false);
        assertFalse(resolve(second, outside(), 122_000).isEmpty());
        assertTrue(ResidentExpresswayStore.snapshot(context).open);
    }

    @Test public void keepAfterAcknowledgementStillAllowsNewExitWithoutFortyTwoKmhRecovery() throws Exception {
        observe(1_000, 0, 70, false);
        String prompt = resolve(observe(11_000, .001, 18, true), gate(), 12_000);
        assertTrue(ResidentExpresswayStore.recordDecision(context, prompt, false, 13_000).stored);
        ResidentExpresswayStore.Snapshot kept = ResidentExpresswayStore.snapshot(context);
        assertTrue(kept.keepSuppressed);
        java.util.List<String> ids = new java.util.ArrayList<>();
        for (ResidentExpresswayStore.Event event : kept.events) ids.add(event.id);
        assertEquals(0, ResidentExpresswayStore.acknowledge(context, new com.getcapacitor.JSArray(ids)));
        assertNotNull(ResidentExpresswayStore.snapshot(context).exitWatch.keep);
        assertNull(observe(74_000, .0011, 20, true));
        assertEquals("", resolve(observe(84_000, .01, 30, false), outside(), 85_000));
        assertFalse(resolve(observe(144_000, .02, 30, false), outside(), 145_000).isEmpty());
    }

    @Test public void lateResponsesFromOldSectionOrOtherTripAreIgnored() {
        observe(1_000, 0, 70, false);
        ResidentExpresswayStore.Probe old = observe(11_000, .001, 18, true);
        assertTrue(ResidentExpresswayStore.reconcile(context, "synthetic-trip", false,
                ResidentExpresswayDetectionPolicy.Config.DEFAULT));
        assertEquals("", resolve(old, gate(), 12_000));
        assertTrue(ResidentExpresswayStore.reconcile(context, "new-synthetic-trip", true,
                ResidentExpresswayDetectionPolicy.Config.DEFAULT));
        assertEquals("", resolve(old, gate(), 13_000));
        assertEquals(0, ResidentExpresswayStore.snapshot(context).events.size());
        assertNull(ResidentExpresswayStore.snapshot(context).exitWatch.brief);
    }

    @Test public void expiredOfflineProbeCannotBlockFreshRoadChecksOrShowStaleGate() {
        observe(1_000, 0, 70, false);
        ResidentExpresswayStore.Probe old = observe(11_000, .001, 18, true);
        assertTrue(ResidentExpresswayStore.markProbeFailure(context, old.id, "network", 12_000));
        ResidentExpresswayStore.Probe fresh = observe(400_000, .1, 65, false);
        assertNotNull(fresh);
        assertNotEquals(old.id, fresh.id);
        assertEquals(ResidentExpresswayExitWatch.ROAD, fresh.endMode);
        assertEquals("", resolve(old, gate(), 401_000));
        assertEquals("", resolve(fresh, outside(), 401_000));
        assertFalse(resolve(observe(460_000, .11, 65, false), outside(), 461_000).isEmpty());
    }

    @Test public void briefQueuedBehindExistingProbeIsPersistedAndRetainsOriginalPoint() {
        observe(1_000, 0, 70, false);
        ResidentExpresswayStore.Probe road = observe(61_000, .01, 70, false);
        assertNull(observe(71_000, .011, 18, true));
        assertNotNull(ResidentExpresswayStore.snapshot(context).exitWatch.brief);
        assertEquals("", resolve(road, motorway(), 80_000));
        ResidentExpresswayStore.Probe brief = observe(91_000, .02, 70, false);
        assertNotNull(brief);
        assertEquals(71_000, brief.detectedAtMs);
        assertEquals(.011, brief.longitude, .000001);
        assertFalse(resolve(brief, gate(), 92_000).isEmpty());
    }

    @Test public void legacySnapshotAndPendingProbeRemainReadableWithoutAuxiliaryFields() throws Exception {
        ResidentExpresswayStore.Probe probe = ResidentExpresswayStore.createProbe(context,
                ResidentExpresswayStore.ProbeKind.END, "synthetic-trip", "2026-01-01T00:00:00Z",
                1_000, 0, 0, 10d, 0, null, 24_000, "", -1);
        String raw = context.getSharedPreferences(ResidentExpresswayStore.PREFERENCES_NAME, 0)
                .getString(ResidentExpresswayStore.KEY_STATE_JSON, "");
        JSONObject oldFormat = new JSONObject(raw);
        oldFormat.remove("exitWatch");
        oldFormat.getJSONObject("pendingProbe").remove("endMode");
        context.getSharedPreferences(ResidentExpresswayStore.PREFERENCES_NAME, 0).edit()
                .putString(ResidentExpresswayStore.KEY_STATE_JSON, oldFormat.toString()).commit();
        ResidentExpresswayStore.Snapshot restored = ResidentExpresswayStore.snapshot(context);
        assertTrue(restored.storageHealthy);
        assertTrue(restored.open);
        assertEquals(probe.id, restored.pendingProbe.id);
        assertEquals(ResidentExpresswayExitWatch.LEGACY, restored.pendingProbe.endMode);
        assertNull(restored.exitWatch.origin);
        assertFalse(ResidentExpresswayStore.commitEndPrompt(context, probe.id, outside()).isEmpty());
    }

    @Test public void noSupplementalWorkOutsideTripOrWhilePaused() {
        assertTrue(ResidentExpresswayStore.deactivate(context));
        assertNull(observe(61_000, .01, 65, true));
        assertEquals(0, ResidentExpresswayStore.snapshot(context).events.size());
    }

    @Test public void staleSuccessfulResponseIsDiscardedWithoutEndingSection() {
        observe(1_000, 0, 70, false);
        ResidentExpresswayStore.Probe probe = observe(11_000, .001, 18, true);
        assertEquals("", resolve(probe, gate(), 400_000));
        assertNull(ResidentExpresswayStore.snapshot(context).pendingProbe);
        assertTrue(ResidentExpresswayStore.snapshot(context).open);
    }

    @Test public void actualSpeedSequencePreservesLegacySaCheckWhileBriefRequestIsOffline() {
        ResidentExpresswayDetectionPolicy.State motion = new ResidentExpresswayDetectionPolicy.State("synthetic-trip");
        ResidentExpresswayStore.Probe brief = null;
        for (long at : new long[] {1_000, 11_000, 21_000, 35_000}) {
            double speed = at == 1_000 ? 80d : at == 11_000 ? 18d : 0d;
            Double previous = motion.lastSpeedMs;
            ResidentExpresswayDetectionPolicy.Result result = ResidentExpresswayDetectionPolicy.advance(
                    motion, new ResidentExpresswayDetectionPolicy.Point("synthetic-trip", at,
                            "synthetic-boot", at, true, 10d, true, speed / 3.6d),
                    ResidentExpresswayDetectionPolicy.Config.DEFAULT, true, false);
            motion = result.state;
            if (result.effect.kind == ResidentExpresswayDetectionPolicy.EffectKind.PROBE_END) {
                ResidentExpresswayStore.Probe legacy = ResidentExpresswayStore.createProbe(context,
                        ResidentExpresswayStore.ProbeKind.END, "synthetic-trip", "synthetic-time", at,
                        0, .001, 10d, speed, result.effect.accelerationMs2,
                        result.effect.lowSpeedElapsedMs, "synthetic-boot", at);
                assertNotNull("Supplemental retry must not delay the existing SA path", legacy);
                assertEquals(ResidentExpresswayExitWatch.LEGACY, legacy.endMode);
                assertNotNull(ResidentExpresswayStore.snapshot(context).exitWatch.brief);
                assertEquals("", resolve(brief, gate(), at + 1));
                assertFalse(ResidentExpresswayStore.commitEndPrompt(context, legacy.id, outside()).isEmpty());
                assertTrue(ResidentExpresswayStore.snapshot(context).open);
            }
            ResidentExpresswayStore.Probe created = observe(at, at == 1_000 ? 0 : .001, speed,
                    ResidentExpresswayExitWatch.isBriefDeceleration(previous, speed,
                            ResidentExpresswayDetectionPolicy.Config.DEFAULT, result));
            if (at == 11_000) {
                brief = created;
                assertNotNull(brief);
                assertTrue(ResidentExpresswayStore.markProbeFailure(context, brief.id, "network", at));
            }
        }
        assertEquals(1, ResidentExpresswayStore.snapshot(context).events.size());
    }

    @Test public void actualBriefSpeedSequenceWorksWithoutTwentyFourSecondHold() {
        ResidentExpresswayDetectionPolicy.State motion = new ResidentExpresswayDetectionPolicy.State("synthetic-trip");
        ResidentExpresswayStore.Probe candidate = null;
        long[] times = {1_000, 11_000, 21_000};
        double[] speeds = {80, 18, 70};
        for (int i = 0; i < times.length; i++) {
            Double previous = motion.lastSpeedMs;
            ResidentExpresswayDetectionPolicy.Result result = ResidentExpresswayDetectionPolicy.advance(
                    motion, new ResidentExpresswayDetectionPolicy.Point("synthetic-trip", times[i],
                            "synthetic-boot", times[i], true, 10d, true, speeds[i] / 3.6d),
                    ResidentExpresswayDetectionPolicy.Config.DEFAULT, true, false);
            motion = result.state;
            assertEquals(ResidentExpresswayDetectionPolicy.EffectKind.NONE, result.effect.kind);
            ResidentExpresswayStore.Probe created = observe(times[i], i * .001, speeds[i],
                    ResidentExpresswayExitWatch.isBriefDeceleration(previous, speeds[i],
                            ResidentExpresswayDetectionPolicy.Config.DEFAULT, result));
            if (created != null) candidate = created;
        }
        assertNotNull(candidate);
        assertEquals(11_000, candidate.detectedAtMs);
        assertFalse(resolve(candidate, gate(), 22_000).isEmpty());
    }

    @Test public void fullEventQueueRetainsCandidateAndBacksOffInsteadOfRepeatedQueries() throws Exception {
        observe(1_000, 0, 70, false);
        ResidentExpresswayStore.Probe probe = observe(11_000, .001, 18, true);
        android.content.SharedPreferences prefs = context.getSharedPreferences(
                ResidentExpresswayStore.PREFERENCES_NAME, 0);
        JSONObject root = new JSONObject(prefs.getString(ResidentExpresswayStore.KEY_STATE_JSON, ""));
        org.json.JSONArray events = new org.json.JSONArray();
        for (int i = 0; i < ResidentExpresswayStore.MAX_EVENT_COUNT; i++) {
            events.put(new JSONObject().put("id", "synthetic-event-" + i)
                    .put("tripId", "synthetic-trip").put("kind", "end_prompt")
                    .put("detectedAt", "2026-01-01T00:00:00Z")
                    .put("geo", new JSONObject().put("lat", 0).put("lon", 0)));
        }
        root.put("events", events);
        assertTrue(prefs.edit().putString(ResidentExpresswayStore.KEY_STATE_JSON, root.toString()).commit());
        assertEquals("", resolve(probe, gate(), 12_000));
        ResidentExpresswayStore.Snapshot full = ResidentExpresswayStore.snapshot(context);
        assertEquals(ResidentExpresswayStore.MAX_EVENT_COUNT, full.events.size());
        assertTrue(full.open);
        assertEquals(probe.id, full.pendingProbe.id);
        assertEquals(1, full.pendingProbe.attemptCount);
        assertNull(ResidentExpresswayStore.dueProbe(context, 12_001));
        assertNotNull(ResidentExpresswayStore.dueProbe(context, 42_000));
    }

    private ResidentExpresswayStore.Probe observe(long at, double lon, double speed, boolean brief) {
        return ResidentExpresswayStore.observeExitWatch(context, "synthetic-trip",
                new ResidentExpresswayExitWatch.Fix(at, 0, lon, 10, speed), brief);
    }
    private String resolve(ResidentExpresswayStore.Probe probe, ResidentExpresswayStore.SignalDetails signal, long at) {
        assertNotNull(probe);
        return ResidentExpresswayStore.resolveSupplementalEnd(context, probe.id, signal, at);
    }
    private static ResidentExpresswayStore.SignalDetails gate() { return new ResidentExpresswayStore.SignalDetails(true, true, true, true, "Synthetic IC", 10d); }
    private static ResidentExpresswayStore.SignalDetails outside() { return new ResidentExpresswayStore.SignalDetails(true, false, false, false, "", null); }
    private static ResidentExpresswayStore.SignalDetails motorway() { return new ResidentExpresswayStore.SignalDetails(true, true, false, false, "", null); }
}
