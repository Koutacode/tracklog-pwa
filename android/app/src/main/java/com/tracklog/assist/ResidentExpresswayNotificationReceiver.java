package com.tracklog.assist;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Receives expressway notification actions even while the Capacitor WebView is not running. */
public final class ResidentExpresswayNotificationReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null
                || !ResidentExpresswayNotification.OWNER.equals(
                        intent.getStringExtra(ResidentExpresswayNotification.EXTRA_OWNER)
                )) {
            return;
        }
        String action = intent.getAction();
        boolean end;
        if (ResidentExpresswayNotification.ACTION_END.equals(action)) {
            end = true;
        } else if (ResidentExpresswayNotification.ACTION_KEEP.equals(action)) {
            end = false;
        } else {
            return;
        }
        String promptId = intent.getStringExtra(ResidentExpresswayNotification.EXTRA_PROMPT_ID);
        ResidentExpresswayStore.DecisionResult result = ResidentExpresswayStore.recordDecision(
                context.getApplicationContext(),
                promptId,
                end,
                System.currentTimeMillis()
        );
        // Close only after a durable decision or durable expiry. Storage failure leaves
        // the action recoverable after a process restart.
        if (shouldCloseNotification(result.stored || result.expired)) {
            ResidentExpresswayNotification.restoreIfPending(context);
            ResidentLocationService.startIfEligible(context);
        }
    }

    static boolean shouldCloseNotification(boolean durableActionResolved) {
        return durableActionResolved;
    }
}
