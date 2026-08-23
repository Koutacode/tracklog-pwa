package com.tracklog.assist;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class AppUpdatePluginTest {
    @Test
    public void onlyStableLatestApkUrlIsAccepted() {
        assertTrue(AppUpdatePlugin.isAllowedUpdateUrl(AppUpdatePlugin.LATEST_APK_DOWNLOAD_URL));
        assertFalse(AppUpdatePlugin.isAllowedUpdateUrl(
            "https://github.com/Koutacode/tracklog-pwa/releases/download/v0.1.48/tracklog-assist-debug.apk"
        ));
        assertFalse(AppUpdatePlugin.isAllowedUpdateUrl(
            "https://github.com/Koutacode/tracklog-pwa/releases/latest/download/another.apk"
        ));
    }
}
