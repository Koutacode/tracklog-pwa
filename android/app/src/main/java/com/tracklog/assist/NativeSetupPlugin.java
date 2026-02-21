package com.tracklog.assist;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeSetup")
public class NativeSetupPlugin extends Plugin {
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
}
