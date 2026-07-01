import type { ReactElement } from 'react';
import { useEffect } from 'react';
import { getDriverIdentity, initializeDriverIdentity } from '../services/remoteAuth';

type Props = {
  children: ReactElement;
};

export default function RequireDriverProfile({ children }: Props) {
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const current = await getDriverIdentity();
        if (current.configured && !current.authInitialized && active) {
          await initializeDriverIdentity();
        }
      } catch {
        // The app should stay usable even if cloud identity setup is unavailable.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return children;
}
