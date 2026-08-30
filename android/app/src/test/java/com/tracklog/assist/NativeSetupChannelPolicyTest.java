package com.tracklog.assist;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class NativeSetupChannelPolicyTest {
    @Test
    public void disabledOrMissingChannelIsNotReadyWhenChannelsAreSupported() {
        assertFalse(NativeSetupChannelPolicy.isEnabled(true, true, true));
        assertFalse(NativeSetupChannelPolicy.isEnabled(true, false, false));
        assertTrue(NativeSetupChannelPolicy.isEnabled(true, true, false));
    }

    @Test
    public void preAndroid8DoesNotRequireAChannel() {
        assertTrue(NativeSetupChannelPolicy.isEnabled(false, false, true));
    }
}
