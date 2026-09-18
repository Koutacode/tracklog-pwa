import { useEffect } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
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
    let lastForegroundRecoveryAt = Date.now();
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

    const start = (force = false) => {
      // A deleted/edited event or a suspended database must not disable the
      // recurring worker or leave an unhandled promise rejection.
      void runOnce(force).catch(() => undefined);
    };
    const onOnline = () => start(true);
    const onResume = () => {
      if (disposed) return;
      const now = Date.now();
      // Native resume and WebView visibility often describe the same return.
      // Repeated app switching must not continually reset network backoff.
      if (now - lastForegroundRecoveryAt < 15_000) return;
      lastForegroundRecoveryAt = now;
      start(true);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') onResume();
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    const nativeResume = Capacitor.isNativePlatform()
      ? CapacitorApp.addListener('resume', onResume)
      : null;
    const unsubscribeAuth = onDriverAuthStateChange(event => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        start(true);
      }
    });
    start(true);
    const interval = setInterval(() => start(), 15 * 1000);
    return () => {
      disposed = true;
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
      void nativeResume?.then(listener => listener.remove()).catch(() => undefined);
      unsubscribeAuth();
      clearInterval(interval);
    };
  }, []);

  return null;
}
