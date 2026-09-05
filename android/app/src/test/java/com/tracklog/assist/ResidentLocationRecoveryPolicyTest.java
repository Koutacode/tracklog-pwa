package com.tracklog.assist;

import static org.junit.Assert.assertEquals;
import org.junit.Test;

public class ResidentLocationRecoveryPolicyTest {
    @Test
    public void runningServiceWaitsWhileLocationIsOffAndResumesWhenOn() {
        assertEquals(ResidentLocationRecoveryPolicy.Mode.RECORD, mode(true, true));
        assertEquals(ResidentLocationRecoveryPolicy.Mode.WAIT_FOR_LOCATION, mode(false, true));
        assertEquals(ResidentLocationRecoveryPolicy.Mode.RECORD, mode(true, true));
    }

    @Test
    public void coldStartWithLocationOffIsNotAuthorizedToStartForegroundService() {
        assertEquals(ResidentLocationRecoveryPolicy.Mode.STOP, mode(false, false));
        assertEquals(ResidentLocationRecoveryPolicy.Mode.RECORD, mode(true, false));
    }

    @Test
    public void revokingAnyPrerequisiteStopsEvenAnExistingWaitingService() {
        for (int missing = 0; missing < 4; missing++) {
            for (boolean locationEnabled : new boolean[] { false, true }) {
                assertEquals(ResidentLocationRecoveryPolicy.Mode.STOP,
                        ResidentLocationRecoveryPolicy.mode(
                                missing != 0, missing != 1, missing != 2, missing != 3,
                                locationEnabled, true));
            }
        }
    }

    private static ResidentLocationRecoveryPolicy.Mode mode(boolean locationEnabled, boolean running) {
        return ResidentLocationRecoveryPolicy.mode(true, true, true, true, locationEnabled, running);
    }
}
