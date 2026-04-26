package com.tracklog.assist;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeSetup")
public class NativeSetupPlugin extends Plugin {
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
            call.resolve(ret);
        } catch (Exception ex) {
            call.reject("電池最適化設定を開けませんでした。", ex);
        }
    }

    @PluginMethod
    public void getPlatformInfo(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("androidSdkInt", Build.VERSION.SDK_INT);
        ret.put("exactAlarmRelevant", Build.VERSION.SDK_INT >= Build.VERSION_CODES.S);
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
    public void openAppSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("opened", true);
            call.resolve(ret);
        } catch (Exception ex) {
            call.reject("アプリ設定を開けませんでした。", ex);
        }
    }

    @PluginMethod
    public void openLocationSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("opened", true);
            call.resolve(ret);
        } catch (Exception ex) {
            call.reject("位置情報設定を開けませんでした。", ex);
        }
    }
}
