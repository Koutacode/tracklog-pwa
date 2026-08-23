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
        // Never close the prompt before the durable decision commit succeeds. A process restart or
        // transient storage failure therefore leaves the action recoverable instead of losing it.
        if (shouldCloseNotification(result.stored)) {
            ResidentExpresswayNotification.cancel(context);
            ResidentLocationService.startIfEligible(context);
        }
    }

    static boolean shouldCloseNotification(boolean durableDecisionStored) {
        return durableDecisionStored;
    }
}
