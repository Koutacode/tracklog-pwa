package com.tracklog.assist;

import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "DeviceIdentity")
public class DeviceIdentityPlugin extends Plugin {
    @PluginMethod
    public void getStableDeviceKey(PluginCall call) {
        final String androidId = Settings.Secure.getString(
            getContext().getContentResolver(),
            Settings.Secure.ANDROID_ID
        );
        if (androidId == null || androidId.trim().isEmpty()) {
            call.reject("ANDROID_ID を取得できませんでした。");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("stableDeviceKey", androidId.trim());
        ret.put("source", "android_id");
        call.resolve(ret);
    }
}
