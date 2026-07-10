package com.tracklog.assist;

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
            return refreshAlreadyAttempted ? Action.STOP_AUTHORIZATION : Action.REFRESH;
        }
        return Action.RETRY;
    }

    static boolean isPermanentRefreshFailure(int statusCode) {
        return statusCode == 400 || statusCode == 401 || statusCode == 403;
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
