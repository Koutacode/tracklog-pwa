package com.tracklog.assist;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.content.ContextCompat;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
        name = "NativeSetup",
        permissions = {
                @Permission(
                        alias = "foregroundLocation",
                        strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION }
                ),
                @Permission(
                        alias = "backgroundLocation",
                        strings = { Manifest.permission.ACCESS_BACKGROUND_LOCATION }
                )
        }
)
public class NativeSetupPlugin extends Plugin {
    static Intent appDetailsIntent(Context context) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.parse("package:" + context.getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return intent;
    }

    static Intent locationSettingsIntent() {
        Intent intent = new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return intent;
    }

    static Intent notificationSettingsIntent(Context context) {
        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
        intent.putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return intent;
    }

    static Intent residentNotificationSettingsIntent(Context context) {
        Intent intent = new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS);
        intent.putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());
        intent.putExtra(Settings.EXTRA_CHANNEL_ID, ResidentLocationService.CHANNEL_ID);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return intent;
    }

    static boolean isResidentNotificationChannelEnabled(
            int sdkInt,
            boolean channelExists,
            int importance
    ) {
        return NativeSetupChannelPolicy.isEnabled(
                sdkInt >= Build.VERSION_CODES.O,
                channelExists,
                importance == NotificationManager.IMPORTANCE_NONE
        );
    }

    static String backgroundPermissionOptionLabel(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                CharSequence label = context.getPackageManager().getBackgroundPermissionOptionLabel();
                if (label != null && label.length() > 0) return label.toString();
            } catch (Exception ignored) {
                // localized fallback below
            }
        }
        return "常に許可";
    }

    private void resolveOpened(PluginCall call, String destination, int fallbackLevel) {
        JSObject ret = new JSObject();
        ret.put("opened", true);
        ret.put("destination", destination);
        ret.put("fallbackLevel", fallbackLevel);
        call.resolve(ret);
    }

    private boolean isPermissionGranted(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean isBatteryOptimizationGranted() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return true;
        }
        final Context context = getContext();
        final PowerManager powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        if (powerManager == null) {
            return false;
        }
        return powerManager.isIgnoringBatteryOptimizations(context.getPackageName());
    }

    @PluginMethod
    public void checkBatteryOptimization(PluginCall call) {
        JSObject ret = new JSObject();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            ret.put("supported", false);
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        ret.put("supported", true);
        ret.put("granted", isBatteryOptimizationGranted());
        call.resolve(ret);
    }

    @PluginMethod
    public void requestBatteryOptimizationExemption(PluginCall call) {
        JSObject ret = new JSObject();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            ret.put("supported", false);
            ret.put("granted", true);
            ret.put("opened", false);
            call.resolve(ret);
            return;
        }

        boolean granted = isBatteryOptimizationGranted();
        ret.put("supported", true);
        ret.put("granted", granted);
        if (granted) {
            ret.put("opened", false);
            ret.put("destination", "already-granted");
            ret.put("fallbackLevel", 0);
            call.resolve(ret);
            return;
        }

        try {
            Intent directIntent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            directIntent.setData(Uri.parse("package:" + getContext().getPackageName()));
            directIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(directIntent);
            ret.put("opened", true);
            ret.put("fallback", false);
            ret.put("destination", "battery-exemption-request");
            ret.put("fallbackLevel", 0);
            call.resolve(ret);
            return;
        } catch (Exception ignored) {
            // fallback below
        }

        try {
            Intent fallbackIntent = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            fallbackIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(fallbackIntent);
            ret.put("opened", true);
            ret.put("fallback", true);
            ret.put("destination", "battery-optimization-list");
            ret.put("fallbackLevel", 1);
            call.resolve(ret);
            return;
        } catch (Exception ignored) {
            // final fallback below
        }

        try {
            getContext().startActivity(appDetailsIntent(getContext()));
            ret.put("opened", true);
            ret.put("fallback", true);
            ret.put("destination", "app-details");
            ret.put("fallbackLevel", 2);
            call.resolve(ret);
        } catch (Exception ex) {
            call.reject("電池最適化設定を開けませんでした。", ex);
        }
    }

    @PluginMethod
    public void getSetupSnapshot(PluginCall call) {
        Context context = getContext();
        ResidentLocationState.Readiness readiness = ResidentLocationState.getReadiness(context);
        boolean fine = isPermissionGranted(Manifest.permission.ACCESS_FINE_LOCATION);
        boolean coarse = isPermissionGranted(Manifest.permission.ACCESS_COARSE_LOCATION);
        boolean backgroundRelevant = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q;
        boolean notificationPermission = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || isPermissionGranted(Manifest.permission.POST_NOTIFICATIONS);
        boolean notificationsEnabled = NotificationManagerCompat.from(context).areNotificationsEnabled();
        boolean residentNotificationChannelExists = true;
        boolean residentNotificationChannelEnabled = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            NotificationChannel channel = manager == null
                    ? null
                    : manager.getNotificationChannel(ResidentLocationService.CHANNEL_ID);
            residentNotificationChannelExists = channel != null;
            residentNotificationChannelEnabled = isResidentNotificationChannelEnabled(
                    Build.VERSION.SDK_INT,
                    residentNotificationChannelExists,
                    channel == null ? NotificationManager.IMPORTANCE_NONE : channel.getImportance()
            );
        }

        JSObject ret = new JSObject();
        ret.put("androidSdkInt", Build.VERSION.SDK_INT);
        ret.put("locationEnabled", readiness.locationEnabled);
        ret.put("fine", fine);
        ret.put("coarse", coarse);
        ret.put("foreground", fine || coarse);
        ret.put("backgroundRelevant", backgroundRelevant);
        ret.put("background", !backgroundRelevant || readiness.backgroundLocation);
        ret.put("backgroundPermissionOptionLabel", backgroundPermissionOptionLabel(context));
        ret.put("notifications", notificationPermission && notificationsEnabled);
        ret.put("residentNotificationChannelExists", residentNotificationChannelExists);
        ret.put("residentNotificationChannelEnabled", residentNotificationChannelEnabled);
        ret.put("batteryOptimization", readiness.batteryOptimization);
        ret.put("residentRunning", ResidentLocationService.isRunning());
        ret.put("approved", ResidentLocationState.isApproved(context));
        ret.put("setupComplete", ResidentLocationState.isSetupComplete(context));
        ret.put("authorizationConfigured", ResidentLocationState.getAuthorization(context).isConfigured());
        call.resolve(ret);
    }

    @PluginMethod
    public void checkLocationPermissions(PluginCall call) {
        JSObject ret = new JSObject();
        boolean fine = isPermissionGranted(Manifest.permission.ACCESS_FINE_LOCATION);
        boolean coarse = isPermissionGranted(Manifest.permission.ACCESS_COARSE_LOCATION);
        boolean backgroundRelevant = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q;
        boolean background = !backgroundRelevant || isPermissionGranted(Manifest.permission.ACCESS_BACKGROUND_LOCATION);

        ret.put("fine", fine);
        ret.put("coarse", coarse);
        ret.put("foreground", fine || coarse);
        ret.put("background", background);
        ret.put("backgroundRelevant", backgroundRelevant);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestLocationPermission(PluginCall call) {
        if (isPermissionGranted(Manifest.permission.ACCESS_FINE_LOCATION)) {
            checkLocationPermissions(call);
            return;
        }
        // Permission UI only: setup must never register a location listener.
        requestPermissionForAlias("foregroundLocation", call, "foregroundLocationPermissionCallback");
    }

    @PermissionCallback
    private void foregroundLocationPermissionCallback(PluginCall call) {
        checkLocationPermissions(call);
    }

    @PluginMethod
    public void requestBackgroundLocationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            JSObject ret = new JSObject();
            ret.put("requested", false);
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        if (isPermissionGranted(Manifest.permission.ACCESS_BACKGROUND_LOCATION)) {
            JSObject ret = new JSObject();
            ret.put("requested", false);
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        if (Build.VERSION.SDK_INT == Build.VERSION_CODES.Q) {
            requestPermissionForAlias(
                    "backgroundLocation",
                    call,
                    "backgroundLocationPermissionCallback"
            );
            return;
        }
        JSObject ret = new JSObject();
        ret.put("requested", false);
        ret.put("granted", false);
        call.resolve(ret);
    }

    @PermissionCallback
    private void backgroundLocationPermissionCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("requested", true);
        ret.put(
                "granted",
                isPermissionGranted(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        );
        call.resolve(ret);
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            getContext().startActivity(appDetailsIntent(getContext()));
            resolveOpened(call, "app-details", 0);
        } catch (Exception ex) {
            call.reject("アプリ設定を開けませんでした。", ex);
        }
    }

    @PluginMethod
    public void openLocationSettings(PluginCall call) {
        try {
            getContext().startActivity(locationSettingsIntent());
            resolveOpened(call, "location-services", 0);
        } catch (Exception ex) {
            try {
                getContext().startActivity(appDetailsIntent(getContext()));
                resolveOpened(call, "app-details", 1);
            } catch (Exception fallbackError) {
                call.reject("位置情報設定を開けませんでした。", fallbackError);
            }
        }
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        try {
            getContext().startActivity(notificationSettingsIntent(getContext()));
            resolveOpened(call, "app-notifications", 0);
        } catch (Exception ex) {
            try {
                getContext().startActivity(appDetailsIntent(getContext()));
                resolveOpened(call, "app-details", 1);
            } catch (Exception fallbackError) {
                call.reject("通知設定を開けませんでした。", fallbackError);
            }
        }
    }

    @PluginMethod
    public void openResidentNotificationSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            openNotificationSettings(call);
            return;
        }
        try {
            getContext().startActivity(residentNotificationSettingsIntent(getContext()));
            resolveOpened(call, "resident-notification-channel", 0);
        } catch (Exception ex) {
            try {
                getContext().startActivity(notificationSettingsIntent(getContext()));
                resolveOpened(call, "app-notifications", 1);
            } catch (Exception notificationError) {
                try {
                    getContext().startActivity(appDetailsIntent(getContext()));
                    resolveOpened(call, "app-details", 2);
                } catch (Exception fallbackError) {
                    call.reject("位置記録通知の設定を開けませんでした。", fallbackError);
                }
            }
        }
    }
}
