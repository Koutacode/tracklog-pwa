package com.tracklog.assist;

import android.Manifest;
import android.app.AlarmManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.os.Build;
import android.os.PowerManager;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

import androidx.core.content.ContextCompat;

final class ResidentLocationState {
    static final String PREFERENCES_NAME = "tracklog_resident_location";
    static final String KEY_ACTIVE_TRIP_ID = "active_trip_id";
    static final String KEY_ROUTE_PAUSE_AT_MS = "route_pause_at_ms";
    static final String KEY_APPROVED = "approved";
    static final String KEY_SETUP_COMPLETE = "setup_complete";
    static final String KEY_ENABLED = "enabled";
    static final String KEY_SUPABASE_URL = "supabase_url";
    static final String KEY_SUPABASE_ANON_KEY = "supabase_anon_key";
    static final String KEY_ACCESS_TOKEN = "access_token";
    static final String KEY_REFRESH_TOKEN = "refresh_token";
    static final String KEY_DEVICE_ID = "device_id";
    static final String KEY_AUTHORIZATION_UPDATED_AT = "authorization_updated_at";
    static final String KEY_LAST_UPLOAD_ATTEMPT_AT = "last_upload_attempt_at";
    static final String KEY_LAST_UPLOAD_SUCCESS_AT = "last_upload_success_at";
    static final String KEY_BLOCKED_AUTHORIZATION_FINGERPRINT = "blocked_authorization_fingerprint";

    private ResidentLocationState() {}

    static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
    }

    static String normalizeTripId(String tripId) {
        if (tripId == null) return "";
        return tripId.trim();
    }

    static void reconcile(
            Context context,
            boolean approved,
            boolean setupComplete,
            String activeTripId,
            long routePauseAtMs,
            String supabaseUrl,
            String anonKey,
            String accessToken,
            String refreshToken,
            String deviceId
    ) {
        String normalizedTripId = normalizeTripId(activeTripId);
        Authorization currentAuthorization = getAuthorization(context);
        Authorization authorization = Authorization.create(
                supabaseUrl,
                anonKey,
                accessToken,
                refreshToken,
                deviceId,
                System.currentTimeMillis()
        );
        if (authorization.sameCredentials(currentAuthorization)) {
            authorization = currentAuthorization;
        }
        String blockedFingerprint = preferences(context)
                .getString(KEY_BLOCKED_AUTHORIZATION_FINGERPRINT, "");
        boolean authorizationBlocked = authorization.isConfigured()
                && authorization.fingerprint().equals(blockedFingerprint);
        boolean enabled = isEligibleState(
                approved,
                setupComplete,
                authorization.isConfigured() && !authorizationBlocked
        );
        SharedPreferences.Editor editor = preferences(context).edit()
                .putBoolean(KEY_APPROVED, approved)
                .putBoolean(KEY_SETUP_COMPLETE, setupComplete)
                .putBoolean(KEY_ENABLED, enabled)
                .putString(KEY_ACTIVE_TRIP_ID, normalizedTripId)
                .putLong(KEY_ROUTE_PAUSE_AT_MS, Math.max(0L, routePauseAtMs));
        if (approved && authorization.isConfigured() && !authorizationBlocked) {
            writeAuthorization(editor, authorization);
            editor.remove(KEY_BLOCKED_AUTHORIZATION_FINGERPRINT);
        } else if (!approved) {
            clearAuthorization(editor);
        }
        editor.commit();
    }

    static void stop(Context context, boolean clearAuthorization, boolean clearActiveTrip) {
        SharedPreferences.Editor editor = preferences(context).edit().putBoolean(KEY_ENABLED, false);
        if (clearAuthorization) {
            editor.putBoolean(KEY_APPROVED, false).putBoolean(KEY_SETUP_COMPLETE, false);
            clearAuthorization(editor);
        }
        if (clearActiveTrip) {
            editor.remove(KEY_ACTIVE_TRIP_ID);
            editor.remove(KEY_ROUTE_PAUSE_AT_MS);
        }
        editor.commit();
    }

    static boolean isEnabled(Context context) {
        return preferences(context).getBoolean(KEY_ENABLED, false);
    }

    static boolean isApproved(Context context) {
        return preferences(context).getBoolean(KEY_APPROVED, false);
    }

    static boolean isSetupComplete(Context context) {
        return preferences(context).getBoolean(KEY_SETUP_COMPLETE, false);
    }

    static String getActiveTripId(Context context) {
        return normalizeTripId(preferences(context).getString(KEY_ACTIVE_TRIP_ID, ""));
    }

    static long getRoutePauseAtMs(Context context) {
        return Math.max(0L, preferences(context).getLong(KEY_ROUTE_PAUSE_AT_MS, 0L));
    }

    static boolean shouldRecordRouteAt(Context context, long timestampMs) {
        return shouldRecordRouteAt(getRoutePauseAtMs(context), timestampMs);
    }

    static boolean shouldRecordRouteAt(long pauseAtMs, long timestampMs) {
        return pauseAtMs <= 0L || timestampMs < pauseAtMs;
    }

    static boolean isEligible(Context context) {
        return isEnabled(context)
                && isEligibleState(isApproved(context), isSetupComplete(context), getAuthorization(context).isConfigured());
    }

    static boolean isEligibleState(boolean approved, boolean setupComplete, boolean authorizationConfigured) {
        return approved && setupComplete && authorizationConfigured;
    }

    static Authorization getAuthorization(Context context) {
        SharedPreferences preferences = preferences(context);
        return Authorization.create(
                preferences.getString(KEY_SUPABASE_URL, ""),
                preferences.getString(KEY_SUPABASE_ANON_KEY, ""),
                preferences.getString(KEY_ACCESS_TOKEN, ""),
                preferences.getString(KEY_REFRESH_TOKEN, ""),
                preferences.getString(KEY_DEVICE_ID, ""),
                preferences.getLong(KEY_AUTHORIZATION_UPDATED_AT, 0L)
        );
    }

    static void updateTokens(Context context, String accessToken, String refreshToken) {
        Authorization current = getAuthorization(context);
        Authorization updated = Authorization.create(
                current.supabaseUrl,
                current.anonKey,
                accessToken,
                refreshToken,
                current.deviceId,
                System.currentTimeMillis()
        );
        if (!updated.isConfigured()) return;
        SharedPreferences.Editor editor = preferences(context).edit();
        writeAuthorization(editor, updated);
        editor.commit();
    }

    static long getLastUploadAttemptAt(Context context) {
        return preferences(context).getLong(KEY_LAST_UPLOAD_ATTEMPT_AT, 0L);
    }

    static void markUploadAttempt(Context context, long timestampMs) {
        preferences(context).edit().putLong(KEY_LAST_UPLOAD_ATTEMPT_AT, timestampMs).commit();
    }

    static long getLastUploadSuccessAt(Context context) {
        return preferences(context).getLong(KEY_LAST_UPLOAD_SUCCESS_AT, 0L);
    }

    static void markUploadSuccess(Context context, long timestampMs) {
        preferences(context).edit().putLong(KEY_LAST_UPLOAD_SUCCESS_AT, timestampMs).commit();
    }

    static void clearAuthorizationAndDisable(Context context) {
        Authorization current = getAuthorization(context);
        SharedPreferences.Editor editor = preferences(context).edit()
                .putBoolean(KEY_ENABLED, false)
                .putBoolean(KEY_APPROVED, false);
        clearAuthorization(editor);
        if (current.isConfigured()) {
            editor.putString(KEY_BLOCKED_AUTHORIZATION_FINGERPRINT, current.fingerprint());
        }
        editor.commit();
    }

    static boolean isAuthorizationBlocked(Context context) {
        return !preferences(context)
                .getString(KEY_BLOCKED_AUTHORIZATION_FINGERPRINT, "")
                .isEmpty();
    }

    private static void writeAuthorization(SharedPreferences.Editor editor, Authorization authorization) {
        editor.putString(KEY_SUPABASE_URL, authorization.supabaseUrl)
                .putString(KEY_SUPABASE_ANON_KEY, authorization.anonKey)
                .putString(KEY_ACCESS_TOKEN, authorization.accessToken)
                .putString(KEY_REFRESH_TOKEN, authorization.refreshToken)
                .putString(KEY_DEVICE_ID, authorization.deviceId)
                .putLong(KEY_AUTHORIZATION_UPDATED_AT, authorization.updatedAt);
    }

    private static void clearAuthorization(SharedPreferences.Editor editor) {
        editor.remove(KEY_SUPABASE_URL)
                .remove(KEY_SUPABASE_ANON_KEY)
                .remove(KEY_ACCESS_TOKEN)
                .remove(KEY_REFRESH_TOKEN)
                .remove(KEY_DEVICE_ID)
                .remove(KEY_AUTHORIZATION_UPDATED_AT)
                .remove(KEY_LAST_UPLOAD_ATTEMPT_AT)
                .remove(KEY_LAST_UPLOAD_SUCCESS_AT);
    }

    static Readiness getReadiness(Context context) {
        boolean foregroundLocation = hasPermission(context, Manifest.permission.ACCESS_FINE_LOCATION);
        boolean backgroundLocation = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                || hasPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION);
        boolean notifications = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || hasPermission(context, Manifest.permission.POST_NOTIFICATIONS);
        boolean batteryOptimization = isIgnoringBatteryOptimizations(context);
        boolean exactAlarm = canScheduleExactAlarms(context);
        boolean locationEnabled = isLocationEnabled(context);
        return new Readiness(
                foregroundLocation,
                backgroundLocation,
                notifications,
                batteryOptimization,
                exactAlarm,
                locationEnabled
        );
    }

    private static boolean hasPermission(Context context, String permission) {
        return ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED;
    }

    private static boolean isIgnoringBatteryOptimizations(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager manager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        return manager != null && manager.isIgnoringBatteryOptimizations(context.getPackageName());
    }

    private static boolean canScheduleExactAlarms(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        return manager != null && manager.canScheduleExactAlarms();
    }

    private static boolean isLocationEnabled(Context context) {
        LocationManager manager = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        if (manager == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return manager.isLocationEnabled();
        }
        return manager.isProviderEnabled(LocationManager.GPS_PROVIDER)
                || manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
    }

    static final class Readiness {
        final boolean foregroundLocation;
        final boolean backgroundLocation;
        final boolean notifications;
        final boolean batteryOptimization;
        final boolean exactAlarm;
        final boolean locationEnabled;

        Readiness(
                boolean foregroundLocation,
                boolean backgroundLocation,
                boolean notifications,
                boolean batteryOptimization,
                boolean exactAlarm,
                boolean locationEnabled
        ) {
            this.foregroundLocation = foregroundLocation;
            this.backgroundLocation = backgroundLocation;
            this.notifications = notifications;
            this.batteryOptimization = batteryOptimization;
            this.exactAlarm = exactAlarm;
            this.locationEnabled = locationEnabled;
        }

        boolean isReady() {
            return foregroundLocation
                    && backgroundLocation
                    && notifications
                    && batteryOptimization
                    && exactAlarm
                    && locationEnabled;
        }
    }

    static final class Authorization {
        final String supabaseUrl;
        final String anonKey;
        final String accessToken;
        final String refreshToken;
        final String deviceId;
        final long updatedAt;

        private Authorization(
                String supabaseUrl,
                String anonKey,
                String accessToken,
                String refreshToken,
                String deviceId,
                long updatedAt
        ) {
            this.supabaseUrl = supabaseUrl;
            this.anonKey = anonKey;
            this.accessToken = accessToken;
            this.refreshToken = refreshToken;
            this.deviceId = deviceId;
            this.updatedAt = Math.max(0L, updatedAt);
        }

        static Authorization create(
                String supabaseUrl,
                String anonKey,
                String accessToken,
                String refreshToken,
                String deviceId,
                long updatedAt
        ) {
            return new Authorization(
                    ResidentLocationUploadPolicy.normalizeBaseUrl(supabaseUrl),
                    normalizeSecret(anonKey),
                    normalizeSecret(accessToken),
                    normalizeSecret(refreshToken),
                    normalizeDeviceId(deviceId),
                    updatedAt
            );
        }

        boolean isConfigured() {
            return !supabaseUrl.isEmpty()
                    && !anonKey.isEmpty()
                    && !accessToken.isEmpty()
                    && !refreshToken.isEmpty()
                    && !deviceId.isEmpty();
        }

        boolean sameCredentials(Authorization other) {
            return other != null
                    && supabaseUrl.equals(other.supabaseUrl)
                    && anonKey.equals(other.anonKey)
                    && accessToken.equals(other.accessToken)
                    && refreshToken.equals(other.refreshToken)
                    && deviceId.equals(other.deviceId);
        }

        String fingerprint() {
            if (!isConfigured()) return "";
            try {
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                byte[] bytes = digest.digest(
                        (accessToken + "\n" + refreshToken + "\n" + deviceId)
                                .getBytes(StandardCharsets.UTF_8)
                );
                StringBuilder result = new StringBuilder(bytes.length * 2);
                for (byte value : bytes) result.append(String.format("%02x", value));
                return result.toString();
            } catch (Exception ignored) {
                return "";
            }
        }

        private static String normalizeSecret(String value) {
            if (value == null) return "";
            String normalized = value.trim();
            return normalized.length() <= 16_384 ? normalized : "";
        }

        private static String normalizeDeviceId(String value) {
            if (value == null) return "";
            String normalized = value.trim();
            return normalized.length() <= 200 ? normalized : "";
        }
    }
}
