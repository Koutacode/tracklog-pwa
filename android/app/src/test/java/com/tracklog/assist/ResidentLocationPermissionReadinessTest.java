package com.tracklog.assist;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.Manifest;
import android.app.Application;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowApplication;

/** Runtime permission state, with a synthetic application and no device location requests. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, manifest = Config.NONE)
public class ResidentLocationPermissionReadinessTest {
    @Test
    public void preciseLocationRevocationStopsRecordingUntilPermissionReturns() {
        Application app = RuntimeEnvironment.getApplication();
        ShadowApplication shadow = shadowOf(app);
        shadow.denyPermissions(Manifest.permission.ACCESS_FINE_LOCATION);
        assertFalse(ResidentLocationState.getReadiness(app).foregroundLocation);
        assertEquals(ResidentLocationRecoveryPolicy.Mode.STOP, mode(app));

        shadow.grantPermissions(Manifest.permission.ACCESS_FINE_LOCATION);
        assertTrue(ResidentLocationState.getReadiness(app).foregroundLocation);
        assertEquals(ResidentLocationRecoveryPolicy.Mode.RECORD, mode(app));

        shadow.denyPermissions(Manifest.permission.ACCESS_FINE_LOCATION);
        assertEquals(ResidentLocationRecoveryPolicy.Mode.STOP, mode(app));
    }

    private static ResidentLocationRecoveryPolicy.Mode mode(Application app) {
        return ResidentLocationRecoveryPolicy.mode(true,
                ResidentLocationState.getReadiness(app).foregroundLocation,
                true, true, true, true);
    }
}
