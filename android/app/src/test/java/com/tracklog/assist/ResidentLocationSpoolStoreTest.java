package com.tracklog.assist;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

public class ResidentLocationSpoolStoreTest {
    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void activeLimitsAndAgeTriggerRotationWithoutDefiningDeletion() {
        long now = 1_800_000_000_000L;
        assertFalse(ResidentLocationSpoolStore.shouldRotate(100L, 10, now - 1_000L, now, 100L, 10, 1_000L));
        assertTrue(ResidentLocationSpoolStore.shouldRotate(101L, 10, now, now, 100L, 10, 1_000L));
        assertTrue(ResidentLocationSpoolStore.shouldRotate(100L, 11, now, now, 100L, 10, 1_000L));
        assertTrue(ResidentLocationSpoolStore.shouldRotate(100L, 10, now - 1_001L, now, 100L, 10, 1_000L));
    }

    @Test
    public void oldActiveFileMovesToSpoolWithEveryBytePreserved() throws Exception {
        File directory = temporaryFolder.newFolder("old-spool");
        File active = new File(directory, "queue.jsonl");
        List<String> original = Arrays.asList("old-one", "old-two");
        Files.write(active.toPath(), original, StandardCharsets.UTF_8);

        assertTrue(ResidentLocationSpoolStore.rotate(
                active,
                directory,
                "queue.spool.",
                123L,
                ResidentLocationSpoolStore.DEFAULT_RENAME
        ));

        List<File> files = ResidentLocationSpoolStore.orderedFiles(directory, "queue.jsonl", "queue.spool.");
        assertEquals(1, files.size());
        assertEquals(original, ResidentLocationSpoolStore.readLines(files.get(0)));
    }

    @Test
    public void spoolOrderRemainsMonotonicWhenWallClockMovesBackward() throws Exception {
        File directory = temporaryFolder.newFolder("clock-reversal");
        File active = new File(directory, "queue.jsonl");
        Files.write(active.toPath(), Arrays.asList("first"), StandardCharsets.UTF_8);
        assertTrue(ResidentLocationSpoolStore.rotate(
                active, directory, "queue.spool.", 200L, ResidentLocationSpoolStore.DEFAULT_RENAME
        ));
        Files.write(active.toPath(), Arrays.asList("second"), StandardCharsets.UTF_8);
        assertTrue(ResidentLocationSpoolStore.rotate(
                active, directory, "queue.spool.", 100L, ResidentLocationSpoolStore.DEFAULT_RENAME
        ));

        List<String> ordered = new ArrayList<>();
        for (File file : ResidentLocationSpoolStore.orderedFiles(
                directory, "queue.jsonl", "queue.spool."
        )) {
            ordered.addAll(ResidentLocationSpoolStore.readLines(file));
        }
        assertEquals(Arrays.asList("first", "second"), ordered);
    }

    @Test
    public void immutableSpoolListingNeverIncludesMutableActiveFile() throws Exception {
        File directory = temporaryFolder.newFolder("immutable-only");
        File active = new File(directory, "queue.jsonl");
        File spool = new File(directory, "queue.spool.0000000000000000001-a.jsonl");
        Files.write(active.toPath(), Arrays.asList("still-writing"), StandardCharsets.UTF_8);
        Files.write(spool.toPath(), Arrays.asList("sealed"), StandardCharsets.UTF_8);

        List<File> immutable = ResidentLocationSpoolStore.orderedSpoolFiles(
                directory,
                "queue.spool."
        );

        assertEquals(1, immutable.size());
        assertEquals(spool.getAbsolutePath(), immutable.get(0).getAbsolutePath());
    }

    @Test
    public void corruptLineBetweenNormalLinesIsIsolatedWithoutDroppingNeighbors() {
        List<String> lines = Arrays.asList("valid-before", "corrupt", "valid-after");
        ResidentLocationSpoolStore.Partition partition = ResidentLocationSpoolStore.partition(
                lines,
                line -> line.startsWith("valid-")
        );

        assertEquals(Arrays.asList("valid-before", "valid-after"), partition.valid);
        assertEquals(Arrays.asList("corrupt"), partition.invalid);
    }

    @Test
    public void partialTailIsSeparatedBeforeNextValidAppend() throws Exception {
        File directory = temporaryFolder.newFolder("partial-tail");
        File active = new File(directory, "queue.jsonl");
        Files.write(active.toPath(), "{\"partial\"".getBytes(StandardCharsets.UTF_8));

        ResidentLocationSpoolStore.appendWithSoftCap(
                active,
                directory,
                "queue.spool.",
                1_024L,
                Arrays.asList("valid-after"),
                1L,
                ResidentLocationSpoolStore.DEFAULT_RENAME
        );
        ResidentLocationSpoolStore.Partition partition = ResidentLocationSpoolStore.partition(
                ResidentLocationSpoolStore.readLines(active),
                line -> line.equals("valid-after")
        );

        assertEquals(Arrays.asList("valid-after"), partition.valid);
        assertEquals(Arrays.asList("{\"partial\""), partition.invalid);
    }

    @Test
    public void quarantineSoftCapRotatesAndRetainsAllLines() throws Exception {
        File directory = temporaryFolder.newFolder("quarantine");
        File active = new File(directory, "corrupt.jsonl");
        ResidentLocationSpoolStore.appendWithSoftCap(
                active,
                directory,
                "corrupt.spool.",
                8L,
                Arrays.asList("bad-a"),
                1L,
                ResidentLocationSpoolStore.DEFAULT_RENAME
        );
        ResidentLocationSpoolStore.appendWithSoftCap(
                active,
                directory,
                "corrupt.spool.",
                8L,
                Arrays.asList("bad-b"),
                2L,
                ResidentLocationSpoolStore.DEFAULT_RENAME
        );

        List<String> recovered = new ArrayList<>();
        for (File file : ResidentLocationSpoolStore.orderedFiles(
                directory,
                "corrupt.jsonl",
                "corrupt.spool."
        )) {
            recovered.addAll(ResidentLocationSpoolStore.readLines(file));
        }
        assertEquals(Arrays.asList("bad-a", "bad-b"), recovered);
        assertTrue(active.length() <= 8L);
    }

    @Test
    public void failedRotationExceedsSoftCapRatherThanLosingData() throws Exception {
        File directory = temporaryFolder.newFolder("failed-rotation");
        File active = new File(directory, "queue.jsonl");
        Files.write(active.toPath(), Arrays.asList("first"), StandardCharsets.UTF_8);

        ResidentLocationSpoolStore.appendWithSoftCap(
                active,
                directory,
                "queue.spool.",
                8L,
                Arrays.asList("second"),
                1L,
                (source, destination) -> false
        );

        assertEquals(Arrays.asList("first", "second"), ResidentLocationSpoolStore.readLines(active));
        assertEquals(1, ResidentLocationSpoolStore.orderedFiles(
                directory,
                "queue.jsonl",
                "queue.spool."
        ).size());
    }

    @Test
    public void failedRewriteRestoresOriginalOnNextStartup() throws Exception {
        File directory = temporaryFolder.newFolder("rewrite-recovery");
        File source = new File(directory, "queue.jsonl");
        List<String> original = Arrays.asList("one", "two");
        Files.write(source.toPath(), original, StandardCharsets.UTF_8);
        AtomicInteger renameCount = new AtomicInteger();
        ResidentLocationSpoolStore.RenameOperation failAfterBackup = (from, to) -> {
            if (renameCount.incrementAndGet() == 1) return from.renameTo(to);
            return false;
        };

        try {
            ResidentLocationSpoolStore.rewriteAtomically(
                    source,
                    Arrays.asList("two"),
                    failAfterBackup
            );
            fail("rewrite should fail");
        } catch (IllegalStateException expected) {
            // Simulates process loss after the original was durably renamed to backup.
        }

        ResidentLocationSpoolStore.recoverRewrite(source, ResidentLocationSpoolStore.DEFAULT_RENAME);
        ResidentLocationSpoolStore.recoverRewrite(source, ResidentLocationSpoolStore.DEFAULT_RENAME);
        assertEquals(original, ResidentLocationSpoolStore.readLines(source));
    }

    @Test
    public void failedStartupRestoreLeavesBackupAuthoritativeAndStopsRecovery() throws Exception {
        File directory = temporaryFolder.newFolder("blocked-recovery");
        File source = new File(directory, "queue.jsonl");
        File backup = new File(directory, "queue.jsonl.rewrite.bak");
        Files.write(backup.toPath(), Arrays.asList("not-lost"), StandardCharsets.UTF_8);

        try {
            ResidentLocationSpoolStore.recoverRewrite(source, (from, to) -> false);
            fail("recovery should fail closed");
        } catch (IllegalStateException expected) {
            // No new active file may be created while the authoritative backup is stranded.
        }
        assertFalse(source.exists());
        assertEquals(Arrays.asList("not-lost"), ResidentLocationSpoolStore.readLines(backup));
    }

    @Test
    public void legacyRewriteTempIsRecoveredOnlyWhenNoAuthoritativeQueueExists() throws Exception {
        File directory = temporaryFolder.newFolder("legacy-recovery");
        File source = new File(directory, "queue.jsonl");
        File legacyTemp = new File(directory, "queue.jsonl.tmp");
        Files.write(legacyTemp.toPath(), Arrays.asList("legacy-survivor"), StandardCharsets.UTF_8);

        ResidentLocationSpoolStore.recoverLegacyTemp(
                source,
                legacyTemp,
                ResidentLocationSpoolStore.DEFAULT_RENAME
        );
        assertEquals(Arrays.asList("legacy-survivor"), ResidentLocationSpoolStore.readLines(source));

        Files.write(legacyTemp.toPath(), Arrays.asList("stale-subset"), StandardCharsets.UTF_8);
        ResidentLocationSpoolStore.recoverLegacyTemp(
                source,
                legacyTemp,
                ResidentLocationSpoolStore.DEFAULT_RENAME
        );
        assertEquals(Arrays.asList("legacy-survivor"), ResidentLocationSpoolStore.readLines(source));
        assertEquals(Arrays.asList("stale-subset"), ResidentLocationSpoolStore.readLines(legacyTemp));
    }

    @Test
    public void failedLegacyTempRestoreKeepsTheOnlyCopyAndFailsClosed() throws Exception {
        File directory = temporaryFolder.newFolder("legacy-restore-failure");
        File source = new File(directory, "queue.jsonl");
        File legacyTemp = new File(directory, "queue.jsonl.tmp");
        Files.write(legacyTemp.toPath(), Arrays.asList("only-copy"), StandardCharsets.UTF_8);

        try {
            ResidentLocationSpoolStore.recoverLegacyTemp(source, legacyTemp, (from, to) -> false);
            fail("legacy recovery should fail closed");
        } catch (IllegalStateException expected) {
            // The caller must stop appending until the authoritative temp can be restored.
        }

        assertFalse(source.exists());
        assertEquals(Arrays.asList("only-copy"), ResidentLocationSpoolStore.readLines(legacyTemp));
    }

    @Test
    public void cursorUpdateIsAtomicAndCorruptionReplaysFromZero() throws Exception {
        File directory = temporaryFolder.newFolder("cursor");
        File data = new File(directory, "queue.spool.0000000000000000001-a.jsonl");
        Files.write(data.toPath(), Arrays.asList("one", "two", "three"), StandardCharsets.UTF_8);

        ResidentLocationSpoolStore.writeCursor(
                data,
                4L,
                ResidentLocationSpoolStore.DEFAULT_RENAME
        );
        assertEquals(4L, ResidentLocationSpoolStore.readCursor(
                data,
                ResidentLocationSpoolStore.DEFAULT_RENAME
        ));

        File cursor = new File(directory, data.getName() + ".cursor");
        Files.write(cursor.toPath(), Arrays.asList("broken"), StandardCharsets.UTF_8);
        assertEquals(0L, ResidentLocationSpoolStore.readCursor(
                data,
                ResidentLocationSpoolStore.DEFAULT_RENAME
        ));

        Files.write(cursor.toPath(), Arrays.asList("999999"), StandardCharsets.UTF_8);
        assertEquals(0L, ResidentLocationSpoolStore.readCursor(
                data,
                ResidentLocationSpoolStore.DEFAULT_RENAME
        ));

        Files.write(cursor.toPath(), Arrays.asList("2"), StandardCharsets.UTF_8);
        assertEquals(0L, ResidentLocationSpoolStore.readCursor(
                data,
                ResidentLocationSpoolStore.DEFAULT_RENAME
        ));
    }
}
