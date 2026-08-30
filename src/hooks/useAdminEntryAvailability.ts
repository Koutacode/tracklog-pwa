import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { useEffect, useRef, useState } from 'react';
import {
  classifyAdminValidationFailure,
  initialAdminEntryAvailability,
  reduceAdminEntryAvailability,
  type AdminEntryAvailabilityState,
} from '../services/adminSessionPolicy';
import { getAdminSession, onAdminAuthStateChange } from '../services/remoteAuth';

type UseAdminEntryAvailabilityOptions = {
  enabled?: boolean;
};

const ADMIN_ENTRY_REVALIDATE_MS = 60_000;

/**
 * Keeps native/Web admin entry points aligned with the server-validated admin
 * session. This controls visibility only; /admin remains protected by its own
 * server-backed route guard.
 */
export function useAdminEntryAvailability(
  options: UseAdminEntryAvailabilityOptions = {},
) {
  const enabled = options.enabled ?? true;
  const stateRef = useRef<AdminEntryAvailabilityState>(initialAdminEntryAvailability());
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!enabled) {
      stateRef.current = initialAdminEntryAvailability();
      setVisible(false);
      return;
    }

    let active = true;
    let validationSequence = 0;
    let appStateListener: { remove(): Promise<void> } | null = null;
    let resumeListener: { remove(): Promise<void> } | null = null;

    const applyState = (next: AdminEntryAvailabilityState) => {
      stateRef.current = next;
      setVisible(next.visible);
    };

    const refresh = async () => {
      const sequence = ++validationSequence;
      try {
        const session = await getAdminSession();
        if (!active || sequence !== validationSequence) return;
        applyState(reduceAdminEntryAvailability(stateRef.current, {
          kind: 'validated',
          authenticated: session.authenticated,
          isAdmin: session.isAdmin,
        }));
      } catch (cause) {
        if (!active || sequence !== validationSequence) return;
        applyState(reduceAdminEntryAvailability(stateRef.current, {
          kind: 'failed',
          failure: classifyAdminValidationFailure(cause),
        }));
      }
    };

    void refresh();
    const unsubscribe = onAdminAuthStateChange(() => {
      window.setTimeout(() => void refresh(), 0);
    });
    const onOnline = () => void refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(() => void refresh(), ADMIN_ENTRY_REVALIDATE_MS);

    if (Capacitor.isNativePlatform()) {
      void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (active && isActive) void refresh();
      }).then(listener => {
        if (active) appStateListener = listener;
        else void listener.remove();
      }).catch(error => {
        console.warn('Admin entry app-state listener could not be registered', error);
      });
      void CapacitorApp.addListener('resume', () => {
        if (active) void refresh();
      }).then(listener => {
        if (active) resumeListener = listener;
        else void listener.remove();
      }).catch(error => {
        console.warn('Admin entry resume listener could not be registered', error);
      });
    }

    return () => {
      active = false;
      validationSequence += 1;
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
      void appStateListener?.remove();
      void resumeListener?.remove();
    };
  }, [enabled]);

  return visible;
}
