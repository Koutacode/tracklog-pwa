package com.tracklog.assist;

import android.content.Context;
import android.location.Location;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.text.ParseException;
import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.UUID;

final class ResidentLocationQueue {
    static final String QUEUE_FILE_NAME = "resident-location-points.jsonl";
    static final String LEGACY_TEMP_FILE_NAME = "resident-location-points.jsonl.tmp";
    static final String DATA_SPOOL_PREFIX = "resident-location-points.spool.";
    static final String CORRUPT_FILE_NAME = "resident-location-points.corrupt.jsonl";
    static final String CORRUPT_SPOOL_PREFIX = "resident-location-points.corrupt.spool.";
    static final int MAX_ACTIVE_RECORDS = 60_000;
    static final long MAX_ACTIVE_BYTES = 24L * 1024L * 1024L;
    static final long MAX_ACTIVE_AGE_MS = 30L * 24L * 60L * 60L * 1000L;
    static final long ACTIVE_IDLE_SEAL_MS = 2L * 60L * 1000L;
    static final long MAX_ACTIVE_CORRUPT_BYTES = 256L * 1024L;
    private static final Object FILE_LOCK = new Object();
    private static final Object DRAIN_LOCK = new Object();
    private static final Map<String, AckMarker> lastPeekMarkers = new LinkedHashMap<>();

    private static String cachedActivePath = "";
    private static int cachedActiveRecordCount = -1;
    private static int cachedActiveValidRecordCount = -1;
    private static long cachedOldestTimestampMs = 0L;
    private static long cachedActiveLength = -1L;

    private ResidentLocationQueue() {}

    static void append(Context context, String tripId, Location location) throws Exception {
        append(context, tripId, location, "");
    }

    static void append(
            Context context,
            String tripId,
            Location location,
            String monotonicSessionId
    ) throws Exception {
        JSONObject point = new JSONObject();
        point.put("id", UUID.randomUUID().toString());
        point.put("tripId", tripId);
        point.put("ts", toIsoTimestamp(location.getTime()));
        point.put("lat", location.getLatitude());
        point.put("lng", location.getLongitude());
        putNullable(point, "accuracy", location.hasAccuracy() ? location.getAccuracy() : null);
        putNullable(point, "speed", location.hasSpeed() ? location.getSpeed() : null);
        putNullable(point, "heading", location.hasBearing() ? location.getBearing() : null);
        point.put("source", "background");
        point.put("provider", location.getProvider() == null ? JSONObject.NULL : location.getProvider());
        if (monotonicSessionId != null && !monotonicSessionId.trim().isEmpty()) {
            point.put("monotonicSessionId", monotonicSessionId.trim());
        }
        long elapsedRealtimeNanos = location.getElapsedRealtimeNanos();
        if (elapsedRealtimeNanos > 0L) {
            point.put("elapsedRealtimeMs", elapsedRealtimeNanos / 1_000_000L);
        }
        appendSerialized(context, point.toString(), location.getTime());
    }

    private static void appendSerialized(Context context, String line, long timestampMs) throws Exception {
        synchronized (FILE_LOCK) {
            File directory = context.getFilesDir();
            File active = new File(directory, QUEUE_FILE_NAME);
            recoverActiveLocked(directory);
            ActiveStats stats = activeStats(active);
            long incomingBytes = line.getBytes(StandardCharsets.UTF_8).length + 1L;
            long normalizedTimestamp = Math.max(0L, timestampMs);
            long oldest = stats.oldestTimestampMs;
            if (normalizedTimestamp > 0L) {
                oldest = oldest <= 0L ? normalizedTimestamp : Math.min(oldest, normalizedTimestamp);
            }
            boolean shouldRotate = active.exists()
                    && active.length() > 0L
                    && ResidentLocationSpoolStore.shouldRotate(
                    active.length() + incomingBytes,
                    stats.recordCount + 1,
                    oldest,
                    System.currentTimeMillis(),
                    MAX_ACTIVE_BYTES,
                    MAX_ACTIVE_RECORDS,
                    MAX_ACTIVE_AGE_MS
            );
            if (shouldRotate && ResidentLocationSpoolStore.rotate(
                    active,
                    directory,
                    DATA_SPOOL_PREFIX,
                    System.currentTimeMillis(),
                    ResidentLocationSpoolStore.DEFAULT_RENAME
            )) {
                resetActiveStats(active);
                stats = new ActiveStats(0, 0, 0L);
                oldest = normalizedTimestamp;
            }
            ResidentLocationSpoolStore.appendWithSoftCap(
                    active,
                    directory,
                    DATA_SPOOL_PREFIX,
                    Long.MAX_VALUE,
                    Collections.singletonList(line),
                    System.currentTimeMillis(),
                    ResidentLocationSpoolStore.DEFAULT_RENAME
            );
            cachedActivePath = active.getAbsolutePath();
            cachedActiveRecordCount = stats.recordCount + 1;
            cachedActiveValidRecordCount = stats.validRecordCount + 1;
            cachedOldestTimestampMs = oldest;
            cachedActiveLength = active.length();
        }
    }

    static PeekResult peek(Context context, int requestedLimit) throws Exception {
        int limit = Math.max(1, Math.min(requestedLimit, 5000));
        synchronized (DRAIN_LOCK) {
            File directory = context.getFilesDir();
            recover(directory);
            lastPeekMarkers.clear();
            JSONArray points = new JSONArray();
            boolean hasMore = false;
            List<File> files = unconsumedDataSpools(directory);
            // Immutable spools are always drained first. Keeping a newer active segment open
            // avoids producing a tiny spool on every failed WebView/Dexie retry.
            if (files.isEmpty()) {
                if (!sealActiveForDrain(directory)) {
                    return new PeekResult(points, 1);
                }
                files = unconsumedDataSpools(directory);
            }
            for (int fileIndex = 0; fileIndex < files.size(); fileIndex += 1) {
                File file = files.get(fileIndex);
                long cursor = ResidentLocationSpoolStore.readCursor(
                        file,
                        ResidentLocationSpoolStore.DEFAULT_RENAME
                );
                try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
                    input.seek(cursor);
                    while (points.length() < limit) {
                        long lineStart = input.getFilePointer();
                        String encoded = input.readLine();
                        if (encoded == null) break;
                        long lineEnd = input.getFilePointer();
                        String line = new String(
                                encoded.getBytes(StandardCharsets.ISO_8859_1),
                                StandardCharsets.UTF_8
                        );
                        if (line.trim().isEmpty()) {
                            if (hasMarkerForFile(file, cursor)) {
                                hasMore = true;
                                break;
                            }
                            ResidentLocationSpoolStore.writeCursor(
                                    file,
                                    lineEnd,
                                    ResidentLocationSpoolStore.DEFAULT_RENAME
                            );
                            cursor = lineEnd;
                            continue;
                        }
                        JSONObject point = parsePoint(line);
                        if (point == null) {
                            // Only advance immediately when no valid point in this file is waiting
                            // for acknowledgement ahead of the malformed record.
                            boolean unacknowledgedPrefix = hasMarkerForFile(file, cursor);
                            if (unacknowledgedPrefix) {
                                hasMore = true;
                                break;
                            }
                            quarantine(directory, Collections.singletonList(line));
                            ResidentLocationSpoolStore.writeCursor(
                                    file,
                                    lineEnd,
                                    ResidentLocationSpoolStore.DEFAULT_RENAME
                            );
                            cursor = lineEnd;
                            continue;
                        }
                        String id = point.optString("id", "").trim();
                        points.put(point);
                        lastPeekMarkers.put(id, new AckMarker(file, lineStart, lineEnd));
                    }
                    if (input.getFilePointer() < input.length()) hasMore = true;
                }
                if (points.length() >= limit) {
                    if (fileIndex + 1 < files.size()) hasMore = true;
                    break;
                }
                if (cursor >= file.length() && !hasMarkerForFile(file, cursor)) {
                    deleteConsumedSpool(file);
                }
            }
            // Appends can continue while immutable spools are read. A newly-created active
            // segment is intentionally left for the next drain pass.
            if (hasActiveData(directory)) hasMore = true;
            return new PeekResult(points, hasMore ? 1 : 0);
        }
    }

    static int acknowledge(Context context, JSONArray acknowledgedIds) throws Exception {
        Set<String> ids = new HashSet<>();
        if (acknowledgedIds != null) {
            for (int index = 0; index < acknowledgedIds.length(); index += 1) {
                String id = acknowledgedIds.optString(index, "").trim();
                if (!id.isEmpty()) ids.add(id);
            }
        }
        synchronized (DRAIN_LOCK) {
            File directory = context.getFilesDir();
            recover(directory);
            if (!ids.isEmpty()) {
                Map<File, List<AckMarker>> markersByFile = new LinkedHashMap<>();
                for (String id : ids) {
                    AckMarker marker = lastPeekMarkers.get(id);
                    if (marker == null) continue;
                    markersByFile.computeIfAbsent(marker.file, ignored -> new ArrayList<>()).add(marker);
                }
                for (Map.Entry<File, List<AckMarker>> entry : markersByFile.entrySet()) {
                    File file = entry.getKey();
                    if (!file.exists()) continue;
                    List<AckMarker> markers = entry.getValue();
                    markers.sort((first, second) -> Long.compare(first.startOffset, second.startOffset));
                    long cursor = ResidentLocationSpoolStore.readCursor(
                            file,
                            ResidentLocationSpoolStore.DEFAULT_RENAME
                    );
                    long advanced = cursor;
                    for (AckMarker marker : markers) {
                        if (marker.startOffset < advanced) continue;
                        if (marker.startOffset != advanced) break;
                        advanced = marker.endOffset;
                    }
                    if (advanced > cursor) {
                        ResidentLocationSpoolStore.writeCursor(
                                file,
                                advanced,
                                ResidentLocationSpoolStore.DEFAULT_RENAME
                        );
                    }
                    if (advanced >= file.length()) deleteConsumedSpool(file);
                }
                for (String id : ids) lastPeekMarkers.remove(id);
            }
            return hasQueuedData(directory) ? 1 : 0;
        }
    }

    /**
     * Seals a quiet active file so a trip that stopped below the size cap is still represented by
     * an immutable spool. Appends and drains use the same lock order, so a partial active write is
     * never renamed underneath either operation.
     */
    static boolean sealActiveIfIdle(Context context, long nowMs) {
        synchronized (DRAIN_LOCK) {
            File directory = context.getFilesDir();
            synchronized (FILE_LOCK) {
                recoverActiveLocked(directory);
                File active = new File(directory, QUEUE_FILE_NAME);
                if (!shouldSealActiveForIdle(
                        active.exists(),
                        active.length(),
                        active.lastModified(),
                        nowMs,
                        ACTIVE_IDLE_SEAL_MS
                )) {
                    return true;
                }
                boolean rotated = ResidentLocationSpoolStore.rotate(
                        active,
                        directory,
                        DATA_SPOOL_PREFIX,
                        nowMs,
                        ResidentLocationSpoolStore.DEFAULT_RENAME
                );
                if (rotated) resetActiveStats(active);
                return rotated;
            }
        }
    }

    static boolean sealActive(Context context) {
        synchronized (DRAIN_LOCK) {
            return sealActiveForDrain(context.getFilesDir());
        }
    }

    static boolean shouldSealActiveForIdle(
            boolean exists,
            long length,
            long lastModifiedAtMs,
            long nowMs,
            long idleThresholdMs
    ) {
        if (!exists || length <= 0L || lastModifiedAtMs <= 0L || idleThresholdMs < 0L) {
            return false;
        }
        if (nowMs < lastModifiedAtMs) return false;
        return nowMs - lastModifiedAtMs >= idleThresholdMs;
    }

    static int count(Context context) {
        synchronized (DRAIN_LOCK) {
            try {
                File directory = context.getFilesDir();
                recover(directory);
                int spoolCount = countLocked(directory);
                synchronized (FILE_LOCK) {
                    File active = new File(directory, QUEUE_FILE_NAME);
                    recoverActiveLocked(directory);
                    ActiveStats activeValues = activeStats(active);
                    if (spoolCount > Integer.MAX_VALUE - activeValues.validRecordCount) {
                        return Integer.MAX_VALUE;
                    }
                    return spoolCount + activeValues.validRecordCount;
                }
            } catch (Exception ignored) {
                return 0;
            }
        }
    }

    static StorageDiagnostics storageDiagnostics(Context context) {
        synchronized (DRAIN_LOCK) {
            try {
                File directory = context.getFilesDir();
                recover(directory);
                long bytes = 0L;
                int segments = 0;
                long quarantinedBytes = 0L;
                int quarantineSegments = 0;
                for (File file : dataFiles(directory)) {
                    if (!isDataSpool(file)) continue;
                    long cursor = ResidentLocationSpoolStore.readCursor(
                            file,
                            ResidentLocationSpoolStore.DEFAULT_RENAME
                    );
                    long remaining = Math.max(0L, file.length() - cursor);
                    if (remaining <= 0L) continue;
                    bytes = saturatingAdd(bytes, remaining);
                    if (segments < Integer.MAX_VALUE) segments += 1;
                }
                synchronized (FILE_LOCK) {
                    File active = new File(directory, QUEUE_FILE_NAME);
                    recoverActiveLocked(directory);
                    if (active.exists() && active.length() > 0L) {
                        bytes = saturatingAdd(bytes, active.length());
                        if (segments < Integer.MAX_VALUE) segments += 1;
                    }
                }
                for (File file : ResidentLocationSpoolStore.orderedFiles(
                        directory,
                        CORRUPT_FILE_NAME,
                        CORRUPT_SPOOL_PREFIX
                )) {
                    if (file.length() <= 0L) continue;
                    quarantinedBytes = saturatingAdd(quarantinedBytes, file.length());
                    if (quarantineSegments < Integer.MAX_VALUE) quarantineSegments += 1;
                }
                return new StorageDiagnostics(
                        bytes,
                        segments,
                        quarantinedBytes,
                        quarantineSegments,
                        true
                );
            } catch (Exception ignored) {
                return new StorageDiagnostics(0L, 0, 0L, 0, false);
            }
        }
    }

    private static long saturatingAdd(long first, long second) {
        if (second > 0L && first > Long.MAX_VALUE - second) return Long.MAX_VALUE;
        return first + second;
    }

    private static int countLocked(File directory) throws Exception {
        long count = 0L;
        for (File file : dataFiles(directory)) {
            if (!isDataSpool(file)) continue;
            long cursor = ResidentLocationSpoolStore.readCursor(
                    file,
                    ResidentLocationSpoolStore.DEFAULT_RENAME
            );
            try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
                input.seek(cursor);
                String encoded;
                while ((encoded = input.readLine()) != null) {
                    String line = new String(
                            encoded.getBytes(StandardCharsets.ISO_8859_1),
                            StandardCharsets.UTF_8
                    );
                    if (parsePoint(line) != null) count += 1L;
                    if (count >= Integer.MAX_VALUE) return Integer.MAX_VALUE;
                }
            }
        }
        return (int) count;
    }

    private static void quarantine(File directory, List<String> malformed) throws Exception {
        ResidentLocationSpoolStore.appendWithSoftCap(
                new File(directory, CORRUPT_FILE_NAME),
                directory,
                CORRUPT_SPOOL_PREFIX,
                MAX_ACTIVE_CORRUPT_BYTES,
                malformed,
                System.currentTimeMillis(),
                ResidentLocationSpoolStore.DEFAULT_RENAME
        );
    }

    private static List<File> dataFiles(File directory) {
        return ResidentLocationSpoolStore.orderedFiles(
                directory,
                QUEUE_FILE_NAME,
                DATA_SPOOL_PREFIX
        );
    }

    private static boolean sealActiveForDrain(File directory) {
        synchronized (FILE_LOCK) {
            File active = new File(directory, QUEUE_FILE_NAME);
            recoverActiveLocked(directory);
            if (!active.exists() || active.length() == 0L) return true;
            boolean rotated = ResidentLocationSpoolStore.rotate(
                    active,
                    directory,
                    DATA_SPOOL_PREFIX,
                    System.currentTimeMillis(),
                    ResidentLocationSpoolStore.DEFAULT_RENAME
            );
            if (rotated) resetActiveStats(active);
            return rotated;
        }
    }

    private static boolean hasMarkerForFile(File file, long cursor) {
        for (AckMarker marker : lastPeekMarkers.values()) {
            if (marker.file.equals(file) && marker.startOffset >= cursor) return true;
        }
        return false;
    }

    private static void deleteConsumedSpool(File file) {
        if (!isDataSpool(file)) return;
        if (file.exists() && file.delete()) ResidentLocationSpoolStore.deleteCursor(file);
    }

    private static boolean hasQueuedData(File directory) {
        if (!unconsumedDataSpools(directory).isEmpty()) return true;
        return hasActiveData(directory);
    }

    private static boolean hasActiveData(File directory) {
        synchronized (FILE_LOCK) {
            recoverActiveLocked(directory);
            File active = new File(directory, QUEUE_FILE_NAME);
            return active.exists() && active.length() > 0L;
        }
    }

    private static boolean isDataSpool(File file) {
        return file.getName().startsWith(DATA_SPOOL_PREFIX) && file.getName().endsWith(".jsonl");
    }

    private static List<File> unconsumedDataSpools(File directory) {
        List<File> unconsumed = new ArrayList<>();
        for (File file : ResidentLocationSpoolStore.orderedSpoolFiles(
                directory,
                DATA_SPOOL_PREFIX
        )) {
            long cursor = ResidentLocationSpoolStore.readCursor(
                    file,
                    ResidentLocationSpoolStore.DEFAULT_RENAME
            );
            if (cursor >= file.length()) {
                deleteConsumedSpool(file);
            } else {
                unconsumed.add(file);
            }
        }
        return unconsumed;
    }

    private static void recover(File directory) {
        synchronized (FILE_LOCK) {
            ResidentLocationSpoolStore.recoverDirectory(
                    directory,
                    ResidentLocationSpoolStore.DEFAULT_RENAME
            );
            recoverActiveLocked(directory);
        }
    }

    private static void recoverActiveLocked(File directory) {
        File active = new File(directory, QUEUE_FILE_NAME);
        // New fail-closed recovery is authoritative over the legacy single-temp scheme.
        ResidentLocationSpoolStore.recoverRewrite(
                active,
                ResidentLocationSpoolStore.DEFAULT_RENAME
        );
        ResidentLocationSpoolStore.recoverLegacyTemp(
                active,
                new File(directory, LEGACY_TEMP_FILE_NAME),
                ResidentLocationSpoolStore.DEFAULT_RENAME
        );
    }

    private static ActiveStats activeStats(File active) throws Exception {
        String path = active.getAbsolutePath();
        long length = active.exists() ? active.length() : 0L;
        if (path.equals(cachedActivePath) && cachedActiveLength == length && cachedActiveRecordCount >= 0) {
            return new ActiveStats(
                    cachedActiveRecordCount,
                    Math.max(0, cachedActiveValidRecordCount),
                    cachedOldestTimestampMs
            );
        }
        int count = 0;
        int validCount = 0;
        long oldest = 0L;
        if (active.exists()) {
            try (BufferedReader reader = reader(active)) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.trim().isEmpty()) continue;
                    count += 1;
                    JSONObject point = parsePoint(line);
                    if (point == null) continue;
                    validCount += 1;
                    try {
                        long timestamp = parseIsoTimestamp(point.getString("ts"));
                        if (oldest <= 0L || timestamp < oldest) oldest = timestamp;
                    } catch (JSONException | ParseException ignored) {
                        // Invalid timestamps are isolated when the queue is peeked/acknowledged.
                    }
                }
            }
        }
        cachedActivePath = path;
        cachedActiveRecordCount = count;
        cachedActiveValidRecordCount = validCount;
        cachedOldestTimestampMs = oldest;
        cachedActiveLength = length;
        return new ActiveStats(count, validCount, oldest);
    }

    private static void resetActiveStats(File active) {
        cachedActivePath = active.getAbsolutePath();
        cachedActiveRecordCount = -1;
        cachedActiveValidRecordCount = -1;
        cachedOldestTimestampMs = 0L;
        cachedActiveLength = -1L;
    }

    private static BufferedReader reader(File file) throws Exception {
        return new BufferedReader(new InputStreamReader(
                new FileInputStream(file),
                StandardCharsets.UTF_8
        ));
    }

    private static JSONObject parsePoint(String line) {
        if (line == null || line.trim().isEmpty()) return null;
        try {
            JSONObject point = new JSONObject(line);
            String id = point.optString("id", "").trim();
            String tripId = point.optString("tripId", "").trim();
            String timestamp = point.optString("ts", "").trim();
            double latitude = point.optDouble("lat", Double.NaN);
            double longitude = point.optDouble("lng", Double.NaN);
            if (id.isEmpty()
                    || tripId.isEmpty()
                    || timestamp.isEmpty()
                    || !Double.isFinite(latitude)
                    || latitude < -90d
                    || latitude > 90d
                    || !Double.isFinite(longitude)
                    || longitude < -180d
                    || longitude > 180d) return null;
            parseIsoTimestamp(timestamp);
            return point;
        } catch (JSONException | ParseException ignored) {
            return null;
        }
    }

    private static void putNullable(JSONObject target, String key, Number value) throws JSONException {
        target.put(key, value == null ? JSONObject.NULL : value);
    }

    static String toIsoTimestamp(long timestampMs) {
        SimpleDateFormat formatter = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        formatter.setTimeZone(TimeZone.getTimeZone("UTC"));
        return formatter.format(new Date(timestampMs > 0 ? timestampMs : System.currentTimeMillis()));
    }

    private static long parseIsoTimestamp(String value) throws ParseException {
        SimpleDateFormat formatter = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        formatter.setTimeZone(TimeZone.getTimeZone("UTC"));
        formatter.setLenient(false);
        ParsePosition position = new ParsePosition(0);
        Date parsed = formatter.parse(value, position);
        if (parsed == null || position.getIndex() != value.length()) {
            throw new ParseException("Invalid timestamp", Math.max(0, position.getErrorIndex()));
        }
        return parsed.getTime();
    }

    static final class PeekResult {
        final JSONArray points;
        final int remaining;

        PeekResult(JSONArray points, int remaining) {
            this.points = points;
            this.remaining = remaining;
        }
    }

    static final class StorageDiagnostics {
        final long queuedBytes;
        final int segmentCount;
        final long quarantinedBytes;
        final int quarantineSegmentCount;
        final boolean healthy;

        StorageDiagnostics(
                long queuedBytes,
                int segmentCount,
                long quarantinedBytes,
                int quarantineSegmentCount,
                boolean healthy
        ) {
            this.queuedBytes = Math.max(0L, queuedBytes);
            this.segmentCount = Math.max(0, segmentCount);
            this.quarantinedBytes = Math.max(0L, quarantinedBytes);
            this.quarantineSegmentCount = Math.max(0, quarantineSegmentCount);
            this.healthy = healthy;
        }
    }

    private static final class ActiveStats {
        final int recordCount;
        final int validRecordCount;
        final long oldestTimestampMs;

        ActiveStats(int recordCount, int validRecordCount, long oldestTimestampMs) {
            this.recordCount = recordCount;
            this.validRecordCount = validRecordCount;
            this.oldestTimestampMs = oldestTimestampMs;
        }
    }

    private static final class AckMarker {
        final File file;
        final long startOffset;
        final long endOffset;

        AckMarker(File file, long startOffset, long endOffset) {
            this.file = file;
            this.startOffset = startOffset;
            this.endOffset = endOffset;
        }
    }
}
