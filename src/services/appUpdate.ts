import { Capacitor, registerPlugin } from '@capacitor/core';

type AppUpdatePlugin = {
  installFromUrl(options: { url: string }): Promise<{
    opened: boolean;
    requiresPermission?: boolean;
    openedSettings?: boolean;
  }>;
};

const AppUpdate = registerPlugin<AppUpdatePlugin>('AppUpdate');

export async function startNativeAppUpdate(downloadUrl: string) {
  if (!Capacitor.isNativePlatform()) {
    window.open(downloadUrl, '_blank', 'noopener');
    return { opened: true, requiresPermission: false, openedSettings: false };
  }
  return AppUpdate.installFromUrl({ url: downloadUrl });
}
