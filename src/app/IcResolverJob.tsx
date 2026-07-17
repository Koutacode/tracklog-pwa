import { useEffect } from 'react';
import { retryPendingExpresswayIcResolutions } from '../services/expresswayIcResolution';
import { onDriverAuthStateChange } from '../services/remoteAuth';

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
    const MAX_EVENTS_PER_TICK = 12;
    let disposed = false;
    let running = false;
    let rerunRequested = false;
    let forceNextRun = false;
    const runOnce = async (ignorePendingBackoff = false) => {
      if (running) {
        rerunRequested = true;
        forceNextRun = forceNextRun || ignorePendingBackoff;
        return;
      }
      running = true;
      let forceCurrentRun = ignorePendingBackoff;
      try {
        do {
          rerunRequested = false;
          const force = forceCurrentRun || forceNextRun;
          forceCurrentRun = false;
          forceNextRun = false;
          await retryPendingExpresswayIcResolutions(MAX_EVENTS_PER_TICK, {
            ignorePendingBackoff: force,
          });
        } while (rerunRequested && !disposed);
      } finally {
        running = false;
      }
    };

    const onOnline = () => {
      void runOnce(true);
    };
    window.addEventListener('online', onOnline);
    const unsubscribeAuth = onDriverAuthStateChange(event => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        void runOnce(true);
      }
    });
    void runOnce();
    const interval = setInterval(() => void runOnce(), 60 * 1000);
    return () => {
      disposed = true;
      window.removeEventListener('online', onOnline);
      unsubscribeAuth();
      clearInterval(interval);
    };
  }, []);

  return null;
}
