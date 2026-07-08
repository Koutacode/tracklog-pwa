import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { APP_VERSION, BUILD_DATE } from './version';
import { initializeTracklogPushOpenHandlers } from '../services/pushRegistration';

const PWA_UPDATE_CHECK_INTERVAL_MS = 60 * 1000;
const PWA_RELOAD_KEY = 'tracklog-pwa-reloaded-build';
const PWA_CACHE_PREFIX = 'tracklog-';

type VersionManifest = {
  version?: string;
  buildDate?: string;
};

function parseTime(value: string | undefined) {
  const time = Date.parse(value ?? '');
  return Number.isFinite(time) ? time : 0;
}

function isDifferentBuild(manifest: VersionManifest) {
  const nextVersion = manifest.version?.trim();
  const nextBuildDate = manifest.buildDate?.trim();
  if (!nextVersion && !nextBuildDate) return false;
  if (nextVersion && nextVersion !== APP_VERSION) return true;
  return parseTime(nextBuildDate) > parseTime(BUILD_DATE);
}

async function clearTrackLogCaches() {
  if (!('caches' in window)) return;
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith(PWA_CACHE_PREFIX)).map(key => caches.delete(key)));
}

async function activateWaitingWorker() {
  const registration = await navigator.serviceWorker.getRegistration();
  if (registration?.waiting) {
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  }
}

async function reloadForUpdate(manifest: VersionManifest) {
  const key = `${manifest.version ?? 'unknown'}:${manifest.buildDate ?? 'unknown'}`;
  if (sessionStorage.getItem(PWA_RELOAD_KEY) === key) return;
  sessionStorage.setItem(PWA_RELOAD_KEY, key);
  await activateWaitingWorker();
  await clearTrackLogCaches();
  window.location.reload();
}

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
        const resp = await fetch(`/version.json?ts=${Date.now()}`, {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });
        if (!resp.ok) return;
        const manifest = (await resp.json()) as VersionManifest;
        if (cancelled) return;
        if (isDifferentBuild(manifest)) void reloadForUpdate(manifest);
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
