import { useEffect } from 'react';
import { getPendingExpresswayEvents, updateExpresswayResolved } from '../db/repositories';
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
    const runOnce = async () => {
      if (!navigator.onLine) return;
      const pending = await getPendingExpresswayEvents();
      const targets = pending.slice(0, 2);
      for (const ev of targets) {
        const geo = ev.geo;
        if (!geo) {
          await updateExpresswayResolved({ eventId: ev.id, status: 'failed' });
          continue;
        }
        const result = await resolveNearestIC(geo.lat, geo.lng);
        if (result) {
          await updateExpresswayResolved({
            eventId: ev.id,
            status: 'resolved',
            icName: result.icName,
            icDistanceM: result.distanceM,
          });
        } else {
          await updateExpresswayResolved({ eventId: ev.id, status: 'failed' });
        }
      }
    };

    const onOnline = () => {
      runOnce();
    };
    window.addEventListener('online', onOnline);
    runOnce();
    const interval = setInterval(runOnce, 15 * 60 * 1000);
    return () => {
      window.removeEventListener('online', onOnline);
      clearInterval(interval);
    };
  }, []);

  return null;
}
