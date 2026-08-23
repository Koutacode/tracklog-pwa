package com.tracklog.assist;

import android.content.Context;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ResidentLocation")
public final class ResidentLocationPlugin extends Plugin {
    @PluginMethod
    public void reconcile(PluginCall call) {
        long requestEpoch = ResidentLocationUploader.currentAuthorizationMutationEpoch();
        boolean approved = Boolean.TRUE.equals(call.getBoolean("approved", false));
        boolean setupComplete = Boolean.TRUE.equals(call.getBoolean("setupComplete", false));
        String activeTripId = call.getString("activeTripId", "");
        long routePauseAtMs = Math.max(0L, call.getLong("routePauseAtMs", 0L));
        boolean expresswayOpen = Boolean.TRUE.equals(call.getBoolean("expresswayOpen", false));
        JSObject rawExpresswayConfig = call.getObject("expresswayConfig", new JSObject());
        ResidentExpresswayDetectionPolicy.Config expresswayConfig =
                new ResidentExpresswayDetectionPolicy.Config(
                        rawExpresswayConfig.optDouble("speedKmh", 78d),
                        rawExpresswayConfig.optLong("durationSec", 6L),
                        rawExpresswayConfig.optDouble("endSpeedKmh", 34d),
                        rawExpresswayConfig.optLong("endDurationSec", 24L)
                );
        Context appContext = getContext().getApplicationContext();
        getBridge().execute(() -> {
            boolean startRequested = false;
            synchronized (ResidentLocationUploader.AUTHORIZATION_REFRESH_LOCK) {
                if (ResidentLocationUploader.isLatestAuthorizationMutation(requestEpoch)) {
                    ResidentLocationState.reconcile(
                            appContext,
                            approved,
                            setupComplete,
                            activeTripId,
                            routePauseAtMs
                    );
                    ResidentExpresswayStore.reconcile(
                            appContext,
                            activeTripId,
                            expresswayOpen,
                            expresswayConfig
                    );
                    reconcileExpresswayNotification(appContext);
                    startRequested = ResidentLocationService.startIfEligible(appContext);
                }
            }
            call.resolve(buildStatus(startRequested));
        });
    }

    @PluginMethod
    public void applyTrackingState(PluginCall call) {
        String activeTripId = call.getString("activeTripId", "");
        long routePauseAtMs = Math.max(0L, call.getLong("routePauseAtMs", 0L));
        boolean expresswayOpen = Boolean.TRUE.equals(call.getBoolean("expresswayOpen", false));
        JSObject rawExpresswayConfig = call.getObject("expresswayConfig", new JSObject());
        ResidentExpresswayDetectionPolicy.Config expresswayConfig =
                new ResidentExpresswayDetectionPolicy.Config(
                        rawExpresswayConfig.optDouble("speedKmh", 78d),
                        rawExpresswayConfig.optLong("durationSec", 6L),
                        rawExpresswayConfig.optDouble("endSpeedKmh", 34d),
                        rawExpresswayConfig.optLong("endDurationSec", 24L)
                );
        Context appContext = getContext().getApplicationContext();
        getBridge().execute(() -> {
            boolean startRequested;
            synchronized (ResidentLocationUploader.AUTHORIZATION_REFRESH_LOCK) {
                // Do not mutate enrollment or authorization from a route-transition fast path.
                // A stale transition can therefore never re-approve an explicitly stopped device.
                ResidentLocationState.applyTrackingIntent(
                        appContext,
                        activeTripId,
                        routePauseAtMs
                );
                ResidentExpresswayStore.reconcile(
                        appContext,
                        activeTripId,
                        expresswayOpen,
                        expresswayConfig
                );
                reconcileExpresswayNotification(appContext);
                startRequested = ResidentLocationService.startIfEligible(appContext);
            }
            call.resolve(buildStatus(startRequested));
        });
    }

    @PluginMethod
    public void installAuthorization(PluginCall call) {
        ResidentLocationState.Authorization authorization =
                ResidentLocationState.Authorization.create(
                        call.getString("supabaseUrl", ""),
                        call.getString("anonKey", ""),
                        call.getString("accessToken", ""),
                        call.getString("refreshToken", ""),
                        call.getString("deviceId", ""),
                        System.currentTimeMillis()
                );
        if (!authorization.isConfigured()) {
            call.reject("認証情報が不足しています。");
            return;
        }
        long requestEpoch = ResidentLocationUploader.beginAuthorizationMutation();
        Context appContext = getContext().getApplicationContext();
        getBridge().execute(() -> {
            boolean installed = false;
            synchronized (ResidentLocationUploader.AUTHORIZATION_REFRESH_LOCK) {
                if (ResidentLocationUploader.isLatestAuthorizationMutation(requestEpoch)) {
                    installed = ResidentLocationState.installAuthorization(
                            appContext,
                            authorization
                    );
                    boolean applied = ResidentLocationUploader
                            .markAuthorizationMutationApplied(requestEpoch);
                    if (installed && applied) {
                        ResidentLocationService.startIfEligible(appContext);
                    }
                }
            }
            if (!installed && ResidentLocationUploader.isLatestAuthorizationMutation(requestEpoch)) {
                call.reject("認証情報を保存できませんでした。");
                return;
            }
            ResidentLocationState.Authorization current =
                    ResidentLocationState.getAuthorization(appContext);
            call.resolve(buildAuthorization(
                    current,
                    ResidentLocationState.isAuthorizationBlocked(appContext)
            ));
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        long requestEpoch = ResidentLocationUploader.beginAuthorizationMutation();
        boolean clearAuthorization = Boolean.TRUE.equals(call.getBoolean("clearAuthorization", false));
        boolean clearActiveTrip = Boolean.TRUE.equals(call.getBoolean("clearActiveTrip", false));
        boolean clearExpresswayData = Boolean.TRUE.equals(
                call.getBoolean("clearExpresswayData", false)
        );
        Context appContext = getContext().getApplicationContext();
        getBridge().execute(() -> {
            synchronized (ResidentLocationUploader.AUTHORIZATION_REFRESH_LOCK) {
                if (ResidentLocationUploader.isLatestAuthorizationMutation(requestEpoch)) {
                    ResidentLocationState.stop(
                            appContext,
                            clearAuthorization,
                            clearActiveTrip
                    );
                    if (clearExpresswayData) {
                        ResidentExpresswayStore.clearPrivateData(appContext);
                    } else if (clearActiveTrip) {
                        ResidentExpresswayStore.deactivate(appContext);
                    }
                    ResidentExpresswayNotification.cancel(appContext);
                    if (ResidentLocationUploader.markAuthorizationMutationApplied(requestEpoch)) {
                        ResidentLocationService.stop(appContext);
                    }
                }
            }
            call.resolve(buildStatus(false));
        });
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(buildStatus(false));
    }

    @PluginMethod
    public void getAuthorization(PluginCall call) {
        ResidentLocationState.Authorization authorization =
                ResidentLocationState.getAuthorization(getContext());
        call.resolve(buildAuthorization(
                authorization,
                ResidentLocationState.isAuthorizationBlocked(getContext())
        ));
    }

    @PluginMethod
    public void refreshAuthorization(PluginCall call) {
        long requestEpoch = ResidentLocationUploader.currentAuthorizationMutationEpoch();
        boolean force = Boolean.TRUE.equals(call.getBoolean("force", false));
        Context appContext = getContext().getApplicationContext();
        getBridge().execute(() -> {
            try {
                ResidentLocationUploader.AuthorizationRefreshResult result =
                        ResidentLocationUploader.refreshAuthorizationForWebView(
                                appContext,
                                requestEpoch,
                                force
                        );
                if (result.cancelled) {
                    call.reject("認証更新は新しい認証操作により取り消されました。");
                    return;
                }
                call.resolve(buildAuthorization(result.authorization, result.blocked));
            } catch (Exception exception) {
                call.reject("認証情報を更新できませんでした。", exception);
            }
        });
    }

    @PluginMethod
    public void blockAuthorization(PluginCall call) {
        long requestEpoch = ResidentLocationUploader.currentAuthorizationMutationEpoch();
        Context appContext = getContext().getApplicationContext();
        ResidentLocationState.Authorization expected =
                ResidentLocationState.getAuthorization(appContext);
        getBridge().execute(() -> {
            ResidentLocationUploader.AuthorizationRefreshResult result =
                    ResidentLocationUploader.blockAuthorization(
                            appContext,
                            expected,
                            requestEpoch
                    );
            call.resolve(buildAuthorization(result.authorization, result.blocked));
        });
    }

    @PluginMethod
    public void peek(PluginCall call) {
        int limit = call.getInt("limit", 500);
        getBridge().execute(() -> {
            try {
                ResidentLocationQueue.PeekResult result = ResidentLocationQueue.peek(getContext(), limit);
                JSObject response = new JSObject();
                response.put("points", result.points);
                response.put("remaining", result.remaining);
                call.resolve(response);
            } catch (Exception exception) {
                call.reject("位置情報キューを読み出せませんでした。", exception);
            }
        });
    }

    @PluginMethod
    public void acknowledge(PluginCall call) {
        JSArray ids = call.getArray("ids", new JSArray());
        getBridge().execute(() -> {
            try {
                JSObject response = new JSObject();
                response.put("remaining", ResidentLocationQueue.acknowledge(getContext(), ids));
                call.resolve(response);
            } catch (Exception exception) {
                call.reject("保存済み位置情報をキューから削除できませんでした。", exception);
            }
        });
    }

    @PluginMethod
    public void peekExpresswayEvents(PluginCall call) {
        int limit = call.getInt("limit", 100);
        Context appContext = getContext().getApplicationContext();
        getBridge().execute(() -> {
            try {
                int before = ResidentExpresswayStore.pendingEventCount(appContext);
                JSArray events = new JSArray(ResidentExpresswayStore.peek(appContext, limit).toString());
                JSObject response = new JSObject();
                response.put("events", events);
                response.put("remaining", Math.max(0, before - events.length()));
                call.resolve(response);
            } catch (Exception exception) {
                call.reject("高速道路イベントを読み出せませんでした。", exception);
            }
        });
    }

    @PluginMethod
    public void acknowledgeExpresswayEvents(PluginCall call) {
        JSArray ids = call.getArray("ids", new JSArray());
        Context appContext = getContext().getApplicationContext();
        getBridge().execute(() -> {
            try {
                JSObject response = new JSObject();
                response.put("remaining", ResidentExpresswayStore.acknowledge(appContext, ids));
                call.resolve(response);
            } catch (Exception exception) {
                call.reject("高速道路イベントを確認済みにできませんでした。", exception);
            }
        });
    }

    @PluginMethod
    public void resolveExpresswayPrompt(PluginCall call) {
        String promptId = call.getString("promptId", "");
        String action = call.getString("action", "");
        if (!"end".equals(action) && !"keep".equals(action)) {
            call.reject("高速道路の確認操作が不正です。");
            return;
        }
        Context appContext = getContext().getApplicationContext();
        getBridge().execute(() -> {
            ResidentExpresswayStore.DecisionResult decision =
                    ResidentExpresswayStore.recordDecision(
                            appContext,
                            promptId,
                            "end".equals(action),
                            System.currentTimeMillis()
                    );
            if (!decision.stored) {
                call.reject("この高速道路の確認はすでに更新されています。");
                return;
            }
            // The notification is closed only after the native durable decision exists.
            ResidentExpresswayNotification.cancel(appContext);
            ResidentLocationService.startIfEligible(appContext);
            JSObject response = new JSObject();
            response.put("stored", true);
            response.put("eventId", decision.eventId);
            response.put("generation", decision.generation);
            call.resolve(response);
        });
    }

    private JSObject buildStatus(boolean startRequested) {
        ResidentLocationState.Readiness readiness = ResidentLocationState.getReadiness(getContext());
        JSObject result = new JSObject();
        result.put("approved", ResidentLocationState.isApproved(getContext()));
        result.put("setupComplete", ResidentLocationState.isSetupComplete(getContext()));
        result.put("enabled", ResidentLocationState.isEnabled(getContext()));
        result.put("eligible", ResidentLocationState.isEligible(getContext()));
        result.put("ready", readiness.isReady());
        result.put("running", ResidentLocationService.isRunning());
        result.put("startRequested", startRequested);
        result.put("activeTripId", ResidentLocationState.getActiveTripId(getContext()));
        result.put("routePauseAtMs", ResidentLocationState.getRoutePauseAtMs(getContext()));
        result.put("queuedPointCount", ResidentLocationQueue.count(getContext()));
        ResidentLocationQueue.StorageDiagnostics queueDiagnostics =
                ResidentLocationQueue.storageDiagnostics(getContext());
        result.put("queuedStorageBytes", queueDiagnostics.queuedBytes);
        result.put("queueSegmentCount", queueDiagnostics.segmentCount);
        result.put("quarantinedStorageBytes", queueDiagnostics.quarantinedBytes);
        result.put("quarantineSegmentCount", queueDiagnostics.quarantineSegmentCount);
        result.put("queueStorageHealthy", queueDiagnostics.healthy);
        result.put("authorizationConfigured", ResidentLocationState.getAuthorization(getContext()).isConfigured());
        result.put("authorizationBlocked", ResidentLocationState.isAuthorizationBlocked(getContext()));
        result.put("lastUploadAt", ResidentLocationState.getLastUploadSuccessAt(getContext()));
        result.put("lastAcceptedLocationAt", ResidentLocationState.getLastAcceptedLocationAt(getContext()));
        result.put(
                "locationQualitySessionStartedAt",
                ResidentLocationState.getLocationQualitySessionStartedAt(getContext())
        );
        result.put(
                "locationQualityUpdatedAt",
                ResidentLocationState.getLocationQualityUpdatedAt(getContext())
        );

        JSObject rejectCounts = new JSObject();
        for (ResidentLocationQualityPolicy.Rejection rejection
                : ResidentLocationQualityPolicy.Rejection.values()) {
            if (rejection == ResidentLocationQualityPolicy.Rejection.NONE) continue;
            rejectCounts.put(
                    ResidentLocationState.locationRejectMetricName(rejection),
                    ResidentLocationState.getLocationRejectCount(getContext(), rejection)
            );
        }
        result.put("locationRejectCounts", rejectCounts);
        result.put("lastQueueWriteAt", ResidentLocationState.getLastQueueWriteAt(getContext()));
        result.put("queueWriteFailureCount", ResidentLocationState.getQueueWriteFailureCount(getContext()));
        result.put(
                "lastQueueWriteFailureAt",
                ResidentLocationState.getLastQueueWriteFailureAt(getContext())
        );

        ResidentExpresswayStore.Snapshot expressway = ResidentExpresswayStore.snapshot(getContext());
        result.put("expresswayPendingEventCount", expressway.events.size());
        result.put(
                "expresswayStorageHealthy",
                expressway.storageHealthy
                        && expressway.events.size() < ResidentExpresswayStore.MAX_EVENT_COUNT
        );
        result.put("expresswayOpen", expressway.open);
        result.put("expresswayPromptPending", !expressway.promptId.isEmpty());
        result.put("expresswayProbePending", expressway.pendingProbe != null);
        result.put(
                "expresswayProbeAttemptCount",
                expressway.pendingProbe == null ? 0 : expressway.pendingProbe.attemptCount
        );
        result.put(
                "expresswayProbeLastFailureCategory",
                expressway.pendingProbe == null
                        ? ""
                        : expressway.pendingProbe.lastFailureCategory
        );
        result.put(
                "expresswayProbeFailureUpdatedAt",
                expressway.pendingProbe == null ? 0L : expressway.pendingProbe.failureUpdatedAtMs
        );
        result.put("expresswayGeneration", expressway.revision);

        JSObject settings = new JSObject();
        settings.put("foregroundLocation", readiness.foregroundLocation);
        settings.put("backgroundLocation", readiness.backgroundLocation);
        settings.put("notifications", readiness.notifications);
        settings.put("batteryOptimization", readiness.batteryOptimization);
        settings.put("exactAlarm", readiness.exactAlarm);
        settings.put("locationEnabled", readiness.locationEnabled);
        result.put("settings", settings);
        return result;
    }

    private static void reconcileExpresswayNotification(Context context) {
        ResidentExpresswayStore.Snapshot snapshot = ResidentExpresswayStore.snapshot(context);
        if (!snapshot.promptId.isEmpty()) {
            ResidentExpresswayNotification.show(context, snapshot.promptId);
        } else {
            ResidentExpresswayNotification.cancel(context);
        }
    }

    private JSObject buildAuthorization(
            ResidentLocationState.Authorization authorization,
            boolean blocked
    ) {
        JSObject result = new JSObject();
        result.put("configured", authorization.isConfigured());
        result.put("accessToken", authorization.accessToken);
        result.put("refreshToken", authorization.refreshToken);
        result.put("updatedAt", authorization.updatedAt);
        result.put("blocked", blocked);
        return result;
    }
}
