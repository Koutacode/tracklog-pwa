package com.tracklog.assist;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import android.content.Context;
import android.location.Location;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import java.util.Collections;
import java.util.HashSet;
import java.util.List;

/** Reads the route queue without consuming it. No device, network, or credentials are used. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, manifest = Config.NONE)
public class ResidentRoutePointQueueSnapshotTest {
    private Context context;

    @Before
    public void setup() {
        context = RuntimeEnvironment.getApplication();
    }

    @Test
    public void snapshotLeavesPointsForTheWebViewDrainAndSkipsAlreadyUploadedIds() throws Exception {
        long now = System.currentTimeMillis();
        ResidentLocationQueue.append(context, "trip-1", fix(35.1, now), "boot");
        ResidentLocationQueue.append(context, "trip-1", fix(35.2, now + 10_000L), "boot");
        ResidentLocationQueue.append(context, "trip-1", fix(35.3, now + 20_000L), "boot");

        List<JSONObject> firstLook = ResidentLocationQueue.snapshotUnacknowledged(
                context,
                10,
                Collections.emptySet()
        );
        assertEquals(3, firstLook.size());
        String uploadedId = firstLook.get(0).getString("id");
        List<JSONObject> remaining = ResidentLocationQueue.snapshotUnacknowledged(
                context,
                10,
                new HashSet<>(Collections.singleton(uploadedId))
        );
        assertEquals(2, remaining.size());
        assertFalse(remaining.get(0).getString("id").equals(uploadedId));
        assertFalse(remaining.get(1).getString("id").equals(uploadedId));

        ResidentLocationQueue.PeekResult peeked = ResidentLocationQueue.peek(context, 10);
        assertEquals(3, peeked.points.length());
        JSONArray ids = new JSONArray();
        for (int index = 0; index < peeked.points.length(); index += 1) {
            ids.put(peeked.points.getJSONObject(index).getString("id"));
        }
        ResidentLocationQueue.acknowledge(context, ids);
        assertEquals(0, ResidentLocationQueue.snapshotUnacknowledged(
                context,
                10,
                Collections.emptySet()
        ).size());
    }

    private static Location fix(double latitude, long timeMs) {
        Location location = new Location("synthetic");
        location.setLatitude(latitude);
        location.setLongitude(139.2);
        location.setTime(timeMs);
        location.setAccuracy(6f);
        location.setSpeed(4f);
        location.setBearing(90f);
        return location;
    }
}
