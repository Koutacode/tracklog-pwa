import { useEffect } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import {
  addRoutePoint,
  clearPendingExpresswayEndDecision,
  clearPendingExpresswayEndPrompt,
  endExpressway,
  getActiveTripId,
  getAutoExpresswayConfig,
  getBreakToRestConfirmationState,
  getEventsByTripId,
  getPendingExpresswayEndDecision,
  getPendingExpresswayEndPrompt,
  getRouteTrackingMode,
} from '../db/repositories';
import type { AppEvent } from '../domain/types';
import { getOpenBreakToRestThresholdTs } from '../domain/metrics';
import { resolveBreakToRestRoutePauseAt } from '../domain/breakToRestConfirmation';
import {
  EXPRESSWAY_TOGGLE_DEFINITION,
  PERSISTED_BASIC_TOGGLE_DEFINITIONS,
  findOpenToggleStart,
} from '../domain/togglePairing';
import {
  startResidentLocationUpdates,
  startRouteTracking,
  stopResidentLocationUpdates,
  stopRouteTracking,
} from '../services/routeTracking';
import { cancelNativeExpresswayEndPrompt } from '../services/nativeExpresswayPrompt';
import { enqueueNotificationExpresswayEndIcResolution } from '../services/expresswayIcResolution';
import {
  resetNativeExpresswayDetection,
  resumePendingNativeExpresswayDetection,
} from '../services/nativeExpresswayDetection';
import { drainNativeResidentExpresswayEventQueue } from '../services/nativeExpresswayEventHandoff';
import { ROUTE_TRACKING_SYNC_EVENT } from './routeTrackingSignal';
import { notifyTrackLogEventsChanged } from './breakToRestConfirmationSignal';
import { getDriverIdentity } from '../services/remoteAuth';
import { onDriverAuthStateChange } from '../services/remoteAuth';
import { checkNativeSetupReadiness } from '../services/nativeSetup';
import {
  requestLocationHeartbeatNow,
  startLocationHeartbeat,
  stopLocationHeartbeat,
} from '../services/locationHeartbeat';
import {
  pollTracklogAdminMessages,
  retryPendingAdminMessageLocationRequests,
} from '../services/adminMessages';
import { ensureTracklogPushRegistration } from '../services/pushRegistration';
import { isDriverExplicitSignOutRequested } from '../services/authStorageKeys';
import {
  acknowledgeNativeResidentLocationPoints,
  getNativeResidentLocationTrackingStateGeneration,
  peekNativeResidentLocationPoints,
  reconcileNativeResidentLocation,
  restoreNativeResidentLocationSession,
  stopNativeResidentLocation,
  suspendNativeResidentLocationForApproval,
} from '../services/nativeResidentLocation';
import {
  canUseNativeResidentLocation,
  drainNativeResidentRoutePointQueue,
  resolveNativeLocationSetupAction,
  resolveUnapprovedNativeLocationAction,
} from './nativeResidentLocationPolicy';
import {
  applyWebLocationTrackingIntent,
  normalizeWebLocationPermissionState,
  resolveWebLocationTrackingIntent,
} from './webLocationPermissionPolicy';
import type { WebLocationPermissionState } from './webLocationPermissionPolicy';

function isAndroidNative() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

async function persistNativeResidentLocationQueue() {
  return drainNativeResidentRoutePointQueue({
    enabled: isAndroidNative(),
    peek: peekNativeResidentLocationPoints,
    acknowledge: acknowledgeNativeResidentLocationPoints,
    addRoutePoint,
  });
}

const [REST_TOGGLE_DEFINITION, , , , FERRY_TOGGLE_DEFINITION] =
  PERSISTED_BASIC_TOGGLE_DEFINITIONS;

function hasOpenExpressway(events: AppEvent[]) {
  return findOpenToggleStart(events, EXPRESSWAY_TOGGLE_DEFINITION) !== null;
}

function hasOpenRest(events: AppEvent[]) {
  return findOpenToggleStart(events, REST_TOGGLE_DEFINITION) !== null;
}

function hasOpenFerry(events: AppEvent[]) {
  return findOpenToggleStart(events, FERRY_TOGGLE_DEFINITION) !== null;
}

// WebKit can expose an already-temporary-approved location permission as
// `prompt` after reload. Permit one active-trip resume probe per document, not
// one per React mount/sync, so StrictMode and lifecycle events cannot multiply
// browser prompts.
let pwaActiveTripResumeAttempted = false;

export default function RouteTrackingSupervisor() {
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let syncQueued = false;
    let lifecycleEpoch = 0;
    let foregroundHeartbeatRequestedAt = 0;
    let webLocationPermissionStatus: PermissionStatus | null = null;
    let webLocationPermissionState: WebLocationPermissionState = 'unknown';
    const native = isAndroidNative();
    const webLocationTrackingActions = {
      startResidentLocationUpdates,
      startRouteTracking,
      stopResidentLocationUpdates,
      stopRouteTracking,
    };

    const updateWebLocationPermissionState = (state: string | null | undefined) => {
      webLocationPermissionState = normalizeWebLocationPermissionState(state);
    };

    const onWebLocationPermissionChange = () => {
      pwaActiveTripResumeAttempted = false;
      updateWebLocationPermissionState(webLocationPermissionStatus?.state);
      void sync();
    };

    const replaceWebLocationPermissionStatus = (status: PermissionStatus | null) => {
      if (webLocationPermissionStatus === status) return;
      webLocationPermissionStatus?.removeEventListener('change', onWebLocationPermissionChange);
      webLocationPermissionStatus = status;
      webLocationPermissionStatus?.addEventListener('change', onWebLocationPermissionChange);
    };

    const refreshWebLocationPermissionState = async () => {
      if (native || !navigator.permissions?.query) {
        replaceWebLocationPermissionStatus(null);
        updateWebLocationPermissionState('unknown');
        return webLocationPermissionState;
      }
      try {
        const status = await navigator.permissions.query({
          name: 'geolocation' as PermissionName,
        });
        if (disposed) return 'unknown' as const;
        replaceWebLocationPermissionStatus(status);
        updateWebLocationPermissionState(status.state);
      } catch {
        replaceWebLocationPermissionStatus(null);
        updateWebLocationPermissionState('unknown');
      }
      return webLocationPermissionState;
    };

    const reconcileWebLocationTracking = async (
      activeTripId: string | null,
      routePaused: boolean,
      mode?: Parameters<typeof startRouteTracking>[1],
    ) => {
      const intent = resolveWebLocationTrackingIntent({
        permissionState: webLocationPermissionState,
        activeTripId,
        routePaused,
        mode,
        activeTripResumeAttemptAvailable: !pwaActiveTripResumeAttempted,
      });
      if (intent.kind === 'route' && intent.consumesActiveTripResumeAttempt) {
        // Consume before invoking watchPosition. A synchronous failure or an
        // unanswered prompt must not cause an automatic retry 15 seconds later.
        pwaActiveTripResumeAttempted = true;
      }
      await applyWebLocationTrackingIntent(intent, webLocationTrackingActions);
    };

    const stopAllLocationWork = async (
      nativeReason: 'manual' | 'permission-denied' | 'approval-rejected' | 'signed-out' = 'manual',
    ) => {
      // Clear native credentials first on sign-out so an in-flight WebView sync
      // cannot restore an account that the user has just left.
      if (native && nativeReason === 'signed-out') {
        resetNativeExpresswayDetection();
        await stopNativeResidentLocation({ reason: nativeReason });
      }
      stopLocationHeartbeat();
      await stopResidentLocationUpdates();
      await stopRouteTracking();
      if (native && nativeReason !== 'signed-out') {
        resetNativeExpresswayDetection();
        await stopNativeResidentLocation({ reason: nativeReason });
      }
    };

    const stopWebLocationWork = async () => {
      stopLocationHeartbeat();
      await stopResidentLocationUpdates();
      await stopRouteTracking();
    };

    const suspendAllLocationWorkForApproval = async () => {
      await stopWebLocationWork();
      if (!native) return;
      resetNativeExpresswayDetection();
      await suspendNativeResidentLocationForApproval();
    };

    const maybeRequestForegroundHeartbeat = () => {
      // When allowed, the PWA uses the supervisor-owned geolocation watcher.
      // An additional getCurrentPosition request on every visibility change
      // can create duplicate browser prompts. Android uses the app-owned
      // foreground service, so it still needs this one-shot refresh.
      if (!native) return;
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - foregroundHeartbeatRequestedAt < 30000) return;
      foregroundHeartbeatRequestedAt = now;
      void requestLocationHeartbeatNow();
    };

    const sync = async () => {
      if (disposed) return;
      if (inFlight) {
        syncQueued = true;
        return;
      }
      const syncEpoch = lifecycleEpoch;
      inFlight = true;
      try {
        if (native) {
          try {
            await restoreNativeResidentLocationSession();
          } catch (error) {
            console.warn('[resident-location] session refresh handoff failed', error);
          }
        }
        const identity = await getDriverIdentity();
        const approved =
          identity.configured &&
          identity.authInitialized &&
          identity.profileComplete &&
          identity.approvalStatus === 'approved';
        if (!approved) {
          if (!native) {
            await stopAllLocationWork();
            return;
          }
          const unapprovedAction = resolveUnapprovedNativeLocationAction({
            authInitialized: identity.authInitialized,
            approvalStatus: identity.approvalStatus,
            explicitSignOutRequested: isDriverExplicitSignOutRequested(),
          });
          if (unapprovedAction === 'preserve-native-auth') {
            // A Supabase refresh can temporarily remove only the WebView
            // session. Keep the approved native enrollment available for the
            // startup handoff instead of converting it into a real sign-out.
            await stopWebLocationWork();
          } else if (unapprovedAction === 'suspend-for-approval') {
            await suspendAllLocationWorkForApproval();
          } else if (unapprovedAction === 'clear-signed-out-auth') {
            await stopAllLocationWork('signed-out');
          } else {
            await stopAllLocationWork('approval-rejected');
          }
          return;
        }

        const readiness = await checkNativeSetupReadiness({ fresh: native });
        if (disposed || syncEpoch !== lifecycleEpoch) return;
        // The final setup step verifies that this supervisor actually started
        // the resident service. Gate this bootstrap on the five physical
        // settings only, otherwise `running` could never become true.
        const setupAction = native
          ? resolveNativeLocationSetupAction(readiness)
          : readiness.ready ? 'start' : 'stop';
        if (setupAction === 'wait-for-location') {
          // The native foreground service owns OFF/ON recovery. Preserve its
          // durable trip, authorization, and pending expressway confirmation.
          await stopWebLocationWork();
          return;
        }
        if (setupAction === 'stop') {
          await stopAllLocationWork('permission-denied');
          return;
        }

        startLocationHeartbeat();
        if (native) {
          // The app-owned service is the single native route source. Keeping the
          // legacy watcher active here would record the same movement twice.
          await stopResidentLocationUpdates();
          await stopRouteTracking();
          try {
            const expresswayDrain = await drainNativeResidentExpresswayEventQueue({ enabled: true });
            if (expresswayDrain.materialized > 0) notifyTrackLogEventsChanged();
          } catch {
            // Leave the native transition unacknowledged for the next ordered
            // replay, while still draining route points below.
            console.warn('[resident-location] native expressway event handoff deferred');
          }
          const drained = await persistNativeResidentLocationQueue();
          // Java ResidentLocationService is the sole detector/notification
          // owner for newly captured Android points. This wake only retires
          // durable work queued by an older WebView build.
          resumePendingNativeExpresswayDetection();
          if (drained.persisted > 0) notifyTrackLogEventsChanged();
        } else {
          await refreshWebLocationPermissionState();
          if (disposed || syncEpoch !== lifecycleEpoch) return;
        }
        await ensureTracklogPushRegistration();
        await retryPendingAdminMessageLocationRequests();
        maybeRequestForegroundHeartbeat();
        await pollTracklogAdminMessages();

        // Capture before reading the trip/events snapshot. An explicit No or
        // confirmed rest increments this generation, preventing an older sync
        // from overwriting the driver's newer native tracking state.
        const trackingStateGeneration = native
          ? getNativeResidentLocationTrackingStateGeneration()
          : undefined;
        const expresswayConfig = native ? await getAutoExpresswayConfig() : undefined;
        const tripId = await getActiveTripId();
        if (!tripId) {
          resetNativeExpresswayDetection();
          if (native) {
            await reconcileNativeResidentLocation({
              approved: true,
              setupComplete: true,
              activeTripId: null,
              expectedTrackingStateGeneration: trackingStateGeneration,
              expresswayOpen: false,
              expresswayConfig,
            });
          } else {
            await reconcileWebLocationTracking(null, false);
          }
          const pendingPrompt = await getPendingExpresswayEndPrompt();
          const pendingDecision = await getPendingExpresswayEndDecision();
          if (pendingPrompt) {
            await clearPendingExpresswayEndPrompt(pendingPrompt.tripId);
            await cancelNativeExpresswayEndPrompt(pendingPrompt.tripId);
          }
          if (pendingDecision) {
            await clearPendingExpresswayEndDecision(pendingDecision.tripId);
          }
          return;
        }
        const events = await getEventsByTripId(tripId);
        const openExpressway = hasOpenExpressway(events);
        const pendingDecision = await getPendingExpresswayEndDecision();
        if (pendingDecision?.tripId === tripId) {
          if (pendingDecision.action === 'keep') {
            await clearPendingExpresswayEndPrompt(tripId);
            await cancelNativeExpresswayEndPrompt(tripId);
            if (!openExpressway) {
              await clearPendingExpresswayEndDecision(tripId);
            }
          } else if (openExpressway) {
            const pendingPrompt = await getPendingExpresswayEndPrompt();
            const geo =
              pendingDecision.geo ??
              (pendingPrompt?.tripId === tripId ? pendingPrompt.geo : undefined);
            if (geo) {
              const { eventId } = await endExpressway({
                tripId,
                geo,
                source: 'automatic_detection',
                automaticConfirmation: 'confirmed',
              });
              enqueueNotificationExpresswayEndIcResolution({ eventId, geo });
            }
            await clearPendingExpresswayEndPrompt(tripId);
            await clearPendingExpresswayEndDecision(tripId);
            await cancelNativeExpresswayEndPrompt(tripId);
          } else {
            await clearPendingExpresswayEndPrompt(tripId);
            await clearPendingExpresswayEndDecision(tripId);
            await cancelNativeExpresswayEndPrompt(tripId);
          }
        } else if (pendingDecision && pendingDecision.tripId !== tripId) {
          await clearPendingExpresswayEndDecision(pendingDecision.tripId);
        }
        if (hasOpenRest(events) || hasOpenFerry(events)) {
          if (native) {
            await reconcileNativeResidentLocation({
              approved: true,
              setupComplete: true,
              activeTripId: null,
              expectedTrackingStateGeneration: trackingStateGeneration,
              expresswayOpen: openExpressway,
              expresswayConfig,
            });
          } else {
            await reconcileWebLocationTracking(tripId, true);
          }
          return;
        }
        const mode = await getRouteTrackingMode();
        if (native) {
          if (!canUseNativeResidentLocation({
            isAndroidNative: native,
            identity,
            setupReady: readiness.permissionsReady,
          })) {
            await suspendAllLocationWorkForApproval();
            return;
          }
          if (disposed || syncEpoch !== lifecycleEpoch) return;
          const breakThresholdTs = getOpenBreakToRestThresholdTs(events);
          const breakConfirmation = breakThresholdTs
            ? await getBreakToRestConfirmationState({ tripId })
            : null;
          await reconcileNativeResidentLocation({
            approved: true,
            setupComplete: true,
            activeTripId: tripId,
            expectedTrackingStateGeneration: trackingStateGeneration,
            expresswayOpen: openExpressway,
            expresswayConfig,
            // While a decision is pending (or its ODO is still being entered),
            // preserve the three-hour pause boundary. A declined conversion is
            // still an active break, so resume future route points immediately.
            routePauseAt: resolveBreakToRestRoutePauseAt(
              breakThresholdTs,
              breakConfirmation?.status ?? null,
            ),
          });
        } else {
          await reconcileWebLocationTracking(tripId, false, mode);
        }
      } catch {
        // retry on next tick
      } finally {
        inFlight = false;
        if (syncQueued && !disposed) {
          syncQueued = false;
          void sync();
        }
      }
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        maybeRequestForegroundHeartbeat();
        void pollTracklogAdminMessages({ force: true });
        void sync();
      }
    };
    const onSyncRequest = () => {
      if (!native) {
        // These events follow explicit trip/record/setup operations. Unlike a
        // timer or visibility sync, an explicit operation may have just proved
        // or changed browser permission and is allowed to re-evaluate once.
        pwaActiveTripResumeAttempted = false;
      }
      void sync();
    };
    const unsubscribeAuth = onDriverAuthStateChange(event => {
      if (event === 'SIGNED_OUT') {
        lifecycleEpoch += 1;
        syncQueued = false;
        void (async () => {
          if (isDriverExplicitSignOutRequested()) {
            await stopAllLocationWork('signed-out');
            return;
          }
          await stopWebLocationWork();
          if (native) {
            try {
              await restoreNativeResidentLocationSession();
            } catch (error) {
              console.warn('[resident-location] signed-out recovery deferred', error);
            }
          }
          if (!disposed) void sync();
        })();
        return;
      }
      void sync();
    });
    const resumeListener = native
      ? CapacitorApp.addListener('resume', () => {
          void sync();
        })
      : null;

    void sync();
    const timer = window.setInterval(() => {
      void sync();
    }, 15000);
    window.addEventListener('online', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(ROUTE_TRACKING_SYNC_EVENT, onSyncRequest);
    return () => {
      disposed = true;
      lifecycleEpoch += 1;
      window.clearInterval(timer);
      window.removeEventListener('online', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(ROUTE_TRACKING_SYNC_EVENT, onSyncRequest);
      unsubscribeAuth();
      if (resumeListener) {
        void resumeListener.then(listener => listener.remove());
      }
      replaceWebLocationPermissionStatus(null);
      stopLocationHeartbeat();
      void stopResidentLocationUpdates();
      void stopRouteTracking();
    };
  }, []);

  return null;
}
