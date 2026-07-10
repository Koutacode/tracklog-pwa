import { useEffect } from 'react';
import { hydrateRemoteSyncState, installImmediateRemoteSyncListener, runRemoteSync } from '../services/remoteSync';
import { restoreNativeResidentLocationSession } from '../services/nativeResidentLocation';

export default function RemoteSyncBootstrap() {
  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;

    const syncOnce = async () => {
      if (disposed) return;
      await runRemoteSync('bootstrap');
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

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void syncOnce();
      }
    };
    const onOnline = () => {
      void syncOnce();
    };

    timer = window.setInterval(() => {
      void syncOnce();
    }, 45000);

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    const unsubscribeImmediate = installImmediateRemoteSyncListener();
    return () => {
      disposed = true;
      if (timer != null) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      unsubscribeImmediate();
    };
  }, []);

  return null;
}
