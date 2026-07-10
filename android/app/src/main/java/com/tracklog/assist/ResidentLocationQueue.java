package com.tracklog.assist;

import android.content.Context;
import android.location.Location;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;
import java.util.UUID;

final class ResidentLocationQueue {
    private static final String QUEUE_FILE_NAME = "resident-location-points.jsonl";
    private static final String TEMP_FILE_NAME = "resident-location-points.jsonl.tmp";
    private static final Object FILE_LOCK = new Object();

    private ResidentLocationQueue() {}

    static void append(Context context, String tripId, Location location) throws Exception {
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

        synchronized (FILE_LOCK) {
            File queue = queueFile(context);
            try (FileOutputStream output = new FileOutputStream(queue, true);
                 OutputStreamWriter streamWriter = new OutputStreamWriter(output, StandardCharsets.UTF_8);
                 BufferedWriter writer = new BufferedWriter(streamWriter)) {
                writer.write(point.toString());
                writer.newLine();
                writer.flush();
                output.getFD().sync();
            }
        }
    }

    static PeekResult peek(Context context, int requestedLimit) throws Exception {
        int limit = Math.max(1, Math.min(requestedLimit, 5000));
        synchronized (FILE_LOCK) {
            File queue = queueFile(context);
            if (!queue.exists() || queue.length() == 0) {
                return new PeekResult(new JSONArray(), 0);
            }

            List<String> validLines = new ArrayList<>();
            JSONArray points = new JSONArray();
            boolean removedMalformed = false;
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                    new FileInputStream(queue), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.trim().isEmpty()) continue;
                    try {
                        JSONObject point = new JSONObject(line);
                        if (point.optString("id", "").trim().isEmpty()) {
                            removedMalformed = true;
                            continue;
                        }
                        validLines.add(line);
                        if (points.length() < limit) points.put(point);
                    } catch (JSONException ignored) {
                        removedMalformed = true;
                    }
                }
            }

            if (removedMalformed) replaceQueueAtomically(context, queue, validLines);
            return new PeekResult(points, Math.max(0, validLines.size() - points.length()));
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
        if (ids.isEmpty()) return count(context);

        synchronized (FILE_LOCK) {
            File queue = queueFile(context);
            if (!queue.exists() || queue.length() == 0) return 0;
            List<String> remainder = new ArrayList<>();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                    new FileInputStream(queue), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.trim().isEmpty()) continue;
                    try {
                        JSONObject point = new JSONObject(line);
                        String id = point.optString("id", "").trim();
                        if (!id.isEmpty() && !ids.contains(id)) remainder.add(line);
                    } catch (JSONException ignored) {
                        // Invalid records cannot be persisted and must not block later valid points.
                    }
                }
            }
            replaceQueueAtomically(context, queue, remainder);
            return remainder.size();
        }
    }

    static int count(Context context) {
        synchronized (FILE_LOCK) {
            File queue = queueFile(context);
            if (!queue.exists()) return 0;
            int count = 0;
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                    new FileInputStream(queue), StandardCharsets.UTF_8))) {
                while (reader.readLine() != null) count += 1;
            } catch (Exception ignored) {
                return 0;
            }
            return count;
        }
    }

    private static void replaceQueueAtomically(Context context, File queue, List<String> remainder) throws Exception {
        File temp = new File(context.getFilesDir(), TEMP_FILE_NAME);
        try (FileOutputStream output = new FileOutputStream(temp, false);
             OutputStreamWriter streamWriter = new OutputStreamWriter(output, StandardCharsets.UTF_8);
             BufferedWriter writer = new BufferedWriter(streamWriter)) {
            for (String line : remainder) {
                writer.write(line);
                writer.newLine();
            }
            writer.flush();
            output.getFD().sync();
        }

        if (!temp.renameTo(queue)) {
            throw new IllegalStateException("位置情報キューを更新できませんでした。");
        }
    }

    private static File queueFile(Context context) {
        return new File(context.getFilesDir(), QUEUE_FILE_NAME);
    }

    private static void putNullable(JSONObject target, String key, Number value) throws JSONException {
        target.put(key, value == null ? JSONObject.NULL : value);
    }

    static String toIsoTimestamp(long timestampMs) {
        SimpleDateFormat formatter = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        formatter.setTimeZone(TimeZone.getTimeZone("UTC"));
        return formatter.format(new Date(timestampMs > 0 ? timestampMs : System.currentTimeMillis()));
    }

    static final class PeekResult {
        final JSONArray points;
        final int remaining;

        PeekResult(JSONArray points, int remaining) {
            this.points = points;
            this.remaining = remaining;
        }
    }
}
