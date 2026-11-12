package com.tracklog.assist;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Pure decisions for uploading queued route points through the existing sync v2
 * function. The native service keeps the queue until the WebView drains it into
 * Dexie; this policy only decides which points are safe to send and which acks
 * mean the cloud already has that point id.
 */
final class ResidentRoutePointSyncPolicy {
    static final int MAX_MUTATIONS_PER_REQUEST = 80;
    static final int MAX_BATCHES_PER_CYCLE = 3;
    static final long INTERVAL_MS = 30_000L;
    static final long RETRY_DELAY_MS = 15_000L;
    static final long FIRST_DELAY_MS = 5_000L;
    static final long MISSING_PARENT_DEFER_MS = 60_000L;
    static final long REJECTED_DEFER_MS = 5L * 60L * 1000L;
    static final long INVALID_DEFER_MS = 15L * 60L * 1000L;
    static final int MAX_TRACKED_IDS = 12_000;
    static final int SYNC_RESPONSE_CHAR_LIMIT = 1024 * 1024;
    static final int SYNC_READ_TIMEOUT_MS = 30_000;

    private static final String UUID_PATTERN =
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
    private static final String TIMESTAMP_PATTERN =
            "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$";

    enum Disposition {
        /** Cloud accepted this point id, or already had this same mutation. */
        STORE,
        /** Leave the point queued and try again after the returned delay. */
        DEFER,
        /** This response did not confirm the point. Keep it for the next attempt. */
        RETRY
    }

    static final class Ack {
        final String entityId;
        final String status;
        final String code;
        final String message;

        Ack(String entityId, String status, String code, String message) {
            this.entityId = entityId == null ? "" : entityId.trim();
            this.status = status == null ? "" : status.trim();
            this.code = code == null ? "" : code.trim();
            this.message = message == null ? "" : message.trim();
        }
    }

    static final class Page {
        final long cursor;
        final boolean hasMore;
        final List<Ack> acks;

        Page(long cursor, boolean hasMore, List<Ack> acks) {
            this.cursor = Math.max(0L, cursor);
            this.hasMore = hasMore;
            this.acks = acks == null ? Collections.emptyList() : acks;
        }
    }

    private ResidentRoutePointSyncPolicy() {}

    static long delayUntilNextAttempt(long nowMs, long lastAttemptAtMs) {
        if (lastAttemptAtMs <= 0L) return FIRST_DELAY_MS;
        long elapsed = nowMs - lastAttemptAtMs;
        if (elapsed >= INTERVAL_MS) return 0L;
        return INTERVAL_MS - Math.max(0L, elapsed);
    }

    static boolean isSyncMutationId(String pointId) {
        return pointId != null && pointId.trim().matches(UUID_PATTERN);
    }

    /**
     * One routePoint upsert. The mutation id is the point id, so a later WebView
     * push of the same row is a receipt duplicate instead of a second insert.
     * Returns null when the row would be rejected or would abort the whole RPC.
     */
    static JSONObject mutationFor(JSONObject point) {
        if (point == null) return null;
        String id = point.optString("id", "").trim();
        String tripId = point.optString("tripId", "").trim();
        String timestamp = point.optString("ts", "").trim();
        if (!isSyncMutationId(id) || !isSendableTripId(tripId) || !timestamp.matches(TIMESTAMP_PATTERN)) {
            return null;
        }
        double latitude = point.optDouble("lat", Double.NaN);
        double longitude = point.optDouble("lng", Double.NaN);
        if (!Double.isFinite(latitude) || latitude < -90d || latitude > 90d
                || !Double.isFinite(longitude) || longitude < -180d || longitude > 180d) {
            return null;
        }
        try {
            JSONObject payload = new JSONObject();
            payload.put("trip_id", tripId);
            payload.put("ts", timestamp);
            payload.put("lat", latitude);
            payload.put("lng", longitude);
            Double accuracy = optionalRange(point, "accuracy", 0d, 100_000d);
            Double speed = optionalRange(point, "speed", 0d, 500d);
            Double heading = optionalRange(point, "heading", 0d, 360d);
            if (accuracy != null) payload.put("accuracy", accuracy);
            if (speed != null) payload.put("speed", speed);
            if (heading != null) payload.put("heading", heading);
            payload.put("source", routeSource(point.optString("source", "")));
            return new JSONObject()
                    .put("mutationId", id)
                    .put("entityType", "routePoint")
                    .put("entityId", id)
                    .put("operation", "upsert")
                    .put("payload", payload);
        } catch (Exception ignored) {
            return null;
        }
    }

    static Disposition classifyAck(String status, String code, String message) {
        String normalizedStatus = status == null ? "" : status.trim().toLowerCase(Locale.US);
        String normalizedCode = code == null ? "" : code.trim();
        String normalizedMessage = message == null ? "" : message.trim();
        if ("applied".equals(normalizedStatus) || "duplicate".equals(normalizedStatus)) {
            return Disposition.STORE;
        }
        if ("deleted".equals(normalizedStatus)) {
            // The trip is gone. Retrying cannot insert the point, and the WebView
            // still owns the queue copy.
            return Disposition.STORE;
        }
        if ("rejected".equals(normalizedStatus)) return Disposition.DEFER;
        if (!"conflict".equals(normalizedStatus)) return Disposition.RETRY;
        if ("revision_conflict".equals(normalizedCode)
                || "A newer cloud revision already exists".equals(normalizedMessage)) {
            // The same point id is already stored. Do not update it from here.
            return Disposition.STORE;
        }
        return Disposition.DEFER;
    }

    static long deferMillis(Disposition disposition, String code, String message) {
        if (disposition != Disposition.DEFER) return 0L;
        String normalizedCode = code == null ? "" : code.trim();
        String normalizedMessage = message == null ? "" : message.trim();
        if ("missing_parent".equals(normalizedCode)
                || normalizedMessage.contains("Trip header is missing")) {
            return MISSING_PARENT_DEFER_MS;
        }
        return REJECTED_DEFER_MS;
    }

    static boolean isCursorAhead(int statusCode, String body) {
        if (statusCode != 400 || body == null) return false;
        return body.toLowerCase(Locale.US).contains("cursor is ahead");
    }

    /**
     * Builds a small sync envelope from a prefix of the HTTP body. Postgres jsonb
     * emits shorter keys first, so {@code acks} and {@code cursor} precede the
     * potentially large {@code changes} feed. Callers can stop reading once this
     * returns non-null. Returns null until both fields are complete.
     */
    static String compactSyncPage(String buffer) {
        if (buffer == null || buffer.isEmpty()) return null;
        int acksKey = indexOfJsonKey(buffer, "acks");
        int cursorKey = indexOfJsonKey(buffer, "cursor");
        if (acksKey < 0 || cursorKey < 0) return null;
        int arrayStart = buffer.indexOf('[', acksKey + "acks".length());
        if (arrayStart < 0) return null;
        int arrayEnd = endOfJsonArray(buffer, arrayStart);
        if (arrayEnd < 0) return null;
        Long cursor = readJsonLongAfterKey(buffer, cursorKey);
        if (cursor == null || cursor < 0L) return null;
        int hasMoreKey = indexOfJsonKey(buffer, "hasMore");
        Boolean hasMore = hasMoreKey < 0 ? null : readJsonBooleanAfterKey(buffer, hasMoreKey);
        String acks = buffer.substring(arrayStart, arrayEnd + 1);
        boolean more = hasMore == null || hasMore;
        return "{\"ok\":true,\"data\":{\"protocolVersion\":2,\"cursor\":" + cursor
                + ",\"hasMore\":" + more
                + ",\"acks\":" + acks
                + "}}";
    }

    static Page parseCompactPage(String compactJson) {
        if (compactJson == null || compactJson.isEmpty()) return null;
        try {
            JSONObject root = new JSONObject(compactJson);
            if (!root.optBoolean("ok", false)) return null;
            JSONObject data = root.optJSONObject("data");
            if (data == null || data.optInt("protocolVersion", 0) != 2) return null;
            long cursor = data.optLong("cursor", -1L);
            if (cursor < 0L) return null;
            JSONArray rawAcks = data.optJSONArray("acks");
            if (rawAcks == null) return null;
            List<Ack> acks = new ArrayList<>();
            for (int index = 0; index < rawAcks.length(); index += 1) {
                JSONObject ack = rawAcks.optJSONObject(index);
                if (ack == null) continue;
                String entityId = ack.optString("entityId", "").trim();
                if (entityId.isEmpty()) entityId = ack.optString("mutationId", "").trim();
                acks.add(new Ack(
                        entityId,
                        ack.optString("status", ""),
                        ack.optString("code", ""),
                        ack.optString("message", "")
                ));
            }
            return new Page(cursor, data.optBoolean("hasMore", true), acks);
        } catch (Exception ignored) {
            return null;
        }
    }

    static Map<String, Long> deferrals(List<Ack> acks, long nowMs) {
        Map<String, Long> deferred = new LinkedHashMap<>();
        if (acks == null) return deferred;
        for (Ack ack : acks) {
            if (ack.entityId.isEmpty()) continue;
            Disposition disposition = classifyAck(ack.status, ack.code, ack.message);
            if (disposition != Disposition.DEFER) continue;
            long delay = deferMillis(disposition, ack.code, ack.message);
            long until = nowMs > Long.MAX_VALUE - delay ? Long.MAX_VALUE : nowMs + delay;
            deferred.put(ack.entityId, until);
        }
        return deferred;
    }

    static List<String> storedIds(List<Ack> acks) {
        List<String> ids = new ArrayList<>();
        if (acks == null) return ids;
        for (Ack ack : acks) {
            if (ack.entityId.isEmpty()) continue;
            if (classifyAck(ack.status, ack.code, ack.message) == Disposition.STORE) {
                ids.add(ack.entityId);
            }
        }
        return ids;
    }

    private static boolean isSendableTripId(String tripId) {
        if (tripId.isEmpty() || tripId.length() > 180) return false;
        for (int index = 0; index < tripId.length(); index += 1) {
            if (Character.isISOControl(tripId.charAt(index))) return false;
        }
        return true;
    }

    private static String routeSource(String source) {
        if ("foreground".equals(source) || "event".equals(source) || "background".equals(source)) {
            return source;
        }
        return "background";
    }

    private static Double optionalRange(JSONObject point, String key, double minimum, double maximum) {
        if (!point.has(key) || point.isNull(key)) return null;
        double value = point.optDouble(key, Double.NaN);
        if (!Double.isFinite(value) || value < minimum || value > maximum) return null;
        return value;
    }

    static int indexOfJsonKey(String value, String key) {
        String needle = "\"" + key + "\"";
        boolean inString = false;
        boolean escape = false;
        int depth = 0;
        for (int index = 0; index < value.length(); index += 1) {
            char current = value.charAt(index);
            if (inString) {
                if (escape) {
                    escape = false;
                    continue;
                }
                if (current == '\\') {
                    escape = true;
                    continue;
                }
                if (current == '"') inString = false;
                continue;
            }
            if (current == '"') {
                // Sync fields live on the data object. Nested report payloads must not match.
                if (depth == 2
                        && index + needle.length() <= value.length()
                        && value.startsWith(needle, index)) {
                    int cursor = index + needle.length();
                    while (cursor < value.length() && Character.isWhitespace(value.charAt(cursor))) {
                        cursor += 1;
                    }
                    if (cursor < value.length() && value.charAt(cursor) == ':') return index;
                }
                inString = true;
                continue;
            }
            if (current == '{' || current == '[') depth += 1;
            else if ((current == '}' || current == ']') && depth > 0) depth -= 1;
        }
        return -1;
    }

    static int endOfJsonArray(String value, int openBracket) {
        int depth = 0;
        boolean inString = false;
        boolean escape = false;
        for (int index = openBracket; index < value.length(); index += 1) {
            char current = value.charAt(index);
            if (inString) {
                if (escape) {
                    escape = false;
                    continue;
                }
                if (current == '\\') {
                    escape = true;
                    continue;
                }
                if (current == '"') inString = false;
                continue;
            }
            if (current == '"') {
                inString = true;
                continue;
            }
            if (current == '[') depth += 1;
            else if (current == ']') {
                depth -= 1;
                if (depth == 0) return index;
            }
        }
        return -1;
    }

    private static Long readJsonLongAfterKey(String value, int keyIndex) {
        int colon = value.indexOf(':', keyIndex);
        if (colon < 0) return null;
        int index = colon + 1;
        while (index < value.length() && Character.isWhitespace(value.charAt(index))) index += 1;
        int end = index;
        if (end < value.length() && value.charAt(end) == '-') return null;
        while (end < value.length() && Character.isDigit(value.charAt(end))) end += 1;
        if (end == index) return null;
        try {
            return Long.parseLong(value.substring(index, end));
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static Boolean readJsonBooleanAfterKey(String value, int keyIndex) {
        int colon = value.indexOf(':', keyIndex);
        if (colon < 0) return null;
        int index = colon + 1;
        while (index < value.length() && Character.isWhitespace(value.charAt(index))) index += 1;
        if (value.startsWith("true", index)) return Boolean.TRUE;
        if (value.startsWith("false", index)) return Boolean.FALSE;
        return null;
    }
}
