package com.tracklog.assist;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeSetupPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
