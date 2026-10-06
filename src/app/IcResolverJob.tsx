import { useEffect } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { retryPendingExpresswayIcResolutions } from '../services/expresswayIcResolution';
import { onDriverAuthStateChange } from '../services/remoteAuth';

/**
 * IcResolverJob periodically checks for expressway events whose IC names have
 * not yet been resolved. It uses bundled public IC candidates first, including
 * offline, and queries the resolver online only when the catalogue has no
 * candidate near the saved position. Results are persisted back into the database. Only a small number of
 * pending events are processed per timer interval to avoid excessive network
 * requests. Recovery triggers respect the same persisted delay and budget.
 * Least recently attempted events are selected first to avoid starvation.
 */
export default function IcResolverJob() {
  useEffect(() => {
    const MAX_EVENTS_PER_TICK = 12;
    let disposed = false;
    let lastForegroundRecoveryAt = Date.now();
    const start = () => {
      if (disposed) return;
      // A deleted/edited event or a suspended database must not disable the
      // recurring worker or leave an unhandled promise rejection. The shared
      // batch owns recovery coalescing, including TOKEN_REFRESHED raised by
      // its own requests; a second local rerun queue could loop indefinitely.
      void retryPendingExpresswayIcResolutions(MAX_EVENTS_PER_TICK).catch(() => undefined);
    };
    const onOnline = () => start();
    const onResume = () => {
      if (disposed) return;
      const now = Date.now();
      // Native resume and WebView visibility often describe the same return.
      // Repeated app switching must not continually reset network backoff.
      if (now - lastForegroundRecoveryAt < 15_000) return;
      lastForegroundRecoveryAt = now;
      start();
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
        start();
      }
    });
    start();
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
