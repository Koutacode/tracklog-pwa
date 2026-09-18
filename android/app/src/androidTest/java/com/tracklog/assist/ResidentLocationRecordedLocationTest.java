package com.tracklog.assist;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;

import android.content.Context;
import android.location.Location;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class ResidentLocationRecordedLocationTest {
    private Context context;

    @Before
    public void setUp() {
        // The test APK's private preferences never touch the driver's retained state.
        context = InstrumentationRegistry.getInstrumentation().getContext();
        assertNotEquals(context.getPackageName(),
                InstrumentationRegistry.getInstrumentation().getTargetContext().getPackageName());
        ResidentLocationState.preferences(context).edit().clear().commit();
        ResidentLocationState.applyTrackingIntent(context, "synthetic-trip", 0L);
    }

    @After
    public void tearDown() {
        ResidentLocationState.preferences(context).edit().clear().commit();
    }

    @Test
    public void latestCacheDoesNotDependOnFifoBacklogAndDoesNotRegressToAnOlderFix() throws Exception {
        assertNull(ResidentLocationState.getLatestRecordedLocation(context));
        cache(1_789_776_000_000L, 35d);
        cache(1_789_776_020_000L, 35.001d);
        cache(1_789_776_010_000L, 35.0005d);
        JSONObject latest = ResidentLocationState.getLatestRecordedLocation(context);
        assertEquals(ResidentLocationQueue.toIsoTimestamp(1_789_776_020_000L), latest.getString("ts"));
        assertEquals("synthetic-trip", latest.getString("tripId"));
        assertEquals("background", latest.getString("source"));
        assertEquals(35.001d, latest.getDouble("lat"), 0d);
        assertEquals(12d, latest.getDouble("accuracy"), 0d);
        assertEquals(6, latest.length());
    }

    @Test
    public void tripEndRetainsLastFixButRejectsLateCallbacksAndSignOutClearsTheCache() throws Exception {
        cache(1_789_776_000_000L, 35d);
        ResidentLocationState.stopTrackingIntent(context, true, false);
        cache(1_789_776_010_000L, 35.001d);
        assertEquals(35d, ResidentLocationState.getLatestRecordedLocation(context).getDouble("lat"), 0d);
        ResidentLocationState.clearLatestRecordedLocation(context);
        assertNull(ResidentLocationState.getLatestRecordedLocation(context));
    }

    private void cache(long timestamp, double latitude) {
        Location location = new Location("synthetic-test");
        location.setLatitude(latitude);
        location.setLongitude(139d);
        location.setAccuracy(12f);
        location.setTime(timestamp);
        ResidentLocationState.cacheLatestRecordedLocation(context, "synthetic-trip", location);
    }
}
