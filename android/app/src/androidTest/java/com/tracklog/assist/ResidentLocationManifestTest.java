package com.tracklog.assist;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.ComponentName;
import android.content.Context;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class ResidentLocationManifestTest {
    @Test
    public void residentServiceIsPrivateLocationForegroundService() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        ServiceInfo service = context.getPackageManager().getServiceInfo(
                new ComponentName(context, ResidentLocationService.class),
                PackageManager.GET_META_DATA
        );

        assertFalse(service.exported);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            assertTrue((service.getForegroundServiceType() & ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION) != 0);
        }
    }

    @Test
    public void bootReceiverIsPrivateAndEnabled() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        PackageManager packageManager = context.getPackageManager();
        ActivityInfo receiver = packageManager.getReceiverInfo(
                new ComponentName(context, ResidentLocationBootReceiver.class),
                PackageManager.GET_META_DATA
        );
        assertFalse(receiver.exported);
        assertTrue(receiver.enabled);
    }

    @Test
    public void dependencyBackgroundLocationServiceIsNotExported() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        ServiceInfo service = context.getPackageManager().getServiceInfo(
                new ComponentName(
                        context.getPackageName(),
                        "com.equimaps.capacitor_background_geolocation.BackgroundGeolocationService"
                ),
                PackageManager.GET_META_DATA
        );

        assertNotNull(service);
        assertFalse(service.exported);
    }

    @Test
    public void appBackupIsDisabled() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        ApplicationInfo app = context.getPackageManager().getApplicationInfo(context.getPackageName(), 0);
        assertFalse((app.flags & ApplicationInfo.FLAG_ALLOW_BACKUP) != 0);
    }

    @Test
    public void approvedConfiguredDeviceIsEligibleWithoutActiveTripAndAuthCanBeCleared() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        ResidentLocationState.preferences(context).edit().clear().commit();
        ResidentLocationState.reconcile(
                context,
                true,
                true,
                "",
                "https://example.supabase.co",
                "anon-key",
                "access-token",
                "refresh-token",
                "android:test-device"
        );
        assertTrue(ResidentLocationState.isEligible(context));
        assertEquals("", ResidentLocationState.getActiveTripId(context));

        ResidentLocationState.clearAuthorizationAndDisable(context);
        assertFalse(ResidentLocationState.isEligible(context));
        assertFalse(ResidentLocationState.getAuthorization(context).isConfigured());
        assertTrue(ResidentLocationState.isAuthorizationBlocked(context));

        ResidentLocationState.reconcile(
                context,
                true,
                true,
                "",
                "https://example.supabase.co",
                "anon-key",
                "access-token",
                "refresh-token",
                "android:test-device"
        );
        assertFalse(ResidentLocationState.isEligible(context));

        ResidentLocationState.reconcile(
                context,
                true,
                true,
                "",
                "https://example.supabase.co",
                "anon-key",
                "new-access-token",
                "new-refresh-token",
                "android:test-device"
        );
        assertTrue(ResidentLocationState.isEligible(context));
        assertFalse(ResidentLocationState.isAuthorizationBlocked(context));
        ResidentLocationState.stop(context, true, true);
    }
}
