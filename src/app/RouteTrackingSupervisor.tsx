import { useEffect } from 'react';
import {
  clearPendingExpresswayEndDecision,
  clearPendingExpresswayEndPrompt,
  endExpressway,
  getActiveTripId,
  getEventsByTripId,
  getPendingExpresswayEndDecision,
  getPendingExpresswayEndPrompt,
  getRouteTrackingMode,
} from '../db/repositories';
import type { AppEvent } from '../domain/types';
import { startRouteTracking, stopRouteTracking } from '../services/routeTracking';
import { cancelNativeExpresswayEndPrompt } from '../services/nativeExpresswayPrompt';

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

export default function RouteTrackingSupervisor() {
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    const sync = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const tripId = await getActiveTripId();
        if (!tripId) {
          await stopRouteTracking();
          await clearPendingExpresswayEndPrompt();
          await clearPendingExpresswayEndDecision();
          await cancelNativeExpresswayEndPrompt();
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
              await endExpressway({ tripId, geo });
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
        if (hasOpenRest(events)) {
          await stopRouteTracking();
          return;
        }
        const mode = await getRouteTrackingMode();
        await startRouteTracking(tripId, mode);
      } catch {
        // retry on next tick
      } finally {
        inFlight = false;
      }
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void sync();
      }
    };

    void sync();
    const timer = window.setInterval(() => {
      void sync();
    }, 15000);
    window.addEventListener('online', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener('online', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return null;
}
