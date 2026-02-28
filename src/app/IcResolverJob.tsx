import { useEffect } from 'react';
import {
  getPendingExpresswayEvents,
  markExpresswayResolveFailure,
  updateExpresswayResolved,
} from '../db/repositories';
import { resolveNearestIC } from '../services/icResolver';

/**
 * IcResolverJob periodically checks for expressway events whose IC names have
 * not yet been resolved. When the browser is online it attempts to resolve
 * the nearest interchange using the device's recorded GPS coordinates. The
 * update is then persisted back into the database. Only a small number of
 * pending events are processed per interval to avoid excessive network
 * requests. The job listens for the online event to retry immediately when
 * connectivity returns.
 */
export default function IcResolverJob() {
  useEffect(() => {
    let running = false;
    const MAX_EVENTS_PER_TICK = 3;
    const runOnce = async () => {
      if (running || !navigator.onLine) return;
      running = true;
      try {
        const pending = await getPendingExpresswayEvents();
        const targets = pending.slice(0, MAX_EVENTS_PER_TICK);
        for (const ev of targets) {
          const geo = ev.geo;
          if (!geo) {
            await markExpresswayResolveFailure({
              eventId: ev.id,
              errorMessage: '位置情報が未保存のためIC解決不可',
            });
            continue;
          }
          try {
            const result = await resolveNearestIC(geo.lat, geo.lng);
            if (result) {
              await updateExpresswayResolved({
                eventId: ev.id,
                status: 'resolved',
                icName: result.icName,
                icDistanceM: result.distanceM,
              });
            } else {
              await markExpresswayResolveFailure({
                eventId: ev.id,
                errorMessage: '近傍ICを取得できませんでした',
              });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await markExpresswayResolveFailure({ eventId: ev.id, errorMessage: message });
          }
        }
      } finally {
        running = false;
      }
    };

    const onOnline = () => {
      runOnce();
    };
    window.addEventListener('online', onOnline);
    runOnce();
    const interval = setInterval(runOnce, 60 * 1000);
    return () => {
      window.removeEventListener('online', onOnline);
      clearInterval(interval);
    };
  }, []);

  return null;
}
