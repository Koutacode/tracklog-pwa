package com.tracklog.assist;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSArray;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Durable native expressway state and at-least-once WebView handoff queue.
 *
 * The full snapshot is written through one SharedPreferences commit. No event is silently evicted;
 * once the bounded queue is full, new transitions fail closed and diagnostics report the failure.
 */
final class ResidentExpresswayStore {
    static final String PREFERENCES_NAME = "tracklog_resident_expressway";
    static final String KEY_STATE_JSON = "state_json";
    static final int MAX_EVENT_COUNT = 128;
    static final int MAX_PEEK_LIMIT = 1_000;
    static final long PROBE_RETRY_BASE_MS = 30_000L;
    static final long PROBE_RETRY_MAX_MS = 15L * 60L * 1000L;
    private static final int STATE_VERSION = 1;
    private static final Object LOCK = new Object();
    private static volatile boolean processStorageHealthy = true;

    enum ProbeKind {
        START("start"),
        END("end");

        final String wireName;

        ProbeKind(String wireName) {
            this.wireName = wireName;
        }

        static ProbeKind fromWireName(String value) {
            return "end".equals(value) ? END : START;
        }
    }

    enum EventKind {
        START("start"),
        END_PROMPT("end_prompt"),
        DECISION_END("decision_end"),
        DECISION_KEEP("decision_keep");

        final String wireName;

        EventKind(String wireName) {
            this.wireName = wireName;
        }

        static EventKind fromWireName(String value) throws JSONException {
            for (EventKind kind : values()) {
                if (kind.wireName.equals(value)) return kind;
            }
            throw new JSONException("Unsupported native expressway event kind");
        }
    }

    static final class Probe {
        final String id;
        final ProbeKind kind;
        final String tripId;
        final long expectedRevision;
        final String detectedAt;
        final long detectedAtMs;
        final double latitude;
        final double longitude;
        final Double accuracyM;
        final double speedKmh;
        final Double accelerationMs2;
        final long lowSpeedElapsedMs;
        final String monotonicSessionId;
        final long elapsedRealtimeMs;
        final ResidentExpresswayDetectionPolicy.Config config;
        final int attemptCount;
        final long retryAfterAtMs;
        final String lastFailureCategory;
        final long failureUpdatedAtMs;

        Probe(
                String id,
                ProbeKind kind,
                String tripId,
                long expectedRevision,
                String detectedAt,
                long detectedAtMs,
                double latitude,
                double longitude,
                Double accuracyM,
                double speedKmh,
                Double accelerationMs2,
                long lowSpeedElapsedMs,
                String monotonicSessionId,
                long elapsedRealtimeMs,
                ResidentExpresswayDetectionPolicy.Config config,
                int attemptCount,
                long retryAfterAtMs,
                String lastFailureCategory,
                long failureUpdatedAtMs
        ) {
            this.id = id;
            this.kind = kind;
            this.tripId = tripId;
            this.expectedRevision = expectedRevision;
            this.detectedAt = detectedAt;
            this.detectedAtMs = detectedAtMs;
            this.latitude = latitude;
            this.longitude = longitude;
            this.accuracyM = accuracyM;
            this.speedKmh = speedKmh;
            this.accelerationMs2 = accelerationMs2;
            this.lowSpeedElapsedMs = Math.max(0L, lowSpeedElapsedMs);
            this.monotonicSessionId = monotonicSessionId;
            this.elapsedRealtimeMs = elapsedRealtimeMs;
            this.config = config;
            this.attemptCount = Math.max(0, attemptCount);
            this.retryAfterAtMs = Math.max(0L, retryAfterAtMs);
            this.lastFailureCategory = normalizeFailureCategory(lastFailureCategory);
            this.failureUpdatedAtMs = Math.max(0L, failureUpdatedAtMs);
        }

        Probe withFailure(String category, long nowMs) {
            int nextCount = Math.min(30, attemptCount + 1);
            long delay = probeRetryDelayMs(nextCount);
            long retryAfter = nowMs > Long.MAX_VALUE - delay ? Long.MAX_VALUE : nowMs + delay;
            return new Probe(
                    id,
                    kind,
                    tripId,
                    expectedRevision,
                    detectedAt,
                    detectedAtMs,
                    latitude,
                    longitude,
                    accuracyM,
                    speedKmh,
                    accelerationMs2,
                    lowSpeedElapsedMs,
                    monotonicSessionId,
                    elapsedRealtimeMs,
                    config,
                    nextCount,
                    retryAfter,
                    category,
                    nowMs
            );
        }
    }

    static final class SignalDetails {
        final ResidentExpresswayDetectionPolicy.Signal policySignal;
        final String nearestIcName;
        final Double nearestIcDistanceM;

        SignalDetails(
                boolean resolved,
                boolean onExpresswayRoad,
                boolean nearIc,
                boolean nearEtcGate,
                String nearestIcName,
                Double nearestIcDistanceM
        ) {
            policySignal = new ResidentExpresswayDetectionPolicy.Signal(
                    resolved,
                    onExpresswayRoad,
                    nearIc,
                    nearEtcGate
            );
            this.nearestIcName = normalizeText(nearestIcName, 200);
            this.nearestIcDistanceM = nearestIcDistanceM != null
                    && Double.isFinite(nearestIcDistanceM)
                    && nearestIcDistanceM >= 0d
                    ? nearestIcDistanceM
                    : null;
        }
    }

    static final class Event {
        final String id;
        final String tripId;
        final EventKind kind;
        final long generation;
        final String detectedAt;
        final String decidedAt;
        final String promptId;
        final double latitude;
        final double longitude;
        final Double accuracyM;
        final double speedKmh;
        final String monotonicSessionId;
        final long elapsedRealtimeMs;
        final JSONObject reason;

        Event(
                String id,
                String tripId,
                EventKind kind,
                long generation,
                String detectedAt,
                String decidedAt,
                String promptId,
                double latitude,
                double longitude,
                Double accuracyM,
                double speedKmh,
                String monotonicSessionId,
                long elapsedRealtimeMs,
                JSONObject reason
        ) {
            this.id = id;
            this.tripId = tripId;
            this.kind = kind;
            this.generation = Math.max(0L, generation);
            this.detectedAt = detectedAt;
            this.decidedAt = decidedAt;
            this.promptId = promptId;
            this.latitude = latitude;
            this.longitude = longitude;
            this.accuracyM = accuracyM;
            this.speedKmh = speedKmh;
            this.monotonicSessionId = monotonicSessionId;
            this.elapsedRealtimeMs = elapsedRealtimeMs;
            this.reason = reason;
        }

        JSONObject toJson() throws JSONException {
            JSONObject geo = new JSONObject()
                    .put("lat", latitude)
                    .put("lon", longitude);
            if (accuracyM != null) geo.put("accuracy", accuracyM);
            JSONObject json = new JSONObject()
                    .put("id", id)
                    .put("tripId", tripId)
                    .put("kind", kind.wireName)
                    .put("generation", generation)
                    .put("detectedAt", detectedAt)
                    .put("geo", geo)
                    .put("speedKmh", speedKmh)
                    .put("reason", reason);
            if (!decidedAt.isEmpty()) json.put("decidedAt", decidedAt);
            if (!promptId.isEmpty()) json.put("promptId", promptId);
            if (!monotonicSessionId.isEmpty()) {
                json.put("monotonicSessionId", monotonicSessionId);
            }
            if (elapsedRealtimeMs >= 0L) json.put("elapsedRealtimeMs", elapsedRealtimeMs);
            return json;
        }

        static Event fromJson(JSONObject json) throws JSONException {
            JSONObject geo = json.getJSONObject("geo");
            Double accuracy = geo.has("accuracy") && !geo.isNull("accuracy")
                    ? geo.getDouble("accuracy")
                    : null;
            JSONObject reason = json.optJSONObject("reason");
            if (reason == null) reason = new JSONObject();
            return new Event(
                    requiredText(json, "id", 200),
                    requiredText(json, "tripId", 200),
                    EventKind.fromWireName(requiredText(json, "kind", 40)),
                    Math.max(0L, json.optLong("generation", 0L)),
                    requiredText(json, "detectedAt", 100),
                    normalizeText(json.optString("decidedAt", ""), 100),
                    normalizeText(json.optString("promptId", ""), 200),
                    geo.getDouble("lat"),
                    geo.getDouble("lon"),
                    accuracy,
                    json.optDouble("speedKmh", 0d),
                    normalizeText(json.optString("monotonicSessionId", ""), 200),
                    json.has("elapsedRealtimeMs") ? json.optLong("elapsedRealtimeMs", -1L) : -1L,
                    reason
            );
        }
    }

    static final class Snapshot {
        final String tripId;
        final long revision;
        final boolean open;
        final boolean paused;
        final boolean keepSuppressed;
        final String promptId;
        final List<Event> events;
        /**
         * Durable prompt payload retained independently from the handoff queue.
         * The WebView acknowledges the END_PROMPT event as soon as it has
         * materialized the dialog, while the driver's decision can happen much
         * later or after a process restart. Keeping the payload here prevents
         * that acknowledgement from making the native prompt unresolvable.
         */
        final Event pendingPrompt;
        final Probe pendingProbe;
        final ResidentExpresswayDetectionPolicy.Config config;
        final boolean storageHealthy;

        Snapshot(
                String tripId,
                long revision,
                boolean open,
                boolean paused,
                boolean keepSuppressed,
                String promptId,
                List<Event> events,
                Event pendingPrompt,
                Probe pendingProbe,
                ResidentExpresswayDetectionPolicy.Config config,
                boolean storageHealthy
        ) {
            this.tripId = tripId;
            this.revision = Math.max(0L, revision);
            this.open = open;
            this.paused = paused;
            this.keepSuppressed = keepSuppressed;
            this.promptId = promptId;
            this.events = events;
            this.pendingPrompt = pendingPrompt;
            this.pendingProbe = pendingProbe;
            this.config = config;
            this.storageHealthy = storageHealthy;
        }

        Snapshot copy(
                String nextTripId,
                long nextRevision,
                boolean nextOpen,
                boolean nextPaused,
                boolean nextKeepSuppressed,
                String nextPromptId,
                List<Event> nextEvents,
                Probe nextProbe,
                ResidentExpresswayDetectionPolicy.Config nextConfig
        ) {
            Event nextPendingPrompt = null;
            if (nextPromptId != null && !nextPromptId.isEmpty()) {
                if (pendingPrompt != null && nextPromptId.equals(pendingPrompt.id)) {
                    nextPendingPrompt = pendingPrompt;
                } else {
                    Event queuedPrompt = findEvent(nextEvents, nextPromptId);
                    if (queuedPrompt != null && queuedPrompt.kind == EventKind.END_PROMPT) {
                        nextPendingPrompt = queuedPrompt;
                    }
                }
            }
            return new Snapshot(
                    nextTripId,
                    nextRevision,
                    nextOpen,
                    nextPaused,
                    nextKeepSuppressed,
                    nextPromptId,
                    nextEvents,
                    nextPendingPrompt,
                    nextProbe,
                    nextConfig,
                    storageHealthy
            );
        }
    }

    static final class DecisionResult {
        final boolean stored;
        final String eventId;
        final long generation;

        DecisionResult(boolean stored, String eventId, long generation) {
            this.stored = stored;
            this.eventId = eventId;
            this.generation = Math.max(0L, generation);
        }
    }

    private ResidentExpresswayStore() {}

    static Snapshot snapshot(Context context) {
        synchronized (LOCK) {
            return read(context);
        }
    }

    static boolean reconcile(
            Context context,
            String activeTripId,
            boolean webExpresswayOpen,
            ResidentExpresswayDetectionPolicy.Config config
    ) {
        synchronized (LOCK) {
            Snapshot current = read(context);
            if (!current.storageHealthy) return false;
            String normalizedTripId = normalizeText(activeTripId, 200);
            Snapshot next = current;
            if (normalizedTripId.isEmpty()) {
                if (!current.paused || current.pendingProbe != null) {
                    next = current.copy(
                            current.tripId,
                            incrementRevision(current.revision),
                            current.open,
                            true,
                            current.keepSuppressed,
                            current.promptId,
                            current.events,
                            null,
                            config
                    );
                } else if (!sameConfig(current.config, config)) {
                    next = current.copy(
                            current.tripId,
                            current.revision,
                            current.open,
                            true,
                            current.keepSuppressed,
                            current.promptId,
                            current.events,
                            null,
                            config
                    );
                }
            } else if (!normalizedTripId.equals(current.tripId)) {
                next = current.copy(
                        normalizedTripId,
                        incrementRevision(current.revision),
                        webExpresswayOpen,
                        false,
                        false,
                        "",
                        current.events,
                        null,
                        config
                );
            } else {
                boolean nativeTransitionPending = hasUnacknowledgedTransition(
                        current.events,
                        normalizedTripId
                );
                boolean nextOpen = nativeTransitionPending ? current.open : webExpresswayOpen;
                boolean nextKeep = nextOpen && current.keepSuppressed;
                String nextPrompt = nextOpen ? current.promptId : "";
                boolean invalidatesProbe = current.paused
                        || nextOpen != current.open
                        || !sameConfig(current.config, config);
                next = current.copy(
                        current.tripId,
                        invalidatesProbe ? incrementRevision(current.revision) : current.revision,
                        nextOpen,
                        false,
                        nextKeep,
                        nextPrompt,
                        current.events,
                        invalidatesProbe ? null : current.pendingProbe,
                        config
                );
            }
            return sameSnapshot(current, next) || write(context, next);
        }
    }

    static boolean deactivate(Context context) {
        synchronized (LOCK) {
            Snapshot current = read(context);
            if (!current.storageHealthy) return false;
            Snapshot next = current.copy(
                    "",
                    incrementRevision(current.revision),
                    false,
                    true,
                    false,
                    "",
                    current.events,
                    null,
                    current.config
            );
            return write(context, next);
        }
    }

    static boolean clearPrivateData(Context context) {
        synchronized (LOCK) {
            boolean cleared = preferences(context).edit().clear().commit();
            processStorageHealthy = cleared;
            return cleared;
        }
    }

    static Probe createProbe(
            Context context,
            ProbeKind kind,
            String tripId,
            String detectedAt,
            long detectedAtMs,
            double latitude,
            double longitude,
            Double accuracyM,
            double speedKmh,
            Double accelerationMs2,
            long lowSpeedElapsedMs,
            String monotonicSessionId,
            long elapsedRealtimeMs
    ) {
        synchronized (LOCK) {
            Snapshot current = read(context);
            String normalizedTripId = normalizeText(tripId, 200);
            if (!current.storageHealthy
                    || normalizedTripId.isEmpty()
                    || !normalizedTripId.equals(current.tripId)
                    || current.paused
                    || current.pendingProbe != null
                    || (kind == ProbeKind.START && current.open)
                    || (kind == ProbeKind.END && (!current.open || !current.promptId.isEmpty()))) {
                return null;
            }
            Probe probe = new Probe(
                    UUID.randomUUID().toString(),
                    kind,
                    current.tripId,
                    current.revision,
                    normalizeText(detectedAt, 100),
                    Math.max(0L, detectedAtMs),
                    latitude,
                    longitude,
                    accuracyM,
                    speedKmh,
                    accelerationMs2,
                    lowSpeedElapsedMs,
                    normalizeText(monotonicSessionId, 200),
                    elapsedRealtimeMs,
                    current.config,
                    0,
                    0L,
                    "",
                    0L
            );
            Snapshot next = current.copy(
                    current.tripId,
                    current.revision,
                    current.open,
                    current.paused,
                    current.keepSuppressed,
                    current.promptId,
                    current.events,
                    probe,
                    current.config
            );
            return write(context, next) ? probe : null;
        }
    }

    static Probe dueProbe(Context context, long nowMs) {
        synchronized (LOCK) {
            Snapshot current = read(context);
            Probe probe = current.pendingProbe;
            if (!current.storageHealthy
                    || probe == null
                    || current.paused
                    || !canApplyProbe(
                            probe.tripId,
                            probe.expectedRevision,
                            current.tripId,
                            current.revision
                    )
                    || !isProbeRetryDue(nowMs, probe.retryAfterAtMs)) {
                return null;
            }
            return probe;
        }
    }

    static boolean markProbeFailure(Context context, String probeId, String category, long nowMs) {
        synchronized (LOCK) {
            Snapshot current = read(context);
            if (!matchesCurrentProbe(current, probeId)) return false;
            Probe updated = current.pendingProbe.withFailure(category, Math.max(0L, nowMs));
            Snapshot next = current.copy(
                    current.tripId,
                    current.revision,
                    current.open,
                    current.paused,
                    current.keepSuppressed,
                    current.promptId,
                    current.events,
                    updated,
                    current.config
            );
            return write(context, next);
        }
    }

    static boolean clearProbe(Context context, String probeId) {
        synchronized (LOCK) {
            Snapshot current = read(context);
            if (!matchesCurrentProbe(current, probeId)) return false;
            Snapshot next = current.copy(
                    current.tripId,
                    current.revision,
                    current.open,
                    current.paused,
                    current.keepSuppressed,
                    current.promptId,
                    current.events,
                    null,
                    current.config
            );
            return write(context, next);
        }
    }

    static boolean clearKeepSuppression(
            Context context,
            String tripId,
            long expectedRevision
    ) {
        synchronized (LOCK) {
            Snapshot current = read(context);
            if (!current.storageHealthy
                    || !current.open
                    || !current.keepSuppressed
                    || current.paused
                    || !canApplyProbe(
                            normalizeText(tripId, 200),
                            expectedRevision,
                            current.tripId,
                            current.revision
                    )) {
                return false;
            }
            Snapshot next = current.copy(
                    current.tripId,
                    incrementRevision(current.revision),
                    true,
                    false,
                    false,
                    current.promptId,
                    current.events,
                    null,
                    current.config
            );
            return write(context, next);
        }
    }

    static boolean commitStart(
            Context context,
            String probeId,
            SignalDetails signal,
            int confirmationHits,
            long confirmationHoldMs
    ) {
        synchronized (LOCK) {
            Snapshot current = read(context);
            if (!matchesCurrentProbe(current, probeId)
                    || current.open
                    || current.events.size() >= MAX_EVENT_COUNT) {
                return false;
            }
            Probe probe = current.pendingProbe;
            long generation = incrementRevision(current.revision);
            String eventId = UUID.randomUUID().toString();
            Event event = eventFromProbe(
                    eventId,
                    EventKind.START,
                    generation,
                    probe,
                    "",
                    "",
                    buildReason(
                            eventId,
                            generation,
                            "start",
                            probe,
                            signal,
                            confirmationHits,
                            confirmationHoldMs
                    )
            );
            List<Event> events = new ArrayList<>(current.events);
            events.add(event);
            Snapshot next = current.copy(
                    current.tripId,
                    generation,
                    true,
                    current.paused,
                    false,
                    "",
                    events,
                    null,
                    current.config
            );
            return write(context, next);
        }
    }

    static String commitEndPrompt(Context context, String probeId, SignalDetails signal) {
        synchronized (LOCK) {
            Snapshot current = read(context);
            if (!matchesCurrentProbe(current, probeId)
                    || !current.open
                    || !current.promptId.isEmpty()
                    || current.events.size() >= MAX_EVENT_COUNT) {
                return "";
            }
            Probe probe = current.pendingProbe;
            long generation = incrementRevision(current.revision);
            String promptId = UUID.randomUUID().toString();
            Event event = eventFromProbe(
                    promptId,
                    EventKind.END_PROMPT,
                    generation,
                    probe,
                    "",
                    promptId,
                    buildReason(
                            promptId,
                            generation,
                            "end-prompt",
                            probe,
                            signal,
                            0,
                            0L
                    )
            );
            List<Event> events = new ArrayList<>(current.events);
            events.add(event);
            Snapshot next = current.copy(
                    current.tripId,
                    generation,
                    true,
                    current.paused,
                    current.keepSuppressed,
                    promptId,
                    events,
                    null,
                    current.config
            );
            return write(context, next) ? promptId : "";
        }
    }

    static DecisionResult recordDecision(
            Context context,
            String promptId,
            boolean end,
            long decidedAtMs
    ) {
        synchronized (LOCK) {
            Snapshot current = read(context);
            String normalizedPromptId = normalizeText(promptId, 200);
            EventKind expectedKind = end ? EventKind.DECISION_END : EventKind.DECISION_KEEP;
            Event existingDecision = findDecisionForPrompt(current.events, normalizedPromptId);
            if (existingDecision != null) {
                return existingDecision.kind == expectedKind
                        ? new DecisionResult(
                                true,
                                existingDecision.id,
                                existingDecision.generation
                        )
                        : new DecisionResult(false, "", current.revision);
            }
            if (!current.storageHealthy
                    || normalizedPromptId.isEmpty()
                    || !normalizedPromptId.equals(current.promptId)
                    || current.events.size() >= MAX_EVENT_COUNT) {
                return new DecisionResult(false, "", current.revision);
            }
            Event prompt = current.pendingPrompt;
            if (prompt == null || prompt.kind != EventKind.END_PROMPT) {
                return new DecisionResult(false, "", current.revision);
            }
            long generation = incrementRevision(current.revision);
            String decisionId = UUID.randomUUID().toString();
            JSONObject reason;
            try {
                reason = new JSONObject(prompt.reason.toString())
                        .put("nativeDetectionId", decisionId)
                        .put("nativeGeneration", generation);
            } catch (JSONException exception) {
                return new DecisionResult(false, "", current.revision);
            }
            Event decision = new Event(
                    decisionId,
                    prompt.tripId,
                    end ? EventKind.DECISION_END : EventKind.DECISION_KEEP,
                    generation,
                    prompt.detectedAt,
                    ResidentLocationQueue.toIsoTimestamp(Math.max(0L, decidedAtMs)),
                    prompt.id,
                    prompt.latitude,
                    prompt.longitude,
                    prompt.accuracyM,
                    prompt.speedKmh,
                    prompt.monotonicSessionId,
                    prompt.elapsedRealtimeMs,
                    reason
            );
            List<Event> events = new ArrayList<>(current.events);
            events.add(decision);
            Snapshot next = current.copy(
                    current.tripId,
                    generation,
                    !end,
                    current.paused,
                    !end,
                    "",
                    events,
                    null,
                    current.config
            );
            return write(context, next)
                    ? new DecisionResult(true, decisionId, generation)
                    : new DecisionResult(false, "", current.revision);
        }
    }

    static JSONArray peek(Context context, int limit) throws JSONException {
        synchronized (LOCK) {
            Snapshot current = read(context);
            if (!current.storageHealthy) throw new JSONException("Native expressway store is corrupt");
            int bounded = Math.max(1, Math.min(limit, MAX_PEEK_LIMIT));
            JSONArray result = new JSONArray();
            for (int index = 0; index < current.events.size() && index < bounded; index += 1) {
                result.put(current.events.get(index).toJson());
            }
            return result;
        }
    }

    static int acknowledge(Context context, JSArray ids) throws JSONException {
        synchronized (LOCK) {
            Snapshot current = read(context);
            if (!current.storageHealthy) throw new JSONException("Native expressway store is corrupt");
            Set<String> accepted = new HashSet<>();
            if (ids != null) {
                for (int index = 0; index < ids.length(); index += 1) {
                    Object value = ids.opt(index);
                    if (value instanceof String) {
                        String id = normalizeText((String) value, 200);
                        if (!id.isEmpty()) accepted.add(id);
                    }
                }
            }
            int prefix = 0;
            while (prefix < current.events.size()
                    && accepted.contains(current.events.get(prefix).id)) {
                prefix += 1;
            }
            if (prefix == 0) return current.events.size();
            List<Event> remaining = new ArrayList<>(
                    current.events.subList(prefix, current.events.size())
            );
            Snapshot next = current.copy(
                    current.tripId,
                    current.revision,
                    current.open,
                    current.paused,
                    current.keepSuppressed,
                    current.promptId,
                    remaining,
                    current.pendingProbe,
                    current.config
            );
            if (!write(context, next)) throw new JSONException("Unable to persist acknowledgement");
            return remaining.size();
        }
    }

    static int pendingEventCount(Context context) {
        return snapshot(context).events.size();
    }

    static boolean canApplyProbe(
            String probeTripId,
            long probeRevision,
            String currentTripId,
            long currentRevision
    ) {
        return probeTripId != null
                && probeTripId.equals(currentTripId)
                && probeRevision == currentRevision;
    }

    static long probeRetryDelayMs(int attemptCount) {
        int exponent = Math.max(0, Math.min(5, attemptCount - 1));
        long delay = PROBE_RETRY_BASE_MS << exponent;
        return Math.min(PROBE_RETRY_MAX_MS, delay);
    }

    static boolean isProbeRetryDue(long nowMs, long retryAfterAtMs) {
        if (retryAfterAtMs <= 0L || nowMs >= retryAfterAtMs) return true;
        // A wall-clock rollback must not strand a durable probe forever.
        return retryAfterAtMs - nowMs > PROBE_RETRY_MAX_MS;
    }

    private static SharedPreferences preferences(Context context) {
        return context.getApplicationContext().getSharedPreferences(
                PREFERENCES_NAME,
                Context.MODE_PRIVATE
        );
    }

    private static Snapshot read(Context context) {
        String encoded = preferences(context).getString(KEY_STATE_JSON, "");
        if (encoded == null || encoded.trim().isEmpty()) return emptySnapshot();
        try {
            JSONObject root = new JSONObject(encoded);
            if (root.optInt("version", 0) != STATE_VERSION) throw new JSONException("version");
            List<Event> events = new ArrayList<>();
            JSONArray eventRows = root.optJSONArray("events");
            if (eventRows != null) {
                if (eventRows.length() > MAX_EVENT_COUNT) throw new JSONException("event count");
                for (int index = 0; index < eventRows.length(); index += 1) {
                    events.add(Event.fromJson(eventRows.getJSONObject(index)));
                }
            }
            String promptId = normalizeText(root.optString("promptId", ""), 200);
            Event pendingPrompt = root.has("pendingPrompt") && !root.isNull("pendingPrompt")
                    ? Event.fromJson(root.getJSONObject("pendingPrompt"))
                    : findEvent(events, promptId);
            if (pendingPrompt != null && (pendingPrompt.kind != EventKind.END_PROMPT
                    || !pendingPrompt.id.equals(promptId))) {
                throw new JSONException("pending prompt mismatch");
            }
            Probe probe = root.has("pendingProbe") && !root.isNull("pendingProbe")
                    ? probeFromJson(root.getJSONObject("pendingProbe"))
                    : null;
            ResidentExpresswayDetectionPolicy.Config config = configFromJson(
                    root.optJSONObject("config")
            );
            return new Snapshot(
                    normalizeText(root.optString("tripId", ""), 200),
                    Math.max(0L, root.optLong("revision", 0L)),
                    root.optBoolean("open", false),
                    root.optBoolean("paused", true),
                    root.optBoolean("keepSuppressed", false),
                    promptId,
                    events,
                    pendingPrompt,
                    probe,
                    config,
                    processStorageHealthy
            );
        } catch (Exception exception) {
            processStorageHealthy = false;
            return new Snapshot(
                    "",
                    0L,
                    false,
                    true,
                    false,
                    "",
                    new ArrayList<>(),
                    null,
                    null,
                    ResidentExpresswayDetectionPolicy.Config.DEFAULT,
                    false
            );
        }
    }

    private static boolean write(Context context, Snapshot state) {
        try {
            JSONArray events = new JSONArray();
            for (Event event : state.events) events.put(event.toJson());
            JSONObject root = new JSONObject()
                    .put("version", STATE_VERSION)
                    .put("tripId", state.tripId)
                    .put("revision", state.revision)
                    .put("open", state.open)
                    .put("paused", state.paused)
                    .put("keepSuppressed", state.keepSuppressed)
                    .put("promptId", state.promptId)
                    .put("events", events)
                    .put("config", configToJson(state.config));
            if (state.pendingProbe != null) {
                root.put("pendingProbe", probeToJson(state.pendingProbe));
            }
            if (state.pendingPrompt != null) {
                root.put("pendingPrompt", state.pendingPrompt.toJson());
            }
            boolean committed = preferences(context).edit()
                    .putString(KEY_STATE_JSON, root.toString())
                    .commit();
            processStorageHealthy = committed;
            return committed;
        } catch (Exception exception) {
            processStorageHealthy = false;
            return false;
        }
    }

    private static Snapshot emptySnapshot() {
        return new Snapshot(
                "",
                0L,
                false,
                true,
                false,
                "",
                new ArrayList<>(),
                null,
                null,
                ResidentExpresswayDetectionPolicy.Config.DEFAULT,
                processStorageHealthy
        );
    }

    private static JSONObject probeToJson(Probe probe) throws JSONException {
        JSONObject json = new JSONObject()
                .put("id", probe.id)
                .put("kind", probe.kind.wireName)
                .put("tripId", probe.tripId)
                .put("expectedRevision", probe.expectedRevision)
                .put("detectedAt", probe.detectedAt)
                .put("detectedAtMs", probe.detectedAtMs)
                .put("lat", probe.latitude)
                .put("lon", probe.longitude)
                .put("speedKmh", probe.speedKmh)
                .put("lowSpeedElapsedMs", probe.lowSpeedElapsedMs)
                .put("monotonicSessionId", probe.monotonicSessionId)
                .put("elapsedRealtimeMs", probe.elapsedRealtimeMs)
                .put("config", configToJson(probe.config))
                .put("attemptCount", probe.attemptCount)
                .put("retryAfterAtMs", probe.retryAfterAtMs)
                .put("lastFailureCategory", probe.lastFailureCategory)
                .put("failureUpdatedAtMs", probe.failureUpdatedAtMs);
        if (probe.accuracyM != null) json.put("accuracyM", probe.accuracyM);
        if (probe.accelerationMs2 != null) json.put("accelerationMs2", probe.accelerationMs2);
        return json;
    }

    private static Probe probeFromJson(JSONObject json) throws JSONException {
        Double accuracy = json.has("accuracyM") && !json.isNull("accuracyM")
                ? json.getDouble("accuracyM")
                : null;
        Double acceleration = json.has("accelerationMs2") && !json.isNull("accelerationMs2")
                ? json.getDouble("accelerationMs2")
                : null;
        return new Probe(
                requiredText(json, "id", 200),
                ProbeKind.fromWireName(requiredText(json, "kind", 40)),
                requiredText(json, "tripId", 200),
                Math.max(0L, json.optLong("expectedRevision", 0L)),
                requiredText(json, "detectedAt", 100),
                Math.max(0L, json.optLong("detectedAtMs", 0L)),
                json.getDouble("lat"),
                json.getDouble("lon"),
                accuracy,
                json.getDouble("speedKmh"),
                acceleration,
                Math.max(0L, json.optLong("lowSpeedElapsedMs", 0L)),
                normalizeText(json.optString("monotonicSessionId", ""), 200),
                json.optLong("elapsedRealtimeMs", -1L),
                configFromJson(json.optJSONObject("config")),
                Math.max(0, json.optInt("attemptCount", 0)),
                Math.max(0L, json.optLong("retryAfterAtMs", 0L)),
                normalizeFailureCategory(json.optString("lastFailureCategory", "")),
                Math.max(0L, json.optLong("failureUpdatedAtMs", 0L))
        );
    }

    private static JSONObject configToJson(ResidentExpresswayDetectionPolicy.Config config)
            throws JSONException {
        return new JSONObject()
                .put("speedKmh", config.startSpeedKmh)
                .put("durationSec", config.startDurationSec)
                .put("endSpeedKmh", config.endSpeedKmh)
                .put("endDurationSec", config.endDurationSec);
    }

    private static ResidentExpresswayDetectionPolicy.Config configFromJson(JSONObject json) {
        if (json == null) return ResidentExpresswayDetectionPolicy.Config.DEFAULT;
        return new ResidentExpresswayDetectionPolicy.Config(
                json.optDouble("speedKmh", 78d),
                json.optLong("durationSec", 6L),
                json.optDouble("endSpeedKmh", 34d),
                json.optLong("endDurationSec", 24L)
        );
    }

    private static Event eventFromProbe(
            String id,
            EventKind kind,
            long generation,
            Probe probe,
            String decidedAt,
            String promptId,
            JSONObject reason
    ) {
        return new Event(
                id,
                probe.tripId,
                kind,
                generation,
                probe.detectedAt,
                decidedAt,
                promptId,
                probe.latitude,
                probe.longitude,
                probe.accuracyM,
                probe.speedKmh,
                probe.monotonicSessionId,
                probe.elapsedRealtimeMs,
                reason
        );
    }

    private static JSONObject buildReason(
            String nativeDetectionId,
            long generation,
            String action,
            Probe probe,
            SignalDetails signal,
            int confirmationHits,
            long confirmationHoldMs
    ) {
        try {
            JSONObject result = new JSONObject()
                    .put("source", "native-auto")
                    .put("action", action)
                    .put("nativeDetectionId", nativeDetectionId)
                    .put("nativeGeneration", generation)
                    .put("evaluatedAt", probe.detectedAt)
                    .put("speedKmh", Math.round(probe.speedKmh))
                    .put("signalResolved", signal.policySignal.resolved)
                    .put("onExpresswayRoad", signal.policySignal.onExpresswayRoad)
                    .put("nearIc", signal.policySignal.nearIc)
                    .put("nearEtcGate", signal.policySignal.nearEtcGate)
                    .put("config", configToJson(probe.config));
            if (probe.accelerationMs2 != null) {
                result.put("accelerationMs2", round(probe.accelerationMs2, 3));
            }
            if (probe.accuracyM != null) result.put("accuracyM", Math.round(probe.accuracyM));
            if (!signal.nearestIcName.isEmpty()) result.put("nearestIcName", signal.nearestIcName);
            if (signal.nearestIcDistanceM != null) {
                result.put("nearestIcDistanceM", Math.round(signal.nearestIcDistanceM));
            }
            if (confirmationHits > 0) {
                result.put("confirm", new JSONObject()
                        .put("hits", confirmationHits)
                        .put("elapsedMs", Math.max(0L, confirmationHoldMs))
                        .put("minHits", ResidentExpresswayDetectionPolicy.START_SIGNAL_MIN_HITS)
                        .put("minHoldMs", ResidentExpresswayDetectionPolicy.START_SIGNAL_MIN_HOLD_MS));
            }
            return result;
        } catch (JSONException exception) {
            return new JSONObject();
        }
    }

    private static Event findEvent(List<Event> events, String id) {
        for (Event event : events) {
            if (event.id.equals(id)) return event;
        }
        return null;
    }

    private static Event findDecisionForPrompt(List<Event> events, String promptId) {
        if (promptId == null || promptId.isEmpty()) return null;
        for (Event event : events) {
            if (!event.promptId.equals(promptId)) continue;
            if (event.kind == EventKind.DECISION_END
                    || event.kind == EventKind.DECISION_KEEP) {
                return event;
            }
        }
        return null;
    }

    private static boolean matchesCurrentProbe(Snapshot current, String probeId) {
        Probe probe = current.pendingProbe;
        return current.storageHealthy
                && probe != null
                && probe.id.equals(normalizeText(probeId, 200))
                && !current.paused
                && canApplyProbe(
                        probe.tripId,
                        probe.expectedRevision,
                        current.tripId,
                        current.revision
                );
    }

    private static boolean hasUnacknowledgedTransition(List<Event> events, String tripId) {
        for (Event event : events) {
            if (!event.tripId.equals(tripId)) continue;
            if (event.kind == EventKind.START || event.kind == EventKind.DECISION_END) return true;
        }
        return false;
    }

    private static boolean sameConfig(
            ResidentExpresswayDetectionPolicy.Config first,
            ResidentExpresswayDetectionPolicy.Config second
    ) {
        return Double.compare(first.startSpeedKmh, second.startSpeedKmh) == 0
                && first.startDurationSec == second.startDurationSec
                && Double.compare(first.endSpeedKmh, second.endSpeedKmh) == 0
                && first.endDurationSec == second.endDurationSec;
    }

    private static boolean sameSnapshot(Snapshot first, Snapshot second) {
        return first == second
                || (first.tripId.equals(second.tripId)
                && first.revision == second.revision
                && first.open == second.open
                && first.paused == second.paused
                && first.keepSuppressed == second.keepSuppressed
                && first.promptId.equals(second.promptId)
                && first.events == second.events
                && first.pendingPrompt == second.pendingPrompt
                && first.pendingProbe == second.pendingProbe
                && sameConfig(first.config, second.config));
    }

    private static long incrementRevision(long revision) {
        return revision == Long.MAX_VALUE ? Long.MAX_VALUE : revision + 1L;
    }

    private static String requiredText(JSONObject object, String key, int maxLength)
            throws JSONException {
        String value = normalizeText(object.optString(key, ""), maxLength);
        if (value.isEmpty()) throw new JSONException(key + " is required");
        return value;
    }

    private static String normalizeText(String value, int maxLength) {
        if (value == null) return "";
        String normalized = value.trim();
        return normalized.length() <= maxLength ? normalized : "";
    }

    private static String normalizeFailureCategory(String value) {
        String normalized = normalizeText(value, 40);
        if (normalized.equals("authorization")
                || normalized.equals("network")
                || normalized.equals("server")
                || normalized.equals("response")) {
            return normalized;
        }
        return "";
    }

    private static double round(double value, int digits) {
        double scale = Math.pow(10d, digits);
        return Math.round(value * scale) / scale;
    }
}
