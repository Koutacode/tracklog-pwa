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

final class ResidentLocationUploader {
    private static final String TAG = "ResidentLocation";
    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private static final int READ_TIMEOUT_MS = 15_000;
    private static final int MAX_RESPONSE_CHARS = 64 * 1024;

    enum Outcome {
        SUCCESS,
        RETRY,
        STOPPED_AUTHORIZATION
    }

    private ResidentLocationUploader() {}

    static Outcome upload(Context context, Location location) {
        Context appContext = context.getApplicationContext();
        ResidentLocationState.Authorization authorization = ResidentLocationState.getAuthorization(appContext);
        if (!authorization.isConfigured()) {
            ResidentLocationState.clearAuthorizationAndDisable(appContext);
            return Outcome.STOPPED_AUTHORIZATION;
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
            ResidentLocationState.clearAuthorizationAndDisable(appContext);
            return Outcome.STOPPED_AUTHORIZATION;
        }
        if (action != ResidentLocationUploadPolicy.Action.REFRESH) return Outcome.RETRY;

        ResidentLocationState.Authorization refreshed;
        try {
            refreshed = refreshAuthorization(authorization);
        } catch (TokenRefreshException exception) {
            Log.w(TAG, "Supabase token refresh was rejected", exception);
            if (exception.permanent) {
                ResidentLocationState.clearAuthorizationAndDisable(appContext);
                return Outcome.STOPPED_AUTHORIZATION;
            }
            return Outcome.RETRY;
        } catch (Exception exception) {
            Log.w(TAG, "Supabase token refresh failed temporarily", exception);
            return Outcome.RETRY;
        }
        if (!refreshed.isConfigured()) {
            Log.w(TAG, "Supabase token refresh returned incomplete credentials; retrying later");
            return Outcome.RETRY;
        }
        ResidentLocationState.updateTokens(appContext, refreshed.accessToken, refreshed.refreshToken);

        try {
            int retryStatus = postLocation(refreshed, location);
            ResidentLocationUploadPolicy.Action retryAction =
                    ResidentLocationUploadPolicy.classifyStatus(retryStatus, true);
            if (retryAction == ResidentLocationUploadPolicy.Action.SUCCESS) return Outcome.SUCCESS;
            if (retryAction == ResidentLocationUploadPolicy.Action.STOP_AUTHORIZATION) {
                ResidentLocationState.clearAuthorizationAndDisable(appContext);
                return Outcome.STOPPED_AUTHORIZATION;
            }
            return Outcome.RETRY;
        } catch (Exception exception) {
            Log.w(TAG, "Latest location retry failed", exception);
            return Outcome.RETRY;
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

    private static ResidentLocationState.Authorization refreshAuthorization(
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
                    ResidentLocationUploadPolicy.isPermanentRefreshFailure(result.statusCode)
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

    private static final class TokenRefreshException extends Exception {
        final boolean permanent;

        TokenRefreshException(String message, boolean permanent) {
            super(message);
            this.permanent = permanent;
        }
    }
}
