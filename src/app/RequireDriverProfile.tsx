import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { getDriverIdentity, initializeDriverIdentity } from '../services/remoteAuth';

type Props = {
  children: ReactElement;
};

export default function RequireDriverProfile({ children }: Props) {
  const location = useLocation();
  const [loading, setLoading] = useState(true);
  const [profileComplete, setProfileComplete] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const current = await getDriverIdentity();
        if (current.configured) {
          const initialized = current.authInitialized ? current : await initializeDriverIdentity();
          if (active) {
            setProfileComplete(initialized.profileComplete);
          }
        } else if (active) {
          setProfileComplete(current.profileComplete);
        }
      } catch {
        if (active) setProfileComplete(false);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (loading) {
    return <div style={{ padding: 24, color: '#fff' }}>プロフィール確認中…</div>;
  }

  if (!profileComplete) {
    const next = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={`/setup?next=${encodeURIComponent(next)}`} replace />;
  }

  return children;
}
