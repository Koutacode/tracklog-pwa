import { useEffect } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { hydrateRemoteSyncState, installImmediateRemoteSyncListener, runRemoteSync } from '../services/remoteSync';
import { restoreNativeResidentLocationSession } from '../services/nativeResidentLocation';

export default function RemoteSyncBootstrap() {
  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    let appStateListener: { remove(): Promise<void> } | null = null;
    let lastActiveState = document.visibilityState === 'visible';

    const syncOnce = async (reason = 'bootstrap') => {
      if (disposed) return;
      await runRemoteSync(reason);
    };

    void (async () => {
      try {
        await restoreNativeResidentLocationSession();
      } catch (error) {
        console.warn('[resident-location] native session restore skipped', error);
      }
      await hydrateRemoteSyncState();
      await syncOnce();
    })();

    const onActiveStateChanged = (isActive: boolean) => {
      // Native appStateChange and WebView visibilitychange can describe the
      // same transition. Flush once before suspension and once on return.
      if (lastActiveState === isActive) return;
      lastActiveState = isActive;
      void syncOnce(isActive ? 'resume' : 'background');
    };
    const onVisible = () => onActiveStateChanged(document.visibilityState === 'visible');
    const onOnline = () => {
      void syncOnce('online');
    };

    timer = window.setInterval(() => {
      void syncOnce('poll');
    }, 45000);

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    if (Capacitor.isNativePlatform()) {
      void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        onActiveStateChanged(isActive);
      }).then(listener => {
        if (disposed) void listener.remove();
        else appStateListener = listener;
      });
    }
    const unsubscribeImmediate = installImmediateRemoteSyncListener();
    return () => {
      disposed = true;
      if (timer != null) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      void appStateListener?.remove();
      unsubscribeImmediate();
    };
  }, []);

  return null;
}
