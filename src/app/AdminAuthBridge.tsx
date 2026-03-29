import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { handleAdminAuthCallbackUrl } from '../services/remoteAuth';

export default function AdminAuthBridge() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let active = true;

    const handleUrl = async (url?: string | null) => {
      if (!url || !active) return;
      try {
        const result = await handleAdminAuthCallbackUrl(url);
        if (result.handled && active) {
          navigate(result.nextPath ?? '/admin', { replace: true });
        }
      } catch (error) {
        console.error('Admin auth callback failed', error);
      }
    };

    void CapacitorApp.getLaunchUrl().then(result => {
      void handleUrl(result?.url);
    });

    const listenerPromise = CapacitorApp.addListener('appUrlOpen', ({ url }) => {
      void handleUrl(url);
    });

    return () => {
      active = false;
      void listenerPromise.then(listener => listener.remove());
    };
  }, [navigate]);

  return null;
}
