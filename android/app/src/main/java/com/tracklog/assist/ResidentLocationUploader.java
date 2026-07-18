package com.tracklog.assist;

import android.content.Context;
import android.location.Location;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicLong;

final class ResidentLocationUploader {
    private static final String TAG = "ResidentLocation";
    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private static final int READ_TIMEOUT_MS = 15_000;
    private static final int MAX_RESPONSE_CHARS = 64 * 1024;
    private static final long MIN_ACCESS_TOKEN_VALIDITY_MS = 5L * 60L * 1000L;
    static final Object AUTHORIZATION_REFRESH_LOCK = new Object();
    private static final AtomicLong AUTHORIZATION_MUTATION_EPOCH = new AtomicLong(0L);
    private static volatile long appliedAuthorizationMutationEpoch = 0L;

    enum Outcome {
        SUCCESS,
        RETRY,
        BLOCKED_AUTHORIZATION,
        STOPPED_AUTHORIZATION
    }

    private ResidentLocationUploader() {}

    static long beginAuthorizationMutation() {
        return AUTHORIZATION_MUTATION_EPOCH.incrementAndGet();
    }

    static boolean advanceAuthorizationMutationIfCurrent(long expectedEpoch) {
        return AUTHORIZATION_MUTATION_EPOCH.compareAndSet(
                expectedEpoch,
                expectedEpoch + 1L
        );
    }

    static long currentAuthorizationMutationEpoch() {
        return AUTHORIZATION_MUTATION_EPOCH.get();
    }

    static boolean isLatestAuthorizationMutation(long epoch) {
        return AUTHORIZATION_MUTATION_EPOCH.get() == epoch;
    }

    static boolean isAuthorizationMutationApplied(long epoch) {
        return AUTHORIZATION_MUTATION_EPOCH.get() == epoch
                && appliedAuthorizationMutationEpoch == epoch;
    }

    static boolean markAuthorizationMutationApplied(long epoch) {
        if (!isLatestAuthorizationMutation(epoch)) return false;
        appliedAuthorizationMutationEpoch = epoch;
        return true;
    }

    static Outcome upload(Context context, Location location) {
        Context appContext = context.getApplicationContext();
        AuthorizationSnapshot snapshot = getAuthorizationSnapshot(appContext);
        if (snapshot.mutationPending) return Outcome.RETRY;
        ResidentLocationState.Authorization authorization = snapshot.authorization;
        if (!authorization.isConfigured()) {
            return Outcome.STOPPED_AUTHORIZATION;
        }
        if (snapshot.blocked) {
            return Outcome.BLOCKED_AUTHORIZATION;
        }

        int status;
        try {
            status = postLocation(authorization, location);
        } catch (Exception exception) {
            Log.w(TAG, "Latest location upload failed; retrying on a later location", exception);
            return Outcome.RETRY;
        }

        ResidentLocationUploadPolicy.Action action =
                ResidentLocationUploadPolicy.classifyStatus(status, false);
        if (action == ResidentLocationUploadPolicy.Action.SUCCESS) return Outcome.SUCCESS;
        if (action == ResidentLocationUploadPolicy.Action.STOP_AUTHORIZATION) {
            return stopAfterAuthorizationRejection(
                    appContext,
                    authorization,
                    snapshot.epoch
            );
        }
        if (action != ResidentLocationUploadPolicy.Action.REFRESH) return Outcome.RETRY;

        AuthorizationRefreshResult refreshResult;
        try {
            refreshResult = refreshAfterUnauthorized(
                    appContext,
                    authorization,
                    snapshot.epoch
            );
        } catch (Exception exception) {
            Log.w(TAG, "Supabase token refresh failed temporarily", exception);
            return Outcome.RETRY;
        }
        if (refreshResult.cancelled) return Outcome.RETRY;
        if (refreshResult.blocked) return Outcome.BLOCKED_AUTHORIZATION;
        ResidentLocationState.Authorization refreshed = refreshResult.authorization;
        if (!refreshed.isConfigured()) {
            return Outcome.RETRY;
        }

        try {
            int retryStatus = postLocation(refreshed, location);
            ResidentLocationUploadPolicy.Action retryAction =
                    ResidentLocationUploadPolicy.classifyStatus(retryStatus, true);
            if (retryAction == ResidentLocationUploadPolicy.Action.SUCCESS) return Outcome.SUCCESS;
            if (retryAction == ResidentLocationUploadPolicy.Action.STOP_AUTHORIZATION) {
                return stopAfterAuthorizationRejection(
                        appContext,
                        refreshed,
                        refreshResult.epoch
                );
            }
            return Outcome.RETRY;
        } catch (Exception exception) {
            Log.w(TAG, "Latest location retry failed", exception);
            return Outcome.RETRY;
        }
    }

    private static AuthorizationSnapshot getAuthorizationSnapshot(Context context) {
        synchronized (AUTHORIZATION_REFRESH_LOCK) {
            long appliedEpoch = appliedAuthorizationMutationEpoch;
            return new AuthorizationSnapshot(
                    ResidentLocationState.getAuthorization(context),
                    ResidentLocationState.isAuthorizationBlocked(context),
                    appliedEpoch,
                    AUTHORIZATION_MUTATION_EPOCH.get() != appliedEpoch
            );
        }
    }

    private static Outcome stopAfterAuthorizationRejection(
            Context context,
            ResidentLocationState.Authorization attempted,
            long expectedEpoch
    ) {
        synchronized (AUTHORIZATION_REFRESH_LOCK) {
            if (!isAuthorizationMutationApplied(expectedEpoch)) return Outcome.RETRY;
            ResidentLocationState.Authorization current =
                    ResidentLocationState.getAuthorization(context);
            if (!ResidentLocationState.authorizationCredentialsMatch(attempted, current)) {
                return Outcome.RETRY;
            }
            if (!advanceAuthorizationMutationIfCurrent(expectedEpoch)) {
                return Outcome.RETRY;
            }
            long clearEpoch = expectedEpoch + 1L;
            boolean cleared = ResidentLocationState.clearAuthorizationAndDisableIfCurrent(
                    context,
                    attempted
            );
            boolean applied = cleared && markAuthorizationMutationApplied(clearEpoch);
            return applied ? Outcome.STOPPED_AUTHORIZATION : Outcome.RETRY;
        }
    }

    private static int postLocation(
            ResidentLocationState.Authorization authorization,
            Location location
    ) throws Exception {
        JSONObject payload = new JSONObject();
        payload.put("deviceId", authorization.deviceId);
        payload.put("lat", location.getLatitude());
        payload.put("lng", location.getLongitude());
        payload.put("accuracy", location.hasAccuracy() ? location.getAccuracy() : JSONObject.NULL);
        payload.put("recordedAt", ResidentLocationQueue.toIsoTimestamp(location.getTime()));
        return postJson(
                authorization.supabaseUrl + "/functions/v1/tracklog-location",
                authorization.anonKey,
                authorization.accessToken,
                payload
        ).statusCode;
    }

    static AuthorizationRefreshResult refreshAuthorizationForWebView(
            Context context,
            long expectedEpoch,
            boolean force
    ) throws Exception {
        Context appContext = context.getApplicationContext();
        synchronized (AUTHORIZATION_REFRESH_LOCK) {
            if (!isAuthorizationMutationApplied(expectedEpoch)) {
                return currentRefreshResultLocked(appContext, true);
            }
            ResidentLocationState.Authorization current =
                    ResidentLocationState.getAuthorization(appContext);
            boolean blocked = ResidentLocationState.isAuthorizationBlocked(appContext);
            boolean hasMinimumValidity = hasMinimumJwtValidity(
                    current.accessToken,
                    System.currentTimeMillis(),
                    MIN_ACCESS_TOKEN_VALIDITY_MS
            );
            if (!shouldRefreshAuthorization(
                    current.isConfigured(),
                    blocked,
                    hasMinimumValidity,
                    force
            )) {
                return currentRefreshResultLocked(appContext, false);
            }
            return refreshAndPersistLocked(appContext, current, expectedEpoch);
        }
    }

    static boolean shouldRefreshAuthorization(
            boolean configured,
            boolean blocked,
            boolean hasMinimumValidity,
            boolean force
    ) {
        return configured && !blocked && (force || !hasMinimumValidity);
    }

    static AuthorizationRefreshResult blockAuthorization(
            Context context,
            ResidentLocationState.Authorization expected,
            long expectedEpoch
    ) {
        Context appContext = context.getApplicationContext();
        synchronized (AUTHORIZATION_REFRESH_LOCK) {
            if (!isAuthorizationMutationApplied(expectedEpoch)
                    || !ResidentLocationState.blockAuthorizationIfCurrent(appContext, expected)) {
                return currentRefreshResultLocked(appContext, true);
            }
            return currentRefreshResultLocked(appContext, false);
        }
    }

    private static AuthorizationRefreshResult refreshAfterUnauthorized(
            Context context,
            ResidentLocationState.Authorization attempted,
            long expectedEpoch
    ) throws Exception {
        synchronized (AUTHORIZATION_REFRESH_LOCK) {
            if (!isAuthorizationMutationApplied(expectedEpoch)) {
                return currentRefreshResultLocked(context, true);
            }
            ResidentLocationState.Authorization current =
                    ResidentLocationState.getAuthorization(context);
            boolean blocked = ResidentLocationState.isAuthorizationBlocked(context);
            if (blocked || !current.isConfigured()) {
                return currentRefreshResultLocked(context, false);
            }
            if (!current.sameCredentials(attempted)) {
                return currentRefreshResultLocked(context, false);
            }
            return refreshAndPersistLocked(context, current, expectedEpoch);
        }
    }

    private static AuthorizationRefreshResult refreshAndPersistLocked(
            Context context,
            ResidentLocationState.Authorization current,
            long expectedEpoch
    ) throws Exception {
        ResidentLocationState.Authorization refreshed;
        try {
            refreshed = requestTokenRefresh(current);
        } catch (TokenRefreshException exception) {
            if (!exception.permanent) throw exception;
            if (!isAuthorizationMutationApplied(expectedEpoch)) {
                return currentRefreshResultLocked(context, true);
            }
            Log.w(TAG, "Supabase token refresh was permanently rejected; blocking uploads", exception);
            if (!ResidentLocationState.blockAuthorizationIfCurrent(context, current)) {
                return currentRefreshResultLocked(context, true);
            }
            return currentRefreshResultLocked(context, false);
        }
        if (!refreshed.isConfigured()) {
            throw new TokenRefreshException(
                    "Token refresh returned incomplete credentials",
                    false
            );
        }
        if (!isAuthorizationMutationApplied(expectedEpoch)
                || !ResidentLocationState.updateTokensIfCurrent(
                        context,
                        current,
                        refreshed.accessToken,
                        refreshed.refreshToken
                )) {
            return currentRefreshResultLocked(context, true);
        }
        return currentRefreshResultLocked(context, false);
    }

    private static AuthorizationRefreshResult currentRefreshResultLocked(
            Context context,
            boolean cancelled
    ) {
        return new AuthorizationRefreshResult(
                ResidentLocationState.getAuthorization(context),
                ResidentLocationState.isAuthorizationBlocked(context),
                cancelled
                        || AUTHORIZATION_MUTATION_EPOCH.get()
                        != appliedAuthorizationMutationEpoch,
                appliedAuthorizationMutationEpoch
        );
    }

    private static ResidentLocationState.Authorization requestTokenRefresh(
            ResidentLocationState.Authorization current
    ) throws Exception {
        JSONObject payload = new JSONObject();
        payload.put("refresh_token", current.refreshToken);
        HttpResult result = postJson(
                current.supabaseUrl + "/auth/v1/token?grant_type=refresh_token",
                current.anonKey,
                null,
                payload
        );
        if (result.statusCode < 200 || result.statusCode >= 300) {
            throw new TokenRefreshException(
                    "Token refresh returned HTTP " + result.statusCode,
                    ResidentLocationUploadPolicy.isPermanentRefreshFailure(
                            result.statusCode,
                            result.body
                    )
            );
        }
        JSONObject body = new JSONObject(result.body);
        String accessToken = body.optString("access_token", "").trim();
        String refreshToken = body.optString("refresh_token", "").trim();
        if (refreshToken.isEmpty()) refreshToken = current.refreshToken;
        return ResidentLocationState.Authorization.create(
                current.supabaseUrl,
                current.anonKey,
                accessToken,
                refreshToken,
                current.deviceId,
                System.currentTimeMillis()
        );
    }

    static boolean hasMinimumJwtValidity(
            String accessToken,
            long nowMs,
            long minimumValidityMs
    ) {
        return hasMinimumExpirationValidity(
                getJwtExpirationTimeMs(accessToken),
                nowMs,
                minimumValidityMs
        );
    }

    static boolean hasMinimumExpirationValidity(
            long expiresAtMs,
            long nowMs,
            long minimumValidityMs
    ) {
        if (expiresAtMs <= 0L || nowMs < 0L || minimumValidityMs < 0L) return false;
        if (nowMs > Long.MAX_VALUE - minimumValidityMs) return false;
        return expiresAtMs >= nowMs + minimumValidityMs;
    }

    private static long getJwtExpirationTimeMs(String accessToken) {
        if (accessToken == null) return 0L;
        String[] parts = accessToken.trim().split("\\.", -1);
        if (parts.length != 3 || parts[1].isEmpty()) return 0L;
        byte[] decoded = decodeBase64Url(parts[1]);
        if (decoded == null) return 0L;
        try {
            JSONObject payload = new JSONObject(new String(decoded, StandardCharsets.UTF_8));
            long expirationSeconds = payload.optLong("exp", 0L);
            if (expirationSeconds <= 0L || expirationSeconds > Long.MAX_VALUE / 1000L) return 0L;
            return expirationSeconds * 1000L;
        } catch (Exception ignored) {
            return 0L;
        }
    }

    private static byte[] decodeBase64Url(String value) {
        int length = value.length();
        if (length == 0 || length % 4 == 1) return null;
        byte[] output = new byte[(length * 6) / 8];
        int buffer = 0;
        int bits = 0;
        int outputIndex = 0;
        for (int index = 0; index < length; index++) {
            int decoded = decodeBase64UrlCharacter(value.charAt(index));
            if (decoded < 0) return null;
            buffer = (buffer << 6) | decoded;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                output[outputIndex++] = (byte) ((buffer >> bits) & 0xff);
            }
        }
        if (outputIndex != output.length) return null;
        return output;
    }

    private static int decodeBase64UrlCharacter(char value) {
        if (value >= 'A' && value <= 'Z') return value - 'A';
        if (value >= 'a' && value <= 'z') return value - 'a' + 26;
        if (value >= '0' && value <= '9') return value - '0' + 52;
        if (value == '-') return 62;
        if (value == '_') return 63;
        return -1;
    }

    private static HttpResult postJson(
            String endpoint,
            String apiKey,
            String accessToken,
            JSONObject payload
    ) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setDoOutput(true);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("apikey", apiKey);
            if (accessToken != null && !accessToken.isEmpty()) {
                connection.setRequestProperty("Authorization", "Bearer " + accessToken);
            }
            byte[] requestBody = payload.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(requestBody.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(requestBody);
                output.flush();
            }
            int statusCode = connection.getResponseCode();
            InputStream stream = statusCode >= 200 && statusCode < 400
                    ? connection.getInputStream()
                    : connection.getErrorStream();
            return new HttpResult(statusCode, readResponse(stream));
        } finally {
            connection.disconnect();
        }
    }

    private static String readResponse(InputStream stream) throws Exception {
        if (stream == null) return "";
        StringBuilder result = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            char[] buffer = new char[2048];
            int read;
            while ((read = reader.read(buffer)) >= 0 && result.length() < MAX_RESPONSE_CHARS) {
                int remaining = MAX_RESPONSE_CHARS - result.length();
                result.append(buffer, 0, Math.min(read, remaining));
            }
        }
        return result.toString();
    }

    private static final class HttpResult {
        final int statusCode;
        final String body;

        HttpResult(int statusCode, String body) {
            this.statusCode = statusCode;
            this.body = body;
        }
    }

    private static final class AuthorizationSnapshot {
        final ResidentLocationState.Authorization authorization;
        final boolean blocked;
        final long epoch;
        final boolean mutationPending;

        AuthorizationSnapshot(
                ResidentLocationState.Authorization authorization,
                boolean blocked,
                long epoch,
                boolean mutationPending
        ) {
            this.authorization = authorization;
            this.blocked = blocked;
            this.epoch = epoch;
            this.mutationPending = mutationPending;
        }
    }

    static final class AuthorizationRefreshResult {
        final ResidentLocationState.Authorization authorization;
        final boolean blocked;
        final boolean cancelled;
        final long epoch;

        AuthorizationRefreshResult(
                ResidentLocationState.Authorization authorization,
                boolean blocked,
                boolean cancelled,
                long epoch
        ) {
            this.authorization = authorization;
            this.blocked = blocked;
            this.cancelled = cancelled;
            this.epoch = epoch;
        }
    }

    private static final class TokenRefreshException extends Exception {
        final boolean permanent;

        TokenRefreshException(String message, boolean permanent) {
            super(message);
            this.permanent = permanent;
        }
    }
}
