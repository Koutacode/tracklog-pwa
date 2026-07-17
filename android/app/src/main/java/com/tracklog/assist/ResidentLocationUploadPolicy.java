package com.tracklog.assist;

import org.json.JSONObject;

import java.net.URI;

final class ResidentLocationUploadPolicy {
    static final long MIN_UPLOAD_INTERVAL_MS = 30_000L;

    enum Action {
        SUCCESS,
        REFRESH,
        STOP_AUTHORIZATION,
        RETRY
    }

    private ResidentLocationUploadPolicy() {}

    static boolean shouldAttempt(long nowMs, long lastAttemptMs) {
        return lastAttemptMs <= 0L || nowMs - lastAttemptMs >= MIN_UPLOAD_INTERVAL_MS;
    }

    static Action classifyStatus(int statusCode, boolean refreshAlreadyAttempted) {
        if (statusCode >= 200 && statusCode < 300) return Action.SUCCESS;
        if (statusCode == 403) return Action.STOP_AUTHORIZATION;
        if (statusCode == 401) {
            return refreshAlreadyAttempted ? Action.RETRY : Action.REFRESH;
        }
        return Action.RETRY;
    }

    static boolean isPermanentRefreshFailure(int statusCode, String responseBody) {
        if (statusCode == 403) return true;
        if (statusCode != 400 && statusCode != 401) return false;
        String normalized = responseBody == null ? "" : responseBody.trim().toLowerCase();
        String errorCode = "";
        try {
            JSONObject payload = new JSONObject(responseBody == null ? "" : responseBody);
            errorCode = payload.optString("error_code", payload.optString("code", ""))
                    .trim()
                    .toLowerCase();
        } catch (Exception ignored) {
            // Some Supabase/proxy responses are plain text; use the fallback below.
        }
        if (errorCode.equals("refresh_token_already_used")
                || errorCode.equals("refresh_token_not_found")
                || errorCode.equals("session_not_found")
                || errorCode.equals("user_not_found")) {
            return true;
        }
        return normalized.contains("refresh_token_not_found")
                || normalized.contains("refresh token not found")
                || normalized.contains("refresh_token_already_used")
                || normalized.contains("refresh token already used")
                || normalized.contains("invalid refresh token: already used")
                || normalized.contains("invalid refresh token")
                || normalized.contains("session not found")
                || normalized.contains("user not found");
    }

    static String normalizeBaseUrl(String value) {
        if (value == null) return "";
        String normalized = value.trim();
        while (normalized.endsWith("/")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        if (normalized.isEmpty()) return "";
        try {
            URI uri = URI.create(normalized);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null) return "";
            if (uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null) return "";
            return normalized;
        } catch (IllegalArgumentException ignored) {
            return "";
        }
    }
}
