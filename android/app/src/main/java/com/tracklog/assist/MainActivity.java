package com.tracklog.assist;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AppSharePlugin.class);
        registerPlugin(DeviceIdentityPlugin.class);
        registerPlugin(NativeSetupPlugin.class);
        // Avoid restoring a stale WebView session after APK updates. Restoring
        // prior state can keep an old JS bundle alive and leave the app on a
        // blank screen even when newer assets are bundled in the APK.
        super.onCreate(null);
    }
}
