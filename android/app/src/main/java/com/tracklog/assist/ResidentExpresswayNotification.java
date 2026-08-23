package com.tracklog.assist;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;

import androidx.core.app.NotificationCompat;
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
        String normalizedPromptId = promptId == null ? "" : promptId.trim();
        if (normalizedPromptId.isEmpty()) return;
        Context appContext = context.getApplicationContext();
        ensureChannel(appContext);

        Intent launchIntent = new Intent(appContext, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(EXTRA_OWNER, OWNER)
                .putExtra(EXTRA_PROMPT_ID, normalizedPromptId);
        PendingIntent contentIntent = PendingIntent.getActivity(
                appContext,
                NOTIFICATION_ID,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        Bundle extras = new Bundle();
        extras.putString(EXTRA_OWNER, OWNER);
        extras.putString(EXTRA_PROMPT_ID, normalizedPromptId);

        Notification notification = new NotificationCompat.Builder(appContext, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("高速道路を降りましたか？")
                .setContentText("終了した場合は「終了」、走行中なら「継続」を選んでください。")
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .setAutoCancel(false)
                .setOnlyAlertOnce(true)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .addExtras(extras)
                .addAction(0, "終了", actionIntent(appContext, normalizedPromptId, true))
                .addAction(0, "継続", actionIntent(appContext, normalizedPromptId, false))
                .build();
        try {
            NotificationManagerCompat.from(appContext).notify(NOTIFICATION_ID, notification);
        } catch (SecurityException ignored) {
            // POST_NOTIFICATIONS is a hard readiness requirement on Android 13+, but it may be
            // revoked between the location callback and this notification call.
        }
    }

    static void restoreIfPending(Context context) {
        ResidentExpresswayStore.Snapshot snapshot = ResidentExpresswayStore.snapshot(context);
        if (snapshot.storageHealthy && !snapshot.promptId.isEmpty()) {
            show(context, snapshot.promptId);
        }
    }

    static void cancel(Context context) {
        NotificationManagerCompat.from(context.getApplicationContext()).cancel(NOTIFICATION_ID);
    }

    private static PendingIntent actionIntent(Context context, String promptId, boolean end) {
        Intent intent = new Intent(context, ResidentExpresswayNotificationReceiver.class)
                .setAction(end ? ACTION_END : ACTION_KEEP)
                .putExtra(EXTRA_OWNER, OWNER)
                .putExtra(EXTRA_PROMPT_ID, promptId);
        int actionOffset = end ? 1 : 2;
        int requestCode = 41_140_000 + Math.floorMod(promptId.hashCode() * 31 + actionOffset, 100_000);
        return PendingIntent.getBroadcast(
                context,
                requestCode,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(
                Context.NOTIFICATION_SERVICE
        );
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "高速道路の終了確認",
                NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("高速道路の終了または継続を確認します");
        channel.setShowBadge(true);
        manager.createNotificationChannel(channel);
    }
}
