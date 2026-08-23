package com.tracklog.assist;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.UUID;

public final class ResidentLocationService extends Service implements LocationListener {
    static final String NOTIFICATION_TEXT = "位置記録中";
    static final String CHANNEL_ID = "tracklog_resident_location";
    static final int NOTIFICATION_ID = 41139;
    private static final String TAG = "ResidentLocation";
    private static final long MIN_TIME_MS = 10_000L;
    static final float MIN_DISTANCE_METERS = 0f;
    private static final long READINESS_CHECK_MS = 60_000L;
    private static final AtomicBoolean RUNNING = new AtomicBoolean(false);

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable expresswayProbeRetryCheck = this::scheduleDueExpresswayProbe;
    private final Runnable queueIdleSeal = () -> ResidentLocationQueue.sealActiveIfIdle(
            this,
            System.currentTimeMillis()
    );
    private final Runnable readinessCheck = new Runnable() {
        @Override
        public void run() {
            if (!canRun()) {
                stopResidentService();
                return;
            }
            handler.postDelayed(this, READINESS_CHECK_MS);
        }
    };
    private LocationManager locationManager;
    private HandlerThread locationThread;
    private Handler locationHandler;
    private ExecutorService uploadExecutor;
    private final AtomicBoolean uploadInFlight = new AtomicBoolean(false);
    private final AtomicBoolean expresswayProbeInFlight = new AtomicBoolean(false);
    private final String monotonicLocationSessionId = UUID.randomUUID().toString();
    private ResidentLocationQualityPolicy.Fix lastAcceptedFix;
    private ResidentExpresswayDetectionPolicy.State expresswayDetectionState;
    private long expresswayDetectionRevision = -1L;

    static boolean isRunning() {
        return RUNNING.get();
    }

    static boolean startIfEligible(Context context) {
        Context appContext = context.getApplicationContext();
        if (!ResidentLocationState.isEligible(appContext)
                || !ResidentLocationState.getReadiness(appContext).isReady()) {
            stop(appContext);
            return false;
        }
        try {
            ContextCompat.startForegroundService(
                    appContext,
                    new Intent(appContext, ResidentLocationService.class)
            );
            return true;
        } catch (RuntimeException exception) {
            Log.e(TAG, "Unable to start resident location service", exception);
            return false;
        }
    }

    static void stop(Context context) {
        context.getApplicationContext().stopService(
                new Intent(context.getApplicationContext(), ResidentLocationService.class)
        );
    }

    @Override
    public void onCreate() {
        super.onCreate();
        ResidentLocationState.resetLocationQualitySession(this, System.currentTimeMillis());
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        locationThread = new HandlerThread("tracklog-resident-location");
        locationThread.start();
        locationHandler = new Handler(locationThread.getLooper());
        uploadExecutor = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "tracklog-location-upload");
            thread.setDaemon(true);
            return thread;
        });
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!canRun()) {
            stopResidentService();
            return START_NOT_STICKY;
        }

        try {
            promoteToForeground();
            requestLocationUpdates();
            ResidentExpresswayNotification.restoreIfPending(this);
            scheduleDueExpresswayProbe();
            RUNNING.set(true);
            handler.removeCallbacks(readinessCheck);
            handler.postDelayed(readinessCheck, READINESS_CHECK_MS);
            return START_STICKY;
        } catch (SecurityException | IllegalStateException exception) {
            Log.e(TAG, "Resident location prerequisites changed", exception);
            stopResidentService();
            return START_NOT_STICKY;
        }
    }

    private boolean canRun() {
        return ResidentLocationState.isEligible(this)
                && ResidentLocationState.getReadiness(this).isReady();
    }

    private void promoteToForeground() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    NOTIFICATION_TEXT,
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription(null);
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }

        Intent launchIntent = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this,
                0,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(NOTIFICATION_TEXT)
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
                : 0;
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type);
    }

    private void requestLocationUpdates() {
        if (locationManager == null) {
            throw new IllegalStateException("位置情報サービスを利用できません。");
        }
        locationManager.removeUpdates(this);
        if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
            locationManager.requestLocationUpdates(
                    LocationManager.GPS_PROVIDER,
                    MIN_TIME_MS,
                    MIN_DISTANCE_METERS,
                    this,
                    locationThread.getLooper()
            );
        }
        if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
            locationManager.requestLocationUpdates(
                    LocationManager.NETWORK_PROVIDER,
                    MIN_TIME_MS,
                    MIN_DISTANCE_METERS,
                    this,
                    locationThread.getLooper()
            );
        }
    }

    @Override
    public void onLocationChanged(Location location) {
        if (!canRun()) {
            stopResidentService();
            return;
        }
        long now = System.currentTimeMillis();
        long nowElapsedRealtimeNanos = SystemClock.elapsedRealtimeNanos();
        ResidentLocationQualityPolicy.Fix candidate = new ResidentLocationQualityPolicy.Fix(
                location.getLatitude(),
                location.getLongitude(),
                location.getTime(),
                location.getElapsedRealtimeNanos(),
                location.hasAccuracy(),
                location.hasAccuracy() ? location.getAccuracy() : 0f,
                location.getProvider()
        );
        ResidentLocationQualityPolicy.Decision quality =
                ResidentLocationQualityPolicy.evaluate(
                        lastAcceptedFix,
                        candidate,
                        now,
                        nowElapsedRealtimeNanos
                );
        if (!quality.accepted) {
            ResidentLocationState.markLocationRejected(this, quality.rejection);
            return;
        }
        ResidentLocationState.markLocationAccepted(this, now);

        String tripId = ResidentLocationState.getActiveTripId(this);
        boolean queueWriteSucceeded = true;
        boolean routeShouldRecord = !tripId.isEmpty()
                && ResidentLocationState.shouldRecordRouteAt(this, now);
        if (routeShouldRecord) {
            try {
                ResidentLocationQueue.append(this, tripId, location, monotonicLocationSessionId);
                ResidentLocationState.markQueueWriteSuccess(this, now);
                handler.removeCallbacks(queueIdleSeal);
                handler.postDelayed(queueIdleSeal, ResidentLocationQueue.ACTIVE_IDLE_SEAL_MS);
            } catch (Exception exception) {
                queueWriteSucceeded = false;
                ResidentLocationState.markQueueWriteFailure(this, now);
                Log.e(TAG, "Unable to persist resident location", exception);
            }
        }
        if (queueWriteSucceeded) lastAcceptedFix = candidate;
        if (routeShouldRecord && queueWriteSucceeded) {
            advanceExpresswayDetection(location, tripId);
        }
        uploadLatestLocation(location);
    }

    private void advanceExpresswayDetection(Location location, String tripId) {
        ResidentExpresswayStore.Snapshot nativeState = ResidentExpresswayStore.snapshot(this);
        if (!nativeState.storageHealthy
                || nativeState.paused
                || !tripId.equals(nativeState.tripId)) {
            expresswayDetectionState = null;
            expresswayDetectionRevision = -1L;
            return;
        }
        if (expresswayDetectionState == null
                || !tripId.equals(expresswayDetectionState.tripId)
                || expresswayDetectionRevision != nativeState.revision) {
            expresswayDetectionState = new ResidentExpresswayDetectionPolicy.State(tripId);
            expresswayDetectionState.keepSuppressed = nativeState.keepSuppressed;
            expresswayDetectionRevision = nativeState.revision;
        }
        long elapsedRealtimeNanos = location.getElapsedRealtimeNanos();
        long elapsedRealtimeMs = elapsedRealtimeNanos > 0L
                ? elapsedRealtimeNanos / 1_000_000L
                : -1L;
        ResidentExpresswayDetectionPolicy.Point point =
                new ResidentExpresswayDetectionPolicy.Point(
                        tripId,
                        location.getTime(),
                        elapsedRealtimeMs >= 0L ? monotonicLocationSessionId : "",
                        elapsedRealtimeMs,
                        location.hasAccuracy(),
                        location.hasAccuracy() ? location.getAccuracy() : 0d,
                        location.hasSpeed(),
                        location.hasSpeed() ? location.getSpeed() : 0d
                );
        ResidentExpresswayDetectionPolicy.Result result =
                ResidentExpresswayDetectionPolicy.advance(
                        expresswayDetectionState,
                        point,
                        nativeState.config,
                        nativeState.open,
                        !nativeState.promptId.isEmpty()
                );
        expresswayDetectionState = result.state;
        if (result.effect.kind == ResidentExpresswayDetectionPolicy.EffectKind.CLEAR_KEEP) {
            if (ResidentExpresswayStore.clearKeepSuppression(
                    this,
                    tripId,
                    nativeState.revision
            )) {
                expresswayDetectionRevision = ResidentExpresswayStore.snapshot(this).revision;
                expresswayDetectionState = null;
            }
            return;
        }
        if (result.effect.kind != ResidentExpresswayDetectionPolicy.EffectKind.PROBE_START
                && result.effect.kind != ResidentExpresswayDetectionPolicy.EffectKind.PROBE_END) {
            return;
        }
        ResidentExpresswayStore.Probe probe = ResidentExpresswayStore.createProbe(
                this,
                result.effect.kind == ResidentExpresswayDetectionPolicy.EffectKind.PROBE_START
                        ? ResidentExpresswayStore.ProbeKind.START
                        : ResidentExpresswayStore.ProbeKind.END,
                tripId,
                ResidentLocationQueue.toIsoTimestamp(location.getTime()),
                location.getTime(),
                location.getLatitude(),
                location.getLongitude(),
                location.hasAccuracy() ? (double) location.getAccuracy() : null,
                result.effect.speedKmh,
                result.effect.accelerationMs2,
                result.effect.lowSpeedElapsedMs,
                elapsedRealtimeMs >= 0L ? monotonicLocationSessionId : "",
                elapsedRealtimeMs
        );
        if (probe != null) scheduleDueExpresswayProbe();
    }

    private void scheduleDueExpresswayProbe() {
        handler.removeCallbacks(expresswayProbeRetryCheck);
        if (uploadExecutor == null || uploadExecutor.isShutdown()) return;
        ResidentExpresswayStore.Probe probe = ResidentExpresswayStore.dueProbe(
                this,
                System.currentTimeMillis()
        );
        if (probe == null || !expresswayProbeInFlight.compareAndSet(false, true)) return;
        uploadExecutor.execute(() -> {
            ResidentLocationUploader.ExpresswayProbeResult result =
                    ResidentLocationUploader.probeExpresswaySignal(this, probe);
            Handler callbackHandler = locationHandler;
            if (callbackHandler == null) {
                expresswayProbeInFlight.set(false);
                return;
            }
            callbackHandler.post(() -> handleExpresswayProbeResult(probe, result));
        });
    }

    private void handleExpresswayProbeResult(
            ResidentExpresswayStore.Probe probe,
            ResidentLocationUploader.ExpresswayProbeResult result
    ) {
        try {
            if (result.outcome != ResidentLocationUploader.ExpresswayProbeOutcome.SIGNAL
                    || result.signal == null) {
                ResidentExpresswayStore.markProbeFailure(
                        this,
                        probe.id,
                        probeFailureCategory(result.outcome),
                        System.currentTimeMillis()
                );
                scheduleNextExpresswayProbeRetry();
                return;
            }
            ResidentExpresswayStore.Snapshot current = ResidentExpresswayStore.snapshot(this);
            if (current.pendingProbe == null
                    || !probe.id.equals(current.pendingProbe.id)
                    || !ResidentExpresswayStore.canApplyProbe(
                            probe.tripId,
                            probe.expectedRevision,
                            current.tripId,
                            current.revision
                    )) {
                return;
            }
            if (probe.kind == ResidentExpresswayStore.ProbeKind.START) {
                if (expresswayDetectionState == null
                        || !probe.tripId.equals(expresswayDetectionState.tripId)) {
                    ResidentExpresswayStore.clearProbe(this, probe.id);
                    return;
                }
                ResidentExpresswayDetectionPolicy.StartSignalResult signalResult =
                        ResidentExpresswayDetectionPolicy.applyStartSignal(
                                expresswayDetectionState,
                                probe.elapsedRealtimeMs >= 0L
                                        ? probe.elapsedRealtimeMs
                                        : probe.detectedAtMs,
                                result.signal.policySignal
                        );
                expresswayDetectionState = signalResult.state;
                if (!signalResult.shouldStart) {
                    ResidentExpresswayStore.clearProbe(this, probe.id);
                    return;
                }
                if (ResidentExpresswayStore.commitStart(
                        this,
                        probe.id,
                        result.signal,
                        signalResult.hits,
                        signalResult.holdMs
                )) {
                    expresswayDetectionState = ResidentExpresswayDetectionPolicy.afterTransition(
                            expresswayDetectionState,
                            false
                    );
                    expresswayDetectionRevision = ResidentExpresswayStore.snapshot(this).revision;
                } else {
                    ResidentExpresswayStore.markProbeFailure(
                            this,
                            probe.id,
                            "response",
                            System.currentTimeMillis()
                    );
                    scheduleNextExpresswayProbeRetry();
                }
                return;
            }
            if (!ResidentExpresswayDetectionPolicy.shouldPromptForEnd(
                    result.signal.policySignal,
                    probe.lowSpeedElapsedMs
            )) {
                ResidentExpresswayStore.clearProbe(this, probe.id);
                return;
            }
            String promptId = ResidentExpresswayStore.commitEndPrompt(
                    this,
                    probe.id,
                    result.signal
            );
            if (!promptId.isEmpty()) {
                expresswayDetectionState = ResidentExpresswayDetectionPolicy.afterTransition(
                        expresswayDetectionState,
                        false
                );
                expresswayDetectionRevision = ResidentExpresswayStore.snapshot(this).revision;
                handler.post(() -> ResidentExpresswayNotification.show(this, promptId));
            } else {
                ResidentExpresswayStore.markProbeFailure(
                        this,
                        probe.id,
                        "response",
                        System.currentTimeMillis()
                );
                scheduleNextExpresswayProbeRetry();
            }
        } finally {
            expresswayProbeInFlight.set(false);
        }
    }

    private void scheduleNextExpresswayProbeRetry() {
        ResidentExpresswayStore.Snapshot snapshot = ResidentExpresswayStore.snapshot(this);
        if (snapshot.pendingProbe == null) return;
        long now = System.currentTimeMillis();
        long delay = Math.max(1_000L, snapshot.pendingProbe.retryAfterAtMs - now);
        delay = Math.min(delay, ResidentExpresswayStore.PROBE_RETRY_MAX_MS);
        handler.removeCallbacks(expresswayProbeRetryCheck);
        handler.postDelayed(expresswayProbeRetryCheck, delay);
    }

    private static String probeFailureCategory(
            ResidentLocationUploader.ExpresswayProbeOutcome outcome
    ) {
        if (outcome == ResidentLocationUploader.ExpresswayProbeOutcome.AUTHORIZATION_RETRY) {
            return "authorization";
        }
        if (outcome == ResidentLocationUploader.ExpresswayProbeOutcome.NETWORK_RETRY) {
            return "network";
        }
        if (outcome == ResidentLocationUploader.ExpresswayProbeOutcome.SERVER_RETRY) {
            return "server";
        }
        return "response";
    }

    private void uploadLatestLocation(Location location) {
        ResidentLocationState.Authorization authorization =
                ResidentLocationState.getAuthorization(this);
        if (!ResidentLocationState.isUploadAllowedState(
                authorization.isConfigured(),
                ResidentLocationState.isAuthorizationBlocked(this)
        )) return;
        long now = System.currentTimeMillis();
        if (!ResidentLocationUploadPolicy.shouldAttempt(
                now,
                ResidentLocationState.getLastUploadAttemptAt(this)
        )) return;
        if (!uploadInFlight.compareAndSet(false, true)) return;
        ResidentLocationState.markUploadAttempt(this, now);
        Location snapshot = new Location(location);
        uploadExecutor.execute(() -> {
            try {
                ResidentLocationUploader.Outcome outcome = ResidentLocationUploader.upload(this, snapshot);
                if (outcome == ResidentLocationUploader.Outcome.SUCCESS) {
                    ResidentLocationState.markUploadSuccess(this, System.currentTimeMillis());
                } else if (outcome == ResidentLocationUploader.Outcome.STOPPED_AUTHORIZATION) {
                    handler.post(() -> {
                        if (!ResidentLocationState.isEligible(this)) {
                            stopResidentService();
                        }
                    });
                }
            } finally {
                uploadInFlight.set(false);
            }
        });
    }

    @Override
    public void onProviderDisabled(String provider) {
        if (!ResidentLocationState.getReadiness(this).locationEnabled) {
            stopResidentService();
        }
    }

    @Override
    public void onProviderEnabled(String provider) {}

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {}

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(readinessCheck);
        handler.removeCallbacks(expresswayProbeRetryCheck);
        handler.removeCallbacks(queueIdleSeal);
        if (locationManager != null) {
            try {
                locationManager.removeUpdates(this);
            } catch (SecurityException ignored) {
                // Permissions can be revoked while the service is stopping.
            }
        }
        RUNNING.set(false);
        if (locationThread != null) {
            locationThread.quitSafely();
        }
        locationHandler = null;
        if (uploadExecutor != null) {
            uploadExecutor.shutdownNow();
        }
        ResidentLocationQueue.sealActive(this);
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    private void stopResidentService() {
        handler.removeCallbacks(readinessCheck);
        RUNNING.set(false);
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }
}
