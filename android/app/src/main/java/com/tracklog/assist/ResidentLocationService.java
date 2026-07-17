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
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

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
    private ExecutorService uploadExecutor;
    private final AtomicBoolean uploadInFlight = new AtomicBoolean(false);

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
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        locationThread = new HandlerThread("tracklog-resident-location");
        locationThread.start();
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
        String tripId = ResidentLocationState.getActiveTripId(this);
        if (!tripId.isEmpty() && ResidentLocationState.shouldRecordRouteAt(this, System.currentTimeMillis())) {
            try {
                ResidentLocationQueue.append(this, tripId, location);
            } catch (Exception exception) {
                Log.e(TAG, "Unable to persist resident location", exception);
            }
        }
        uploadLatestLocation(location);
    }

    private void uploadLatestLocation(Location location) {
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
                    handler.post(this::stopResidentService);
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
        if (uploadExecutor != null) {
            uploadExecutor.shutdownNow();
        }
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
