import { useEffect } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import {
  addRoutePoint,
  clearPendingExpresswayEndDecision,
  clearPendingExpresswayEndPrompt,
  endExpressway,
  getActiveTripId,
  getEventsByTripId,
  getPendingExpresswayEndDecision,
  getPendingExpresswayEndPrompt,
  getRouteTrackingMode,
  reconcileBreakToRestThreshold,
} from '../db/repositories';
import type { AppEvent } from '../domain/types';
import { getOpenBreakToRestThresholdTs } from '../domain/metrics';
import {
  startResidentLocationUpdates,
  startRouteTracking,
  stopResidentLocationUpdates,
  stopRouteTracking,
} from '../services/routeTracking';
import { cancelNativeExpresswayEndPrompt } from '../services/nativeExpresswayPrompt';
import { enqueueNotificationExpresswayEndIcResolution } from '../services/expresswayIcResolution';
import { ROUTE_TRACKING_SYNC_EVENT } from './routeTrackingSignal';
import { getDriverIdentity } from '../services/remoteAuth';
import { onDriverAuthStateChange } from '../services/remoteAuth';
import { checkNativeSetupReadiness } from '../services/nativeSetup';
import {
  requestLocationHeartbeatNow,
  startLocationHeartbeat,
  stopLocationHeartbeat,
} from '../services/locationHeartbeat';
import { pollTracklogAdminMessages } from '../services/adminMessages';
import { ensureTracklogPushRegistration } from '../services/pushRegistration';
import { isDriverExplicitSignOutRequested } from '../services/authStorageKeys';
import {
  acknowledgeNativeResidentLocationPoints,
  peekNativeResidentLocationPoints,
  reconcileNativeResidentLocation,
  restoreNativeResidentLocationSession,
  stopNativeResidentLocation,
} from '../services/nativeResidentLocation';
import {
  canUseNativeResidentLocation,
  drainNativeResidentRoutePointQueue,
} from './nativeResidentLocationPolicy';

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

function hasOpenRest(events: AppEvent[]) {
  const starts = events.filter(e => e.type === 'rest_start').sort((a, b) => a.ts.localeCompare(b.ts));
  if (starts.length === 0) return false;
  const ends = events.filter(e => e.type === 'rest_end');
  for (let i = starts.length - 1; i >= 0; i--) {
    const sid = (starts[i] as any).extras?.restSessionId as string | undefined;
    if (!sid) continue;
    const hasEnd = ends.some(en => (en as any).extras?.restSessionId === sid);
    if (!hasEnd) return true;
  }
  return false;
}

function hasOpenExpressway(events: AppEvent[]) {
  const starts = events.filter(e => e.type === 'expressway_start').sort((a, b) => a.ts.localeCompare(b.ts));
  if (starts.length === 0) return false;
  const ends = events.filter(e => e.type === 'expressway_end');
  for (let i = starts.length - 1; i >= 0; i--) {
    const sid = (starts[i] as any).extras?.expresswaySessionId as string | undefined;
    if (!sid) continue;
    const hasEnd = ends.some(en => (en as any).extras?.expresswaySessionId === sid);
    if (!hasEnd) return true;
  }
  return false;
}

function hasOpenFerry(events: AppEvent[]) {
  const starts = events.filter(e => e.type === 'boarding').sort((a, b) => a.ts.localeCompare(b.ts));
  if (starts.length === 0) return false;
  const ends = events.filter(e => e.type === 'disembark');
  for (let i = starts.length - 1; i >= 0; i--) {
    const sid = (starts[i] as any).extras?.ferrySessionId as string | undefined;
    if (!sid) continue;
    const hasEnd = ends.some(en => (en as any).extras?.ferrySessionId === sid);
    if (!hasEnd) return true;
  }
  return false;
}

export default function RouteTrackingSupervisor() {
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let syncQueued = false;
    let lifecycleEpoch = 0;
    let foregroundHeartbeatRequestedAt = 0;
    const native = isAndroidNative();

    const stopAllLocationWork = async (
      nativeReason: 'manual' | 'permission-denied' | 'approval-rejected' | 'signed-out' = 'manual',
    ) => {
      // Clear native credentials first on sign-out so an in-flight WebView sync
      // cannot restore an account that the user has just left.
      if (native && nativeReason === 'signed-out') {
        await stopNativeResidentLocation({ reason: nativeReason });
      }
      stopLocationHeartbeat();
      await stopResidentLocationUpdates();
      await stopRouteTracking();
      if (native && nativeReason !== 'signed-out') {
        await stopNativeResidentLocation({ reason: nativeReason });
      }
    };

    const stopWebLocationWork = async () => {
      stopLocationHeartbeat();
      await stopResidentLocationUpdates();
      await stopRouteTracking();
    };

    const maybeRequestForegroundHeartbeat = () => {
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
        const reconciliationTripId = await getActiveTripId();
        if (reconciliationTripId) {
          await reconcileBreakToRestThreshold({ tripId: reconciliationTripId });
        }
        const identity = await getDriverIdentity();
        const approved =
          identity.configured &&
          identity.authInitialized &&
          identity.profileComplete &&
          identity.approvalStatus === 'approved';
        if (!approved) {
          if (native && !identity.authInitialized && !isDriverExplicitSignOutRequested()) {
            // A Supabase refresh can temporarily remove only the WebView
            // session. Keep the approved native enrollment available for the
            // startup handoff instead of converting it into a real sign-out.
            await stopWebLocationWork();
          } else {
            await stopAllLocationWork(
              isDriverExplicitSignOutRequested() ? 'signed-out' : 'approval-rejected',
            );
          }
          return;
        }

        const readiness = await checkNativeSetupReadiness();
        if (!readiness.ready) {
          await stopAllLocationWork('permission-denied');
          return;
        }

        if (disposed || syncEpoch !== lifecycleEpoch) return;

        startLocationHeartbeat();
        if (native) {
          // The app-owned service is the single native route source. Keeping the
          // legacy watcher active here would record the same movement twice.
          await stopResidentLocationUpdates();
          await stopRouteTracking();
          await persistNativeResidentLocationQueue();
        } else {
          await startResidentLocationUpdates('battery');
        }
        await ensureTracklogPushRegistration();
        maybeRequestForegroundHeartbeat();
        await pollTracklogAdminMessages();

        const tripId = await getActiveTripId();
        if (!tripId) {
          if (native) {
            await reconcileNativeResidentLocation({
              approved: true,
              setupComplete: true,
              activeTripId: null,
            });
          } else {
            await stopRouteTracking();
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
              const { eventId } = await endExpressway({ tripId, geo });
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
            });
          } else {
            await stopRouteTracking();
          }
          return;
        }
        const mode = await getRouteTrackingMode();
        if (native) {
          if (!canUseNativeResidentLocation({
            isAndroidNative: native,
            identity,
            setupReady: readiness.ready,
          })) {
            await stopAllLocationWork('approval-rejected');
            return;
          }
          if (disposed || syncEpoch !== lifecycleEpoch) return;
          await reconcileNativeResidentLocation({
            approved: true,
            setupComplete: true,
            activeTripId: tripId,
            routePauseAt: getOpenBreakToRestThresholdTs(events),
          });
        } else {
          await startRouteTracking(tripId, mode);
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
      stopLocationHeartbeat();
      void stopResidentLocationUpdates();
      void stopRouteTracking();
    };
  }, []);

  return null;
}
