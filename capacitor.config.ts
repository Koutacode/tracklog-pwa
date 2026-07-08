/// <reference types="@capacitor/push-notifications" />

import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.tracklog.assist',
  appName: 'TrackLog運行アシスト',
  webDir: 'dist',
  bundledWebRuntime: false,
  server: {
    androidScheme: 'https',
  },
  android: {
    useLegacyBridge: true,
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['banner', 'list', 'sound'],
    },
  },
};

export default config;
