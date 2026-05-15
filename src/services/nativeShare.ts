import { Capacitor, registerPlugin } from '@capacitor/core';

type AppSharePlugin = {
  shareText(options: {
    title?: string;
    subject?: string;
    text: string;
  }): Promise<{ opened: boolean }>;
  openUrl(options: {
    url: string;
    packageName?: string;
  }): Promise<{ opened: boolean }>;
};

const AppShare = registerPlugin<AppSharePlugin>('AppShare');

export async function shareText(options: {
  title?: string;
  subject?: string;
  text: string;
}): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  const result = await AppShare.shareText(options);
  return !!result.opened;
}

export async function openExternalUrl(url: string): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  const result = await AppShare.openUrl({ url });
  return !!result.opened;
}
