import { useEffect } from 'react';
import { backfillPendingExpresswayIcs } from '../db/repositories';

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
    const MAX_EVENTS_PER_TICK = 8;
    const runOnce = async () => {
      await backfillPendingExpresswayIcs(MAX_EVENTS_PER_TICK);
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
