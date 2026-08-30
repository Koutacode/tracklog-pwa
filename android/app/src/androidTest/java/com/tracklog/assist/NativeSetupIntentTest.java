package com.tracklog.assist;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import android.content.Context;
import android.content.Intent;
import android.app.NotificationManager;
import android.os.Build;
import android.provider.Settings;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import com.getcapacitor.annotation.CapacitorPlugin;

import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class NativeSetupIntentTest {
    @Test
    public void setupDestinationsUsePublicAndroidSettingsIntents() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();

        Intent location = NativeSetupPlugin.locationSettingsIntent();
        assertEquals(Settings.ACTION_LOCATION_SOURCE_SETTINGS, location.getAction());

        Intent appDetails = NativeSetupPlugin.appDetailsIntent(context);
        assertEquals(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, appDetails.getAction());
        assertEquals("package:" + context.getPackageName(), appDetails.getDataString());

        Intent notifications = NativeSetupPlugin.notificationSettingsIntent(context);
        assertEquals(Settings.ACTION_APP_NOTIFICATION_SETTINGS, notifications.getAction());
        assertEquals(context.getPackageName(), notifications.getStringExtra(Settings.EXTRA_APP_PACKAGE));

        Intent residentNotifications = NativeSetupPlugin.residentNotificationSettingsIntent(context);
        assertEquals(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS, residentNotifications.getAction());
        assertEquals(context.getPackageName(), residentNotifications.getStringExtra(Settings.EXTRA_APP_PACKAGE));
        assertEquals(
                ResidentLocationService.CHANNEL_ID,
                residentNotifications.getStringExtra(Settings.EXTRA_CHANNEL_ID)
        );
    }

    @Test
    public void android10BackgroundAliasRequestsOnlyBackgroundPermission() {
        CapacitorPlugin annotation = NativeSetupPlugin.class.getAnnotation(CapacitorPlugin.class);
        assertEquals(1, annotation.permissions().length);
        assertEquals("backgroundLocation", annotation.permissions()[0].alias());
        assertEquals(1, annotation.permissions()[0].strings().length);
        assertEquals(
                "android.permission.ACCESS_BACKGROUND_LOCATION",
                annotation.permissions()[0].strings()[0]
        );
    }

    @Test
    public void backgroundPermissionOptionLabelAlwaysHasSafeText() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertFalse(NativeSetupPlugin.backgroundPermissionOptionLabel(context).trim().isEmpty());
    }

    @Test
    public void disabledResidentNotificationChannelIsNotReadyOnAndroid8Plus() {
        assertFalse(NativeSetupPlugin.isResidentNotificationChannelEnabled(
                Build.VERSION_CODES.O,
                true,
                NotificationManager.IMPORTANCE_NONE
        ));
        assertFalse(NativeSetupPlugin.isResidentNotificationChannelEnabled(
                Build.VERSION_CODES.O,
                false,
                NotificationManager.IMPORTANCE_LOW
        ));
        assertEquals(true, NativeSetupPlugin.isResidentNotificationChannelEnabled(
                Build.VERSION_CODES.O,
                true,
                NotificationManager.IMPORTANCE_LOW
        ));
        assertEquals(true, NativeSetupPlugin.isResidentNotificationChannelEnabled(
                Build.VERSION_CODES.N_MR1,
                false,
                NotificationManager.IMPORTANCE_NONE
        ));
    }
}
