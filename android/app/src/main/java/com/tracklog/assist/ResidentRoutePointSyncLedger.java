package com.tracklog.assist;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Remembers point ids already given to sync v2, without removing them from the route queue. */
final class ResidentRoutePointSyncLedger {
    static final String FILE_NAME = "resident-route-point-sync.json";

    static final class State {
        final String deviceId;
        final long cursor;
        final LinkedHashSet<String> uploadedIds;
        final LinkedHashMap<String, Long> deferredUntil;

        State(
                String deviceId,
                long cursor,
                LinkedHashSet<String> uploadedIds,
                LinkedHashMap<String, Long> deferredUntil
        ) {
            this.deviceId = deviceId == null ? "" : deviceId;
            this.cursor = Math.max(0L, cursor);
            this.uploadedIds = uploadedIds == null ? new LinkedHashSet<>() : uploadedIds;
            this.deferredUntil = deferredUntil == null ? new LinkedHashMap<>() : deferredUntil;
        }

        static State empty(String deviceId) {
            return new State(deviceId, 0L, new LinkedHashSet<>(), new LinkedHashMap<>());
        }

        Set<String> skipIds(long nowMs) {
            LinkedHashSet<String> skip = new LinkedHashSet<>(uploadedIds);
            for (Map.Entry<String, Long> entry : deferredUntil.entrySet()) {
                if (entry.getValue() != null && entry.getValue() > nowMs) skip.add(entry.getKey());
            }
            return skip;
        }

        State withCursor(long nextCursor) {
            return new State(
                    deviceId,
                    nextCursor,
                    new LinkedHashSet<>(uploadedIds),
                    new LinkedHashMap<>(deferredUntil)
            );
        }

        State apply(long nextCursor, Collection<String> storedIds, Map<String, Long> deferUntil) {
            LinkedHashSet<String> uploaded = new LinkedHashSet<>(uploadedIds);
            LinkedHashMap<String, Long> deferred = new LinkedHashMap<>(deferredUntil);
            long nowFloor = 0L;
            if (storedIds != null) {
                for (String id : storedIds) {
                    if (id == null || id.trim().isEmpty()) continue;
                    String normalized = id.trim();
                    uploaded.add(normalized);
                    deferred.remove(normalized);
                }
            }
            if (deferUntil != null) {
                for (Map.Entry<String, Long> entry : deferUntil.entrySet()) {
                    if (entry.getKey() == null || entry.getKey().trim().isEmpty()) continue;
                    String normalized = entry.getKey().trim();
                    if (uploaded.contains(normalized)) continue;
                    long until = entry.getValue() == null ? 0L : entry.getValue();
                    if (until > nowFloor) deferred.put(normalized, until);
                }
            }
            trim(uploaded, deferred);
            long cursorValue = Math.max(this.cursor, Math.max(0L, nextCursor));
            return new State(deviceId, cursorValue, uploaded, deferred);
        }

        private static void trim(LinkedHashSet<String> uploaded, LinkedHashMap<String, Long> deferred) {
            while (uploaded.size() > ResidentRoutePointSyncPolicy.MAX_TRACKED_IDS) {
                String oldest = uploaded.iterator().next();
                uploaded.remove(oldest);
            }
            while (deferred.size() > 2_000) {
                String oldest = deferred.keySet().iterator().next();
                deferred.remove(oldest);
            }
        }
    }

    private ResidentRoutePointSyncLedger() {}

    static State load(File file, String deviceId) {
        String expectedDevice = deviceId == null ? "" : deviceId.trim();
        if (file == null || !file.isFile()) return State.empty(expectedDevice);
        try {
            String text = readText(file);
            JSONObject root = new JSONObject(text);
            if (!expectedDevice.equals(root.optString("deviceId", "").trim())) {
                return State.empty(expectedDevice);
            }
            long cursor = root.optLong("cursor", 0L);
            LinkedHashSet<String> uploaded = new LinkedHashSet<>();
            JSONArray stored = root.optJSONArray("uploaded");
            if (stored != null) {
                for (int index = 0; index < stored.length(); index += 1) {
                    String id = stored.optString(index, "").trim();
                    if (!id.isEmpty()) uploaded.add(id);
                }
            }
            LinkedHashMap<String, Long> deferred = new LinkedHashMap<>();
            JSONObject deferredJson = root.optJSONObject("deferred");
            if (deferredJson != null) {
                JSONArray names = deferredJson.names();
                if (names != null) {
                    for (int index = 0; index < names.length(); index += 1) {
                        String id = names.optString(index, "").trim();
                        if (id.isEmpty()) continue;
                        long until = deferredJson.optLong(id, 0L);
                        if (until > 0L) deferred.put(id, until);
                    }
                }
            }
            State.trim(uploaded, deferred);
            return new State(expectedDevice, cursor, uploaded, deferred);
        } catch (Exception ignored) {
            return State.empty(expectedDevice);
        }
    }

    static boolean save(File file, State state) {
        if (file == null || state == null) return false;
        File directory = file.getParentFile();
        if (directory != null && !directory.exists() && !directory.mkdirs()) return false;
        File temporary = new File(file.getParentFile(), file.getName() + ".tmp");
        try {
            JSONObject root = new JSONObject();
            root.put("deviceId", state.deviceId);
            root.put("cursor", state.cursor);
            JSONArray uploaded = new JSONArray();
            for (String id : state.uploadedIds) uploaded.put(id);
            root.put("uploaded", uploaded);
            JSONObject deferred = new JSONObject();
            for (Map.Entry<String, Long> entry : state.deferredUntil.entrySet()) {
                deferred.put(entry.getKey(), entry.getValue());
            }
            root.put("deferred", deferred);
            byte[] bytes = root.toString().getBytes(StandardCharsets.UTF_8);
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(bytes);
                output.flush();
            }
            if (file.exists() && !file.delete()) return false;
            return temporary.renameTo(file);
        } catch (Exception ignored) {
            if (temporary.exists()) temporary.delete();
            return false;
        }
    }

    private static String readText(File file) throws Exception {
        StringBuilder text = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                new FileInputStream(file),
                StandardCharsets.UTF_8
        ))) {
            char[] buffer = new char[2048];
            int read;
            while ((read = reader.read(buffer)) >= 0) text.append(buffer, 0, read);
        }
        return text.toString();
    }

    static List<String> ids(Collection<String> values) {
        List<String> ids = new ArrayList<>();
        if (values == null) return ids;
        for (String value : values) {
            if (value != null && !value.trim().isEmpty()) ids.add(value.trim());
        }
        return ids;
    }
}
