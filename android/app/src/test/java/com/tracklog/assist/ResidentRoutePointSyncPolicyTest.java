package com.tracklog.assist;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, manifest = Config.NONE)
public class ResidentRoutePointSyncPolicyTest {
    private static final String POINT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    @Test
    public void mutationUsesThePointIdAndDropsTelemetryOutsideTheSyncContract() throws Exception {
        JSONObject mutation = ResidentRoutePointSyncPolicy.mutationFor(new JSONObject()
                .put("id", POINT_ID)
                .put("tripId", " trip-1 ")
                .put("ts", "2026-11-12T01:02:03.004Z")
                .put("lat", 35.1)
                .put("lng", 139.2)
                .put("accuracy", 12.5)
                .put("speed", 900)
                .put("heading", 400)
                .put("source", "unknown"));
        assertEquals(POINT_ID, mutation.getString("mutationId"));
        assertEquals(POINT_ID, mutation.getString("entityId"));
        assertEquals("routePoint", mutation.getString("entityType"));
        assertEquals("upsert", mutation.getString("operation"));
        assertFalse(mutation.has("baseRevision"));
        JSONObject payload = mutation.getJSONObject("payload");
        assertEquals("trip-1", payload.getString("trip_id"));
        assertEquals("background", payload.getString("source"));
        assertEquals(12.5, payload.getDouble("accuracy"), 0.001);
        assertFalse(payload.has("speed"));
        assertFalse(payload.has("heading"));
    }

    @Test
    public void unsafePointsAreNotSentBecauseOneRaiseAbortsTheSyncTransaction() throws Exception {
        assertNull(ResidentRoutePointSyncPolicy.mutationFor(new JSONObject()
                .put("id", "not-a-uuid")
                .put("tripId", "trip-1")
                .put("ts", "2026-11-12T01:02:03.004Z")
                .put("lat", 35)
                .put("lng", 139)));
        assertNull(ResidentRoutePointSyncPolicy.mutationFor(new JSONObject()
                .put("id", POINT_ID)
                .put("tripId", "trip\n1")
                .put("ts", "2026-11-12T01:02:03.004Z")
                .put("lat", 35)
                .put("lng", 139)));
        assertNull(ResidentRoutePointSyncPolicy.mutationFor(new JSONObject()
                .put("id", POINT_ID)
                .put("tripId", "trip-1")
                .put("ts", "2026-11-12 01:02:03")
                .put("lat", 35)
                .put("lng", 139)));
        assertNull(ResidentRoutePointSyncPolicy.mutationFor(new JSONObject()
                .put("id", POINT_ID)
                .put("tripId", "trip-1")
                .put("ts", "2026-11-12T01:02:03.004Z")
                .put("lat", 91)
                .put("lng", 139)));
    }

    @Test
    public void duplicateAndExistingPointAcksAreStoredWhileMissingHeaderIsRetried() {
        assertEquals(
                ResidentRoutePointSyncPolicy.Disposition.STORE,
                ResidentRoutePointSyncPolicy.classifyAck("applied", "", "")
        );
        assertEquals(
                ResidentRoutePointSyncPolicy.Disposition.STORE,
                ResidentRoutePointSyncPolicy.classifyAck("duplicate", "", "")
        );
        assertEquals(
                ResidentRoutePointSyncPolicy.Disposition.STORE,
                ResidentRoutePointSyncPolicy.classifyAck(
                        "conflict",
                        "revision_conflict",
                        "A newer cloud revision already exists"
                )
        );
        assertEquals(
                ResidentRoutePointSyncPolicy.Disposition.DEFER,
                ResidentRoutePointSyncPolicy.classifyAck(
                        "conflict",
                        "missing_parent",
                        "Trip header is missing or belongs to another account"
                )
        );
        assertEquals(
                ResidentRoutePointSyncPolicy.MISSING_PARENT_DEFER_MS,
                ResidentRoutePointSyncPolicy.deferMillis(
                        ResidentRoutePointSyncPolicy.Disposition.DEFER,
                        "missing_parent",
                        "Trip header is missing or belongs to another account"
                )
        );
        assertEquals(
                ResidentRoutePointSyncPolicy.Disposition.RETRY,
                ResidentRoutePointSyncPolicy.classifyAck("conflict-unknown", "", "")
        );
        assertTrue(ResidentRoutePointSyncPolicy.isCursorAhead(
                400,
                "{\"ok\":false,\"error\":\"cursor is ahead of the owner change feed\"}"
        ));
        assertFalse(ResidentRoutePointSyncPolicy.isCursorAhead(500, "cursor is ahead"));
    }

    @Test
    public void compactPageStopsBeforeTheChangeFeedAndKeepsBracketCharactersInsideStrings() {
        String raw = "{\"ok\":true,\"data\":{\"acks\":[{\"status\":\"applied\","
                + "\"entityId\":\"" + POINT_ID + "\",\"message\":\"keep ] inside\"}],"
                + "\"cursor\":15,\"hasMore\":false,\"changes\":{\"routePoints\":[{\"lat\":1}";
        String compact = ResidentRoutePointSyncPolicy.compactSyncPage(raw);
        ResidentRoutePointSyncPolicy.Page page = ResidentRoutePointSyncPolicy.parseCompactPage(compact);
        assertEquals(15L, page.cursor);
        assertFalse(page.hasMore);
        assertEquals(1, page.acks.size());
        assertEquals(POINT_ID, page.acks.get(0).entityId);
        assertEquals(
                ResidentRoutePointSyncPolicy.Disposition.STORE,
                ResidentRoutePointSyncPolicy.classifyAck(
                        page.acks.get(0).status,
                        page.acks.get(0).code,
                        page.acks.get(0).message
                )
        );
        assertNull(ResidentRoutePointSyncPolicy.compactSyncPage(
                "{\"ok\":true,\"data\":{\"acks\":[{\"status\":\"applied\""
        ));
        String nestedFirst = "{\"ok\":true,\"data\":{\"changes\":{\"acks\":[{\"status\":\"applied\","
                + "\"entityId\":\"wrong\"}]},\"acks\":[{\"status\":\"duplicate\",\"entityId\":\""
                + POINT_ID + "\"}],\"cursor\":9}}";
        ResidentRoutePointSyncPolicy.Page nested = ResidentRoutePointSyncPolicy.parseCompactPage(
                ResidentRoutePointSyncPolicy.compactSyncPage(nestedFirst)
        );
        assertEquals(9L, nested.cursor);
        assertEquals(POINT_ID, nested.acks.get(0).entityId);
        assertEquals("duplicate", nested.acks.get(0).status);
        assertEquals(5_000L, ResidentRoutePointSyncPolicy.delayUntilNextAttempt(10_000L, 0L));
        assertEquals(0L, ResidentRoutePointSyncPolicy.delayUntilNextAttempt(40_000L, 1_000L));
        assertEquals(25_000L, ResidentRoutePointSyncPolicy.delayUntilNextAttempt(6_000L, 1_000L));
    }
}
