import { Capacitor, registerPlugin } from '@capacitor/core';

type AppSharePlugin = {
  shareText(options: {
    title?: string;
    subject?: string;
    text: string;
  }): Promise<{ opened: boolean }>;
  copyText(options: {
    label?: string;
    text: string;
  }): Promise<{ copiedLength: number }>;
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

export async function copyNativeText(options: {
  label?: string;
  text: string;
}): Promise<number | null> {
  if (!Capacitor.isNativePlatform()) return null;
  const result = await AppShare.copyText(options);
  return Number.isFinite(result.copiedLength) ? result.copiedLength : null;
}

export async function openExternalUrl(url: string): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  const result = await AppShare.openUrl({ url });
  return !!result.opened;
}
