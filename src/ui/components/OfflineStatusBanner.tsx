import { useEffect, useState } from 'react';

export default function OfflineStatusBanner() {
  const [offline, setOffline] = useState(() => !navigator.onLine);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  if (!offline) return null;

  return (
    <div className="offline-status-banner" role="status" aria-live="polite">
      オフライン - 端末に保存済みの記録を表示しています
    </div>
  );
}
