import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { APP_VERSION, BUILD_DATE } from './version';

const PWA_UPDATE_CHECK_INTERVAL_MS = 60 * 1000;
const PWA_RELOAD_KEY = 'tracklog-pwa-reloaded-build';

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

function reloadForUpdate(manifest: VersionManifest) {
  const key = `${manifest.version ?? 'unknown'}:${manifest.buildDate ?? 'unknown'}`;
  if (sessionStorage.getItem(PWA_RELOAD_KEY) === key) return;
  sessionStorage.setItem(PWA_RELOAD_KEY, key);
  window.location.reload();
}

export default function PwaBootstrap() {
  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;
    if (!('serviceWorker' in navigator)) return;
    let cancelled = false;

    navigator.serviceWorker.register('/sw.js').then(registration => {
      void registration.update();
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
        if (isDifferentBuild(manifest)) reloadForUpdate(manifest);
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
