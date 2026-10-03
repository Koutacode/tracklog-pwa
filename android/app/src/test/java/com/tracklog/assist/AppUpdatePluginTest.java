package com.tracklog.assist;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class AppUpdatePluginTest {
    @Test
    public void onlyStableLatestApkUrlIsAccepted() {
        assertTrue(AppUpdatePlugin.isAllowedUpdateUrl(AppUpdatePlugin.LATEST_APK_DOWNLOAD_URL));
        assertTrue(AppUpdatePlugin.isAllowedUpdateUrl(AppUpdatePlugin.LEGACY_APK_DOWNLOAD_URL));
        assertFalse(AppUpdatePlugin.isAllowedUpdateUrl(null));
        for (String suffix : new String[] { "?token=secret", "#fragment", "/", ".exe" }) {
            assertFalse(AppUpdatePlugin.isAllowedUpdateUrl(AppUpdatePlugin.LATEST_APK_DOWNLOAD_URL + suffix));
        }
        assertFalse(AppUpdatePlugin.isAllowedUpdateUrl(AppUpdatePlugin.LATEST_APK_DOWNLOAD_URL.replace("https:", "http:")));
        assertFalse(AppUpdatePlugin.isAllowedUpdateUrl(AppUpdatePlugin.LATEST_APK_DOWNLOAD_URL.replace("github.com", "github.com.evil.invalid")));
        assertFalse(AppUpdatePlugin.isAllowedUpdateUrl(AppUpdatePlugin.LATEST_APK_DOWNLOAD_URL.replace("tracklog-releases", "another-repo")));
        assertFalse(AppUpdatePlugin.isAllowedUpdateUrl(
            "https://github.com/Koutacode/tracklog-pwa/releases/download/v0.1.48/tracklog-assist-debug.apk"
        ));
        assertFalse(AppUpdatePlugin.isAllowedUpdateUrl(
            "https://github.com/Koutacode/tracklog-pwa/releases/latest/download/another.apk"
        ));
    }
}
