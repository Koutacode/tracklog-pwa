import { useEffect } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import {
  initNativeAdminMessageActions,
  retryPendingAdminMessageLocationRequests,
} from '../services/adminMessages';
import { initNativeExpresswayPrompt } from '../services/nativeExpresswayPrompt';
import { initNativeAdminMessagePushActions } from '../services/pushRegistration';
import { initNativeLocalNotificationActions } from '../services/nativeLocalNotificationActions';
import { startNativeExpresswayPromptLifecycle } from './nativeExpresswayPromptLifecycle';

export default function NativeExpresswayPromptBootstrap() {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    return startNativeExpresswayPromptLifecycle({
      initialize: async () => {
        // Capacitor retained actions are consumed by the first local listener.
        // Install the shared kind dispatcher before channel or push setup.
        await initNativeLocalNotificationActions();
        await Promise.all([
          initNativeExpresswayPrompt(),
          initNativeAdminMessageActions(),
          initNativeAdminMessagePushActions(),
          retryPendingAdminMessageLocationRequests(),
        ]);
      },
      registerResume: listener => CapacitorApp.addListener('resume', () => listener()),
    });
  }, []);

  return null;
}
