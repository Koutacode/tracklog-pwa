package com.tracklog.assist;

import android.content.Context;
import androidx.core.app.NotificationManagerCompat;

final class ResidentExpresswayNotification {
    static final String OWNER = "resident-service";
    static final String CHANNEL_ID = "tracklog_expressway_confirmation";
    static final int NOTIFICATION_ID = 41140;
    static final String EXTRA_OWNER = "owner";
    static final String EXTRA_PROMPT_ID = "promptId";
    static final String ACTION_END = "com.tracklog.assist.EXPRESSWAY_END";
    static final String ACTION_KEEP = "com.tracklog.assist.EXPRESSWAY_KEEP";

    private ResidentExpresswayNotification() {}

    static void show(Context context, String promptId) {
        // Keep the persisted prompt for the in-app dialog, but retire the old system notification.
        cancel(context);
    }

    static void restoreIfPending(Context context) {
        String promptId = ResidentExpresswayStore.freshPromptIdForNotification(
                context, System.currentTimeMillis());
        if (!promptId.isEmpty()) show(context, promptId);
        else cancel(context);
    }

    static void cancel(Context context) {
        NotificationManagerCompat.from(context.getApplicationContext()).cancel(NOTIFICATION_ID);
    }

}
