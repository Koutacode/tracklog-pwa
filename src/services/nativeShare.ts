import { Capacitor, registerPlugin } from '@capacitor/core';

type AppSharePlugin = {
  shareTextToPackage(options: {
    packageName: string;
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

export async function shareTextToPackage(options: {
  packageName: string;
  title?: string;
  subject?: string;
  text: string;
}): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  const result = await AppShare.shareTextToPackage(options);
  return !!result.opened;
}

export async function openUrlInPackage(options: {
  url: string;
  packageName?: string;
}): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  const result = await AppShare.openUrl(options);
  return !!result.opened;
}

function encodeFlag(enabled?: boolean): string {
  return enabled ? 'true' : '';
}

function encodeQueryValue(value: string) {
  return encodeURIComponent(value);
}

export async function saveMarkdownToObsidian(options: {
  vault: string;
  file: string;
  content: string;
  silent?: boolean;
  overwrite?: boolean;
  append?: boolean;
}): Promise<boolean> {
  const params = [
    `vault=${encodeQueryValue(options.vault)}`,
    `file=${encodeQueryValue(options.file)}`,
    `content=${encodeQueryValue(options.content)}`,
  ];
  if (options.silent) params.push(`silent=${encodeFlag(true)}`);
  if (options.overwrite) params.push(`overwrite=${encodeFlag(true)}`);
  if (options.append) params.push(`append=${encodeFlag(true)}`);
  const url = `obsidian://new?${params.join('&')}`;
  return openUrlInPackage({ url, packageName: 'md.obsidian' });
}

export async function openNoteInObsidian(options: {
  vault: string;
  file: string;
}): Promise<boolean> {
  const params = [
    `vault=${encodeQueryValue(options.vault)}`,
    `file=${encodeQueryValue(options.file)}`,
  ];
  const url = `obsidian://open?${params.join('&')}`;
  return openUrlInPackage({ url, packageName: 'md.obsidian' });
}
