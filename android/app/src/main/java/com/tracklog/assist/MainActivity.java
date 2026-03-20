package com.tracklog.assist;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AppSharePlugin.class);
        registerPlugin(NativeSetupPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
