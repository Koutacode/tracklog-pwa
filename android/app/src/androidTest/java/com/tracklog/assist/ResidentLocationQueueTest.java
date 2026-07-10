package com.tracklog.assist;

import static org.junit.Assert.assertEquals;

import android.content.Context;
import android.location.Location;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONArray;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class ResidentLocationQueueTest {
    @Test
    public void peekKeepsPointsUntilExplicitAcknowledgement() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        ResidentLocationQueue.PeekResult existing = ResidentLocationQueue.peek(context, 5000);
        JSONArray existingIds = new JSONArray();
        for (int index = 0; index < existing.points.length(); index += 1) {
            existingIds.put(existing.points.getJSONObject(index).getString("id"));
        }
        ResidentLocationQueue.acknowledge(context, existingIds);

        Location first = location(35.6812, 139.7671, 1_788_000_000_000L);
        Location second = location(35.6813, 139.7672, 1_788_000_030_000L);
        ResidentLocationQueue.append(context, "queue-test-trip", first);
        ResidentLocationQueue.append(context, "queue-test-trip", second);

        ResidentLocationQueue.PeekResult initial = ResidentLocationQueue.peek(context, 1);
        assertEquals(1, initial.points.length());
        assertEquals(1, initial.remaining);
        String firstId = initial.points.getJSONObject(0).getString("id");

        ResidentLocationQueue.PeekResult beforeAck = ResidentLocationQueue.peek(context, 1);
        assertEquals(firstId, beforeAck.points.getJSONObject(0).getString("id"));

        JSONArray firstAck = new JSONArray().put(firstId);
        assertEquals(1, ResidentLocationQueue.acknowledge(context, firstAck));
        ResidentLocationQueue.PeekResult afterAck = ResidentLocationQueue.peek(context, 10);
        assertEquals(1, afterAck.points.length());
        assertEquals(0, afterAck.remaining);

        JSONArray finalAck = new JSONArray().put(afterAck.points.getJSONObject(0).getString("id"));
        assertEquals(0, ResidentLocationQueue.acknowledge(context, finalAck));
    }

    private static Location location(double latitude, double longitude, long timestampMs) {
        Location location = new Location("gps");
        location.setLatitude(latitude);
        location.setLongitude(longitude);
        location.setAccuracy(5f);
        location.setTime(timestampMs);
        return location;
    }
}
