package com.tracklog.assist;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import com.getcapacitor.JSArray;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class ResidentExpresswayStoreTest {
    private Context context;

    @Before
    public void setUp() {
        context = InstrumentationRegistry.getInstrumentation().getContext();
        assertNotEquals(
                context.getFilesDir().getAbsolutePath(),
                InstrumentationRegistry.getInstrumentation().getTargetContext()
                        .getFilesDir().getAbsolutePath()
        );
        assertTrue(ResidentExpresswayStore.clearPrivateData(context));
    }

    @After
    public void tearDown() {
        ResidentExpresswayStore.clearPrivateData(context);
    }

    @Test
    public void promptAndDecisionSurviveFreshReadsAndRemainOrdered() throws Exception {
        assertTrue(ResidentExpresswayStore.reconcile(context, "trip", true, config()));
        ResidentExpresswayStore.Probe probe = endProbe();
        assertNotNull(probe);
        String promptId = ResidentExpresswayStore.commitEndPrompt(
                context,
                probe.id,
                exitSignal()
        );
        assertFalse(promptId.isEmpty());

        ResidentExpresswayStore.Snapshot afterPrompt = ResidentExpresswayStore.snapshot(context);
        assertEquals(promptId, afterPrompt.promptId);
        assertEquals(1, afterPrompt.events.size());
        assertEquals(
                ResidentExpresswayStore.EventKind.END_PROMPT,
                afterPrompt.events.get(0).kind
        );

        ResidentExpresswayStore.DecisionResult decision =
                ResidentExpresswayStore.recordDecision(
                        context,
                        promptId,
                        true,
                        1_788_000_030_000L
                );
        assertTrue(decision.stored);
        ResidentExpresswayStore.Snapshot afterDecision = ResidentExpresswayStore.snapshot(context);
        assertFalse(afterDecision.open);
        assertTrue(afterDecision.promptId.isEmpty());
        assertEquals(2, afterDecision.events.size());
        assertEquals(
                ResidentExpresswayStore.EventKind.DECISION_END,
                afterDecision.events.get(1).kind
        );
        assertTrue(afterDecision.events.get(1).generation > afterPrompt.revision);
        assertEquals(promptId, afterDecision.events.get(1).promptId);

        ResidentExpresswayStore.DecisionResult retry = ResidentExpresswayStore.recordDecision(
                context,
                promptId,
                true,
                1_788_000_040_000L
        );
        assertTrue(retry.stored);
        assertEquals(decision.eventId, retry.eventId);
        assertEquals(decision.generation, retry.generation);
        assertEquals(2, ResidentExpresswayStore.snapshot(context).events.size());

        ResidentExpresswayStore.DecisionResult opposite = ResidentExpresswayStore.recordDecision(
                context,
                promptId,
                false,
                1_788_000_050_000L
        );
        assertFalse(opposite.stored);
        assertEquals(2, ResidentExpresswayStore.snapshot(context).events.size());
    }

    @Test
    public void acknowledgedPromptRemainsResolvableAfterHandoffAndFreshRead() throws Exception {
        assertTrue(ResidentExpresswayStore.reconcile(context, "trip", true, config()));
        ResidentExpresswayStore.Probe probe = endProbe();
        assertNotNull(probe);
        String promptId = ResidentExpresswayStore.commitEndPrompt(
                context,
                probe.id,
                exitSignal()
        );
        assertFalse(promptId.isEmpty());

        // The WebView durably materializes the dialog and acknowledges the handoff event
        // before the driver decides. The prompt payload itself must remain native-durable.
        assertEquals(0, ResidentExpresswayStore.acknowledge(context, ids(promptId)));
        ResidentExpresswayStore.Snapshot afterHandoff = ResidentExpresswayStore.snapshot(context);
        assertEquals(0, afterHandoff.events.size());
        assertEquals(promptId, afterHandoff.promptId);
        assertNotNull(afterHandoff.pendingPrompt);
        assertEquals(promptId, afterHandoff.pendingPrompt.id);

        ResidentExpresswayStore.DecisionResult decision =
                ResidentExpresswayStore.recordDecision(
                        context,
                        promptId,
                        false,
                        1_788_000_030_000L
                );
        assertTrue(decision.stored);
        ResidentExpresswayStore.Snapshot afterDecision = ResidentExpresswayStore.snapshot(context);
        assertTrue(afterDecision.promptId.isEmpty());
        assertNull(afterDecision.pendingPrompt);
        assertEquals(1, afterDecision.events.size());
        assertEquals(
                ResidentExpresswayStore.EventKind.DECISION_KEEP,
                afterDecision.events.get(0).kind
        );
        assertEquals(promptId, afterDecision.events.get(0).promptId);
    }

    @Test
    public void acknowledgementRemovesOnlyContiguousPrefix() throws Exception {
        assertTrue(ResidentExpresswayStore.reconcile(context, "trip", true, config()));
        ResidentExpresswayStore.Probe probe = endProbe();
        String promptId = ResidentExpresswayStore.commitEndPrompt(context, probe.id, exitSignal());
        ResidentExpresswayStore.DecisionResult decision = ResidentExpresswayStore.recordDecision(
                context,
                promptId,
                false,
                1_788_000_030_000L
        );
        assertTrue(decision.stored);

        assertEquals(2, ResidentExpresswayStore.acknowledge(
                context,
                ids(decision.eventId)
        ));
        assertEquals(1, ResidentExpresswayStore.acknowledge(
                context,
                ids(promptId)
        ));
        assertEquals(decision.eventId, ResidentExpresswayStore.snapshot(context).events.get(0).id);
        assertEquals(0, ResidentExpresswayStore.acknowledge(
                context,
                ids(decision.eventId)
        ));
    }

    @Test
    public void fullEventQueueFailsClosedAndKeepsPendingProbe() throws Exception {
        JSONArray events = new JSONArray();
        for (int index = 0; index < ResidentExpresswayStore.MAX_EVENT_COUNT; index += 1) {
            String id = "existing-" + index;
            events.put(new JSONObject()
                    .put("id", id)
                    .put("tripId", "old-trip")
                    .put("kind", "decision_keep")
                    .put("generation", index + 1L)
                    .put("detectedAt", "2026-08-23T00:00:00.000Z")
                    .put("decidedAt", "2026-08-23T00:00:01.000Z")
                    .put("promptId", "old-prompt")
                    .put("geo", new JSONObject().put("lat", 35d).put("lon", 139d))
                    .put("speedKmh", 40d)
                    .put("reason", new JSONObject().put("nativeDetectionId", id)));
        }
        JSONObject root = new JSONObject()
                .put("version", 1)
                .put("tripId", "trip")
                .put("revision", 200L)
                .put("open", false)
                .put("paused", false)
                .put("keepSuppressed", false)
                .put("promptId", "")
                .put("events", events)
                .put("config", configJson());
        assertTrue(context.getSharedPreferences(
                ResidentExpresswayStore.PREFERENCES_NAME,
                Context.MODE_PRIVATE
        ).edit().putString(ResidentExpresswayStore.KEY_STATE_JSON, root.toString()).commit());

        ResidentExpresswayStore.Probe probe = ResidentExpresswayStore.createProbe(
                context,
                ResidentExpresswayStore.ProbeKind.START,
                "trip",
                "2026-08-23T00:00:02.000Z",
                1_788_000_002_000L,
                35d,
                139d,
                10d,
                90d,
                0.3d,
                0L,
                "boot",
                10_000L
        );
        assertNotNull(probe);
        assertFalse(ResidentExpresswayStore.commitStart(
                context,
                probe.id,
                strongSignal(),
                2,
                12_000L
        ));
        ResidentExpresswayStore.Snapshot snapshot = ResidentExpresswayStore.snapshot(context);
        assertEquals(ResidentExpresswayStore.MAX_EVENT_COUNT, snapshot.events.size());
        assertNotNull(snapshot.pendingProbe);
        assertFalse(snapshot.open);
    }

    @Test
    public void authorizationFailureIsDurableAndObservableWithoutCoordinatesInStatusFields() {
        assertTrue(ResidentExpresswayStore.reconcile(context, "trip", false, config()));
        ResidentExpresswayStore.Probe probe = ResidentExpresswayStore.createProbe(
                context,
                ResidentExpresswayStore.ProbeKind.START,
                "trip",
                "2026-08-23T00:00:00.000Z",
                1_788_000_000_000L,
                35d,
                139d,
                10d,
                90d,
                0.3d,
                0L,
                "boot",
                1_000L
        );
        assertNotNull(probe);
        assertTrue(ResidentExpresswayStore.markProbeFailure(
                context,
                probe.id,
                "authorization",
                1_788_000_010_000L
        ));

        ResidentExpresswayStore.Snapshot restored = ResidentExpresswayStore.snapshot(context);
        assertNotNull(restored.pendingProbe);
        assertEquals(1, restored.pendingProbe.attemptCount);
        assertEquals("authorization", restored.pendingProbe.lastFailureCategory);
        assertEquals(1_788_000_010_000L, restored.pendingProbe.failureUpdatedAtMs);
        assertNull(ResidentExpresswayStore.dueProbe(context, 1_788_000_010_001L));
        assertNotNull(ResidentExpresswayStore.dueProbe(context, 1_788_000_040_000L));
    }

    @Test
    public void corruptSnapshotFailsClosedAndIsNotOverwrittenByReconcile() {
        assertTrue(context.getSharedPreferences(
                ResidentExpresswayStore.PREFERENCES_NAME,
                Context.MODE_PRIVATE
        ).edit().putString(ResidentExpresswayStore.KEY_STATE_JSON, "{broken").commit());
        assertFalse(ResidentExpresswayStore.snapshot(context).storageHealthy);
        assertFalse(ResidentExpresswayStore.reconcile(context, "trip", false, config()));
        assertEquals("{broken", context.getSharedPreferences(
                ResidentExpresswayStore.PREFERENCES_NAME,
                Context.MODE_PRIVATE
        ).getString(ResidentExpresswayStore.KEY_STATE_JSON, ""));
    }

    private ResidentExpresswayStore.Probe endProbe() {
        return ResidentExpresswayStore.createProbe(
                context,
                ResidentExpresswayStore.ProbeKind.END,
                "trip",
                "2026-08-23T00:00:00.000Z",
                1_788_000_000_000L,
                35d,
                139d,
                10d,
                15d,
                -0.5d,
                30_000L,
                "boot",
                100_000L
        );
    }

    private static ResidentExpresswayDetectionPolicy.Config config() {
        return ResidentExpresswayDetectionPolicy.Config.DEFAULT;
    }

    private static JSONObject configJson() throws Exception {
        return new JSONObject()
                .put("speedKmh", 78d)
                .put("durationSec", 6L)
                .put("endSpeedKmh", 34d)
                .put("endDurationSec", 24L);
    }

    private static ResidentExpresswayStore.SignalDetails exitSignal() {
        return new ResidentExpresswayStore.SignalDetails(
                true,
                false,
                true,
                false,
                "Example IC",
                100d
        );
    }

    private static ResidentExpresswayStore.SignalDetails strongSignal() {
        return new ResidentExpresswayStore.SignalDetails(
                true,
                true,
                false,
                false,
                "",
                null
        );
    }

    private static JSArray ids(String... values) {
        JSArray result = new JSArray();
        for (String value : values) result.put(value);
        return result;
    }
}
