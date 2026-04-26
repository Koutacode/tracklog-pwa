import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';

export default function PwaBootstrap() {
  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // silent fallback for local preview or browsers that reject registration
    });
  }, []);

  return null;
}
