import { useEffect, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';
import UpdateDialog from '../ui/components/UpdateDialog';
import { APP_VERSION } from './version';

/**
 * PwaUpdater listens for service worker updates and prompts the user to reload
 * when a new version is available. The service worker registration is
 * configured to prompt rather than auto reload so that the user can decide
 * when to update. Once the update is accepted the new worker takes control
 * immediately and the page reloads.
 */
export default function PwaUpdater() {
  const [needRefresh, setNeedRefresh] = useState(false);
  const [updateSW, setUpdateSW] = useState<null | ((reload?: boolean) => void)>(null);
  const [remindLater, setRemindLater] = useState(false);

  useEffect(() => {
    const updateServiceWorker = registerSW({
      immediate: true,
      onNeedRefresh() {
        setNeedRefresh(true);
        setRemindLater(true);
      },
      onOfflineReady() {
        // Optionally notify the user that the app can be used offline.
      },
    });
    setUpdateSW(() => updateServiceWorker);

    // Periodically check for updates while the app is open.
    const checkForUpdates = () => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      updateServiceWorker?.(false);
    };
    const interval = setInterval(checkForUpdates, 5 * 60 * 1000);
    window.addEventListener('online', checkForUpdates);

    return () => {
      window.removeEventListener('online', checkForUpdates);
      clearInterval(interval);
    };
  }, []);

  return (
    <>
      <UpdateDialog
        open={needRefresh}
        version={APP_VERSION}
        onClose={() => setNeedRefresh(false)}
        onUpdate={() => {
          // Force the waiting worker to become active and reload the page.
          updateSW?.(true);
        }}
      />
      {remindLater && !needRefresh && (
        <button
          onClick={() => setNeedRefresh(true)}
          style={{
            position: 'fixed',
            right: 12,
            bottom: 52,
            zIndex: 9998,
            background: '#1f2937',
            color: '#fff',
            border: '1px solid #4b5563',
            borderRadius: 999,
            padding: '10px 14px',
            fontWeight: 800,
            boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
          }}
        >
          更新があります（押して適用）
          <span style={{ marginLeft: 6, opacity: 0.85, fontSize: 12 }}>v{APP_VERSION}</span>
        </button>
      )}
    </>
  );
}
