package com.tracklog.assist;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.ContextWrapper;
import android.location.Location;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONArray;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

@RunWith(AndroidJUnit4.class)
public class ResidentLocationQueueTest {
    @Test
    public void peekKeepsPointsUntilExplicitAcknowledgement() throws Exception {
        // Never acknowledge the target application's live queue. The instrumentation APK has a
        // separate filesDir/package and is safe to mutate and clean up.
        Context context = isolatedQueueTestContext();
        assertNotEquals(
                context.getFilesDir().getAbsolutePath(),
                InstrumentationRegistry.getInstrumentation().getTargetContext()
                        .getFilesDir().getAbsolutePath()
        );
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

    @Test
    public void partiallyWrittenActiveIsNeverReadWhileOlderImmutableSpoolAwaitsAck()
            throws Exception {
        Context context = isolatedQueueTestContext();
        ResidentLocationQueue.append(
                context,
                "queue-test-trip",
                location(35.6812, 139.7671, 1_788_000_000_000L)
        );
        ResidentLocationQueue.PeekResult seed = ResidentLocationQueue.peek(context, 1);
        String seedId = seed.points.getJSONObject(0).getString("id");

        String activeLine = "{\"id\":\"concurrent-active\","
                + "\"tripId\":\"queue-test-trip\","
                + "\"ts\":\"2026-08-23T00:00:00.000Z\","
                + "\"lat\":35.6813,\"lng\":139.7672,"
                + "\"source\":\"background\",\"provider\":\"gps\"}";
        byte[] bytes = (activeLine + "\n").getBytes(StandardCharsets.UTF_8);
        int split = bytes.length / 2;
        File active = new File(context.getFilesDir(), ResidentLocationQueue.QUEUE_FILE_NAME);
        CountDownLatch partialWritten = new CountDownLatch(1);
        CountDownLatch finishWrite = new CountDownLatch(1);
        AtomicReference<Throwable> writerFailure = new AtomicReference<>();
        Thread writer = new Thread(() -> {
            try (FileOutputStream output = new FileOutputStream(active, false)) {
                output.write(bytes, 0, split);
                output.flush();
                output.getFD().sync();
                partialWritten.countDown();
                if (!finishWrite.await(10, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("Timed out waiting to finish active write");
                }
                output.write(bytes, split, bytes.length - split);
                output.flush();
                output.getFD().sync();
            } catch (Throwable throwable) {
                writerFailure.set(throwable);
                partialWritten.countDown();
            }
        }, "resident-queue-partial-writer");
        writer.start();

        try {
            assertTrue(partialWritten.await(10, TimeUnit.SECONDS));
            if (writerFailure.get() != null) throw new AssertionError(writerFailure.get());
            ResidentLocationQueue.PeekResult retry = ResidentLocationQueue.peek(context, 1);
            assertEquals(seedId, retry.points.getJSONObject(0).getString("id"));
            assertEquals(split, active.length());
            assertFalse(new File(
                    context.getFilesDir(),
                    ResidentLocationQueue.CORRUPT_FILE_NAME
            ).exists());
            assertFalse(new File(
                    context.getFilesDir(),
                    ResidentLocationQueue.QUEUE_FILE_NAME + ".cursor"
            ).exists());
        } finally {
            finishWrite.countDown();
            writer.join(10_000L);
        }
        assertFalse(writer.isAlive());
        if (writerFailure.get() != null) throw new AssertionError(writerFailure.get());

        assertEquals(1, ResidentLocationQueue.acknowledge(
                context,
                new JSONArray().put(seedId)
        ));
        ResidentLocationQueue.PeekResult activeResult = ResidentLocationQueue.peek(context, 1);
        assertEquals("concurrent-active", activeResult.points.getJSONObject(0).getString("id"));
        assertFalse(new File(
                context.getFilesDir(),
                ResidentLocationQueue.CORRUPT_FILE_NAME
        ).exists());
    }

    @Test
    public void repeatedFailedDrainDoesNotRotateNewActiveIntoTinySpools() throws Exception {
        Context context = isolatedQueueTestContext();
        ResidentLocationQueue.append(
                context,
                "queue-test-trip",
                location(35.6812, 139.7671, 1_788_000_000_000L)
        );
        ResidentLocationQueue.PeekResult seed = ResidentLocationQueue.peek(context, 1);
        String seedId = seed.points.getJSONObject(0).getString("id");
        ResidentLocationQueue.append(
                context,
                "queue-test-trip",
                location(35.6813, 139.7672, 1_788_000_030_000L)
        );

        for (int retry = 0; retry < 20; retry += 1) {
            ResidentLocationQueue.PeekResult result = ResidentLocationQueue.peek(context, 1);
            assertEquals(seedId, result.points.getJSONObject(0).getString("id"));
        }

        assertEquals(1, countDataSpools(context.getFilesDir()));
        assertTrue(new File(context.getFilesDir(), ResidentLocationQueue.QUEUE_FILE_NAME).exists());
        assertFalse(new File(
                context.getFilesDir(),
                ResidentLocationQueue.QUEUE_FILE_NAME + ".cursor"
        ).exists());
    }

    private static Context isolatedQueueTestContext() {
        Context instrumentationContext = InstrumentationRegistry.getInstrumentation().getContext();
        File directory = new File(instrumentationContext.getCacheDir(), "resident-location-queue-test");
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IllegalStateException("Unable to create isolated queue test directory");
        }
        File[] leftovers = directory.listFiles();
        if (leftovers != null) {
            for (File leftover : leftovers) {
                if (!leftover.delete()) {
                    throw new IllegalStateException("Unable to clean isolated queue test file");
                }
            }
        }
        return new ContextWrapper(instrumentationContext) {
            @Override
            public File getFilesDir() {
                return directory;
            }
        };
    }

    private static int countDataSpools(File directory) {
        File[] files = directory.listFiles(file -> file.isFile()
                && file.getName().startsWith(ResidentLocationQueue.DATA_SPOOL_PREFIX)
                && file.getName().endsWith(".jsonl"));
        return files == null ? 0 : files.length;
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
