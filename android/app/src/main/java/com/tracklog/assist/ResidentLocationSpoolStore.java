package com.tracklog.assist;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;

/** File-only helpers for the recoverable JSONL spool. No Android APIs are used here. */
final class ResidentLocationSpoolStore {
    interface RenameOperation {
        boolean rename(File source, File destination);
    }

    interface LineValidator {
        boolean isValid(String line);
    }

    static final RenameOperation DEFAULT_RENAME = File::renameTo;

    private ResidentLocationSpoolStore() {}

    static boolean shouldRotate(
            long bytes,
            int recordCount,
            long oldestTimestampMs,
            long nowMs,
            long maxBytes,
            int maxRecords,
            long maxActiveAgeMs
    ) {
        boolean tooOld = oldestTimestampMs > 0L
                && nowMs > oldestTimestampMs
                && nowMs - oldestTimestampMs > maxActiveAgeMs;
        return bytes > maxBytes || recordCount > maxRecords || tooOld;
    }

    static boolean rotate(
            File active,
            File directory,
            String spoolPrefix,
            long nowMs,
            RenameOperation rename
    ) {
        if (!active.exists() || active.length() == 0L) return true;
        File spool = new File(directory, nextSpoolName(directory, spoolPrefix, nowMs));
        return rename.rename(active, spool);
    }

    static List<File> orderedFiles(File directory, String activeName, String spoolPrefix) {
        List<File> ordered = orderedSpoolFiles(directory, spoolPrefix);
        File active = new File(directory, activeName);
        if (active.exists() && active.length() > 0L) ordered.add(active);
        return ordered;
    }

    static List<File> orderedSpoolFiles(File directory, String spoolPrefix) {
        File[] spools = directory.listFiles(file -> file.isFile()
                && file.getName().startsWith(spoolPrefix)
                && file.getName().endsWith(".jsonl"));
        List<File> ordered = new ArrayList<>();
        if (spools != null) {
            Arrays.sort(spools, Comparator.comparing(File::getName));
            ordered.addAll(Arrays.asList(spools));
        }
        return ordered;
    }

    static void recoverLegacyTemp(
            File source,
            File legacyTemp,
            RenameOperation rename
    ) {
        if (source.exists() || !legacyTemp.exists()) return;
        if (!rename.rename(legacyTemp, source)) {
            throw new IllegalStateException("Unable to recover legacy queue rewrite");
        }
    }

    static Partition partition(List<String> lines, LineValidator validator) {
        List<String> valid = new ArrayList<>();
        List<String> invalid = new ArrayList<>();
        for (String line : lines) {
            if (line == null || line.trim().isEmpty()) continue;
            if (validator.isValid(line)) valid.add(line); else invalid.add(line);
        }
        return new Partition(valid, invalid);
    }

    static void appendWithSoftCap(
            File active,
            File directory,
            String spoolPrefix,
            long maxActiveBytes,
            List<String> lines,
            long nowMs,
        RenameOperation rename
    ) throws Exception {
        if (lines.isEmpty()) return;
        List<String> pending = new ArrayList<>();
        long pendingBytes = 0L;
        for (String line : lines) {
            long lineBytes = line.getBytes(StandardCharsets.UTF_8).length + 1L;
            long activeBytes = (active.exists() ? active.length() : 0L) + pendingBytes;
            if (lineBytes > maxActiveBytes) {
                if (!pending.isEmpty()) {
                    appendLines(active, pending);
                    pending.clear();
                    pendingBytes = 0L;
                }
                if (active.exists() && active.length() > 0L) {
                    rotate(active, directory, spoolPrefix, nowMs, rename);
                }
                appendLines(active, java.util.Collections.singletonList(line));
                // Oversized corrupt records cannot be split without changing their recoverable
                // bytes. Store the complete line in its own spool and keep the active cap intact.
                rotate(active, directory, spoolPrefix, nowMs, rename);
                continue;
            }
            boolean wouldExceed = lineBytes > maxActiveBytes - Math.min(activeBytes, maxActiveBytes);
            if (activeBytes > 0L && wouldExceed) {
                if (!pending.isEmpty()) {
                    appendLines(active, pending);
                    pending.clear();
                    pendingBytes = 0L;
                }
                // A failed rotation deliberately leaves the original active file in place.
                // Appending may exceed the soft cap, but no record is discarded.
                rotate(active, directory, spoolPrefix, nowMs, rename);
            }
            pending.add(line);
            pendingBytes += lineBytes;
        }
        if (!pending.isEmpty()) appendLines(active, pending);
    }

    static void rewriteAtomically(
            File source,
            List<String> lines,
            RenameOperation rename
    ) throws Exception {
        recoverRewrite(source, rename);
        File temp = tempFile(source);
        File backup = backupFile(source);
        writeLines(temp, lines);

        if (!source.exists()) {
            if (!rename.rename(temp, source)) {
                throw new IllegalStateException("Unable to promote queue rewrite");
            }
            return;
        }
        if (!rename.rename(source, backup)) {
            throw new IllegalStateException("Unable to preserve queue before rewrite");
        }
        if (!rename.rename(temp, source)) {
            // Restoration failure is still recoverable: backup remains authoritative and is
            // restored on the next call/startup.
            rename.rename(backup, source);
            throw new IllegalStateException("Unable to install queue rewrite");
        }
        if (backup.exists()) backup.delete();
    }

    static void recoverRewrite(File source, RenameOperation rename) {
        File temp = tempFile(source);
        File backup = backupFile(source);
        if (source.exists()) {
            // The visible source is authoritative. A backup is either from a committed rewrite
            // or a successfully restored original; a temp is an uncommitted duplicate.
            if (backup.exists()) backup.delete();
            if (temp.exists()) temp.delete();
            return;
        }
        if (backup.exists()) {
            if (!rename.rename(backup, source)) {
                throw new IllegalStateException("Unable to restore queue backup");
            }
            return;
        }
        if (temp.exists() && !rename.rename(temp, source)) {
            throw new IllegalStateException("Unable to recover queue rewrite");
        }
    }

    static void recoverDirectory(File directory, RenameOperation rename) {
        File[] pending = directory.listFiles(file -> file.isFile()
                && (file.getName().endsWith(".rewrite.bak")
                || file.getName().endsWith(".rewrite.tmp")));
        if (pending == null) return;
        for (File file : pending) {
            String name = file.getName();
            String suffix = name.endsWith(".rewrite.bak") ? ".rewrite.bak" : ".rewrite.tmp";
            recoverRewrite(new File(directory, name.substring(0, name.length() - suffix.length())), rename);
        }
    }

    static List<String> readLines(File file) throws Exception {
        List<String> lines = new ArrayList<>();
        if (!file.exists()) return lines;
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                new FileInputStream(file), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) lines.add(line);
        }
        return lines;
    }

    static long readCursor(File dataFile, RenameOperation rename) {
        File cursor = cursorFile(dataFile);
        recoverRewrite(cursor, rename);
        if (!cursor.exists()) return 0L;
        try {
            List<String> lines = readLines(cursor);
            if (lines.isEmpty()) return 0L;
            long parsed = Long.parseLong(lines.get(0).trim());
            if (parsed < 0L || parsed > dataFile.length() || !isCursorBoundary(dataFile, parsed)) {
                return 0L;
            }
            return parsed;
        } catch (Exception ignored) {
            // Falling back to zero can only replay already persisted points; it cannot lose data.
            return 0L;
        }
    }

    static void writeCursor(File dataFile, long offset, RenameOperation rename) throws Exception {
        rewriteAtomically(
                cursorFile(dataFile),
                java.util.Collections.singletonList(Long.toString(Math.max(0L, offset))),
                rename
        );
    }

    static void deleteCursor(File dataFile) {
        File cursor = cursorFile(dataFile);
        if (cursor.exists()) cursor.delete();
        File temp = tempFile(cursor);
        if (temp.exists()) temp.delete();
        File backup = backupFile(cursor);
        if (backup.exists()) backup.delete();
    }

    private static boolean isCursorBoundary(File dataFile, long offset) throws Exception {
        if (offset == 0L || offset == dataFile.length()) return true;
        try (RandomAccessFile input = new RandomAccessFile(dataFile, "r")) {
            input.seek(offset - 1L);
            int previous = input.read();
            return previous == '\n' || previous == '\r';
        }
    }

    private static void appendLines(File file, List<String> lines) throws Exception {
        boolean needsLeadingNewline = needsLeadingNewline(file);
        try (FileOutputStream output = new FileOutputStream(file, true);
             OutputStreamWriter streamWriter = new OutputStreamWriter(output, StandardCharsets.UTF_8);
             BufferedWriter writer = new BufferedWriter(streamWriter)) {
            if (needsLeadingNewline) writer.newLine();
            for (String line : lines) {
                writer.write(line);
                writer.newLine();
            }
            writer.flush();
            output.getFD().sync();
        }
    }

    private static boolean needsLeadingNewline(File file) throws Exception {
        if (!file.exists() || file.length() == 0L) return false;
        try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
            input.seek(input.length() - 1L);
            int last = input.read();
            return last != '\n' && last != '\r';
        }
    }

    private static void writeLines(File file, List<String> lines) throws Exception {
        try (FileOutputStream output = new FileOutputStream(file, false);
             OutputStreamWriter streamWriter = new OutputStreamWriter(output, StandardCharsets.UTF_8);
             BufferedWriter writer = new BufferedWriter(streamWriter)) {
            for (String line : lines) {
                writer.write(line);
                writer.newLine();
            }
            writer.flush();
            output.getFD().sync();
        }
    }

    private static String nextSpoolName(File directory, String prefix, long nowMs) {
        long sequence = Math.max(0L, nowMs);
        File[] existing = directory.listFiles(file -> file.isFile()
                && file.getName().startsWith(prefix)
                && file.getName().endsWith(".jsonl"));
        if (existing != null) {
            for (File file : existing) {
                String suffix = file.getName().substring(prefix.length());
                if (suffix.length() < 19) continue;
                try {
                    long prior = Long.parseLong(suffix.substring(0, 19));
                    if (prior >= sequence && prior < Long.MAX_VALUE) sequence = prior + 1L;
                } catch (NumberFormatException ignored) {
                    // UUID suffix still makes the next valid spool name collision-safe.
                }
            }
        }
        return prefix
                + String.format(java.util.Locale.US, "%019d", sequence)
                + "-"
                + UUID.randomUUID()
                + ".jsonl";
    }

    private static File tempFile(File source) {
        return new File(source.getParentFile(), source.getName() + ".rewrite.tmp");
    }

    private static File cursorFile(File dataFile) {
        return new File(dataFile.getParentFile(), dataFile.getName() + ".cursor");
    }

    private static File backupFile(File source) {
        return new File(source.getParentFile(), source.getName() + ".rewrite.bak");
    }

    static final class Partition {
        final List<String> valid;
        final List<String> invalid;

        Partition(List<String> valid, List<String> invalid) {
            this.valid = valid;
            this.invalid = invalid;
        }
    }
}
