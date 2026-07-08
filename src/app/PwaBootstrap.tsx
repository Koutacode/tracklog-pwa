import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { initializeTracklogPushOpenHandlers } from '../services/pushRegistration';
import {
  checkLatestPwaBuild,
  isDifferentPwaBuild,
  reloadPwaForLatestBuild,
} from '../services/appVersionCheck';

const PWA_UPDATE_CHECK_INTERVAL_MS = 60 * 1000;

export default function PwaBootstrap() {
  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;
    if (!('serviceWorker' in navigator)) return;
    let cancelled = false;

    initializeTracklogPushOpenHandlers();

    navigator.serviceWorker.register('/sw.js').then(registration => {
      void registration.update();
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            worker.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
    }).catch(() => {
      // silent fallback for local preview or browsers that reject registration
    });

    const checkLatestBuild = async () => {
      try {
        const manifest = await checkLatestPwaBuild();
        if (cancelled) return;
        if (isDifferentPwaBuild({ version: manifest.latestVersion ?? undefined, buildDate: manifest.latestBuildDate ?? undefined })) {
          void reloadPwaForLatestBuild({
            version: manifest.latestVersion ?? undefined,
            buildDate: manifest.latestBuildDate ?? undefined,
          });
        }
      } catch {
        // keep the installed PWA usable offline or during transient network errors
      }
    };

    const onFocus = () => {
      void checkLatestBuild();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void checkLatestBuild();
    };
    const onControllerChange = () => {
      void checkLatestBuild();
    };

    void checkLatestBuild();
    const intervalId = window.setInterval(checkLatestBuild, PWA_UPDATE_CHECK_INTERVAL_MS);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);

  return null;
}
