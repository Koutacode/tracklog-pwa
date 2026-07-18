import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { handleAdminAuthCallbackUrl, handleDriverAuthCallbackUrl } from '../services/remoteAuth';

type NativeAuthCallbackResult = {
  handled: boolean;
  nextPath?: string;
};

const nativeAuthCallbackTasks = new Map<string, Promise<NativeAuthCallbackResult>>();

function callbackKey(url: string) {
  let hash = 2166136261;
  for (let index = 0; index < url.length; index++) {
    hash ^= url.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function getNativeAuthCallbackTask(url: string) {
  const key = callbackKey(url);
  const existing = nativeAuthCallbackTasks.get(key);
  if (existing) return existing;
  const task = (async () => {
    const adminResult = await handleAdminAuthCallbackUrl(url);
    return adminResult.handled ? adminResult : handleDriverAuthCallbackUrl(url);
  })();
  nativeAuthCallbackTasks.set(key, task);
  void task.catch(() => {
    nativeAuthCallbackTasks.delete(key);
  });
  return task;
}

export default function AdminAuthBridge() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let active = true;

    const handleUrl = async (url?: string | null) => {
      if (!url || !active) return;
      try {
        const result = await getNativeAuthCallbackTask(url);
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
