package com.tracklog.assist;

final class NativeSetupChannelPolicy {
    private NativeSetupChannelPolicy() {}

    static boolean isEnabled(
            boolean notificationChannelsSupported,
            boolean channelExists,
            boolean channelBlocked
    ) {
        return !notificationChannelsSupported || (channelExists && !channelBlocked);
    }
}
