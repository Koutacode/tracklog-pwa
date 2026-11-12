package com.tracklog.assist;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.File;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, manifest = Config.NONE)
public class ResidentRoutePointSyncLedgerTest {
    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void receiptSurvivesReloadAndADifferentDeviceStartsEmpty() throws Exception {
        File file = new File(temporaryFolder.newFolder("ledger"), ResidentRoutePointSyncLedger.FILE_NAME);
        Map<String, Long> defer = new LinkedHashMap<>();
        defer.put("waiting-header", 5_000L);
        ResidentRoutePointSyncLedger.State saved = ResidentRoutePointSyncLedger.State.empty("device-a")
                .apply(40L, Collections.singletonList("uploaded-point"), defer);
        assertTrue(ResidentRoutePointSyncLedger.save(file, saved));

        ResidentRoutePointSyncLedger.State loaded = ResidentRoutePointSyncLedger.load(file, "device-a");
        assertEquals(40L, loaded.cursor);
        assertTrue(loaded.skipIds(1_000L).contains("uploaded-point"));
        assertTrue(loaded.skipIds(1_000L).contains("waiting-header"));
        assertFalse(loaded.skipIds(5_000L).contains("waiting-header"));
        assertTrue(loaded.skipIds(5_000L).contains("uploaded-point"));

        ResidentRoutePointSyncLedger.State otherDevice = ResidentRoutePointSyncLedger.load(file, "device-b");
        assertEquals(0L, otherDevice.cursor);
        assertTrue(otherDevice.uploadedIds.isEmpty());
        assertEquals(40L, loaded.apply(10L, Collections.emptyList(), Collections.emptyMap()).cursor);
    }

    @Test
    public void trackedIdsStayBoundedSoARetryAfterEvictionIsStillADuplicate() {
        ResidentRoutePointSyncLedger.State state = ResidentRoutePointSyncLedger.State.empty("device-a");
        for (int index = 0; index < ResidentRoutePointSyncPolicy.MAX_TRACKED_IDS + 1; index += 1) {
            state = state.apply(index, Collections.singletonList("point-" + index), Collections.emptyMap());
        }
        assertEquals(ResidentRoutePointSyncPolicy.MAX_TRACKED_IDS, state.uploadedIds.size());
        assertFalse(state.uploadedIds.contains("point-0"));
        assertTrue(state.uploadedIds.contains("point-" + ResidentRoutePointSyncPolicy.MAX_TRACKED_IDS));
    }

    @Test
    public void corruptLedgerIsIgnoredInsteadOfBlockingTheQueue() throws Exception {
        File file = new File(temporaryFolder.newFolder("corrupt"), ResidentRoutePointSyncLedger.FILE_NAME);
        try (java.io.FileOutputStream output = new java.io.FileOutputStream(file)) {
            output.write("{not-json".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        }
        ResidentRoutePointSyncLedger.State loaded = ResidentRoutePointSyncLedger.load(file, "device-a");
        assertEquals(0L, loaded.cursor);
        assertTrue(loaded.uploadedIds.isEmpty());
    }
}
