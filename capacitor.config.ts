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
};

export default config;
