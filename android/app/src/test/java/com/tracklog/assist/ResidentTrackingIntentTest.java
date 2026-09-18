package com.tracklog.assist;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import org.junit.Test;

public class ResidentTrackingIntentTest {
    @Test
    public void trackingStopDoesNotWaitForAnInFlightAuthorizationRefresh() throws Exception {
        CountDownLatch authStarted = new CountDownLatch(1);
        CountDownLatch finishAuth = new CountDownLatch(1);
        ExecutorService workers = Executors.newFixedThreadPool(2);
        try {
            Future<?> auth = workers.submit(() -> {
                synchronized (ResidentLocationUploader.AUTHORIZATION_REFRESH_LOCK) {
                    authStarted.countDown();
                    try {
                        finishAuth.await();
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                    }
                }
            });
            assertTrue(authStarted.await(1L, TimeUnit.SECONDS));
            Future<Boolean> stop = workers.submit(() -> {
                long stopEpoch = ResidentLocationState.beginTrackingIntent();
                synchronized (ResidentLocationState.TRACKING_INTENT_LOCK) {
                    return ResidentLocationState.isCurrentTrackingIntent(stopEpoch);
                }
            });
            assertTrue(stop.get(1L, TimeUnit.SECONDS));
            assertFalse(auth.isDone());
        } finally {
            finishAuth.countDown();
            workers.shutdownNow();
            assertTrue(workers.awaitTermination(1L, TimeUnit.SECONDS));
        }
    }

    @Test
    public void newerTrackingStopInvalidatesOlderReconcileWithoutMutatingAuthEpoch() {
        long authEpoch = ResidentLocationUploader.currentAuthorizationMutationEpoch();
        long oldReconcile = ResidentLocationState.beginTrackingIntent();
        assertTrue(ResidentLocationState.isCurrentTrackingIntent(oldReconcile));
        long stop = ResidentLocationState.beginTrackingIntent();
        assertFalse(ResidentLocationState.isCurrentTrackingIntent(oldReconcile));
        assertTrue(ResidentLocationState.isCurrentTrackingIntent(stop));
        assertTrue(ResidentLocationUploader.isLatestAuthorizationMutation(authEpoch));
        long newTrip = ResidentLocationState.beginTrackingIntent();
        assertFalse(ResidentLocationState.isCurrentTrackingIntent(stop));
        assertTrue(ResidentLocationState.isCurrentTrackingIntent(newTrip));
    }
}
