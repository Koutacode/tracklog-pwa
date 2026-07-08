import { APP_VERSION, BUILD_DATE } from '../app/version';
import {
  LATEST_RELEASE_API,
  pickPreferredApkAsset,
  resolveApkDownloadUrl,
} from '../app/releaseInfo';

const PWA_RELOAD_KEY = 'tracklog-pwa-reloaded-build';
const PWA_CACHE_PREFIX = 'tracklog-';

export type VersionManifest = {
  version?: string;
  buildDate?: string;
};

export type AndroidReleaseCheck = {
  kind: 'android';
  currentVersion: string;
  latestVersion: string;
  tag: string;
  publishedAt: string | null;
  assetUpdatedAt: string | null;
  htmlUrl: string | null;
  downloadUrl: string;
  updateAvailable: boolean;
  checkedAt: string;
};

export type PwaBuildCheck = {
  kind: 'pwa';
  currentVersion: string;
  currentBuildDate: string;
  latestVersion: string | null;
  latestBuildDate: string | null;
  updateAvailable: boolean;
  checkedAt: string;
};

function parseTime(value: string | undefined | null) {
  const time = Date.parse(value ?? '');
  return Number.isFinite(time) ? time : 0;
}

export function compareVersions(a: string, b: string) {
  const aParts = a.split(/[.-]/).map(part => Number.parseInt(part, 10));
  const bParts = b.split(/[.-]/).map(part => Number.parseInt(part, 10));
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i += 1) {
    const av = Number.isFinite(aParts[i]) ? aParts[i] : 0;
    const bv = Number.isFinite(bParts[i]) ? bParts[i] : 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

export function isNewerVersion(nextVersion: string | null | undefined, currentVersion = APP_VERSION) {
  const normalized = nextVersion?.replace(/^v/i, '').trim();
  if (!normalized) return false;
  return compareVersions(normalized, currentVersion) > 0;
}

export function isDifferentPwaBuild(manifest: VersionManifest) {
  const nextVersion = manifest.version?.trim();
  const nextBuildDate = manifest.buildDate?.trim();
  if (!nextVersion && !nextBuildDate) return false;
  if (nextVersion && nextVersion !== APP_VERSION) return true;
  return parseTime(nextBuildDate) > parseTime(BUILD_DATE);
}

export async function checkLatestAndroidRelease(): Promise<AndroidReleaseCheck> {
  const resp = await fetch(`${LATEST_RELEASE_API}?ts=${Date.now()}`, {
    cache: 'no-store',
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!resp.ok) throw new Error(`GitHub Releaseを確認できませんでした (${resp.status})`);

  const data = await resp.json();
  const assets = Array.isArray(data?.assets) ? data.assets : [];
  const apkAsset = pickPreferredApkAsset(assets);
  const tag = typeof data?.tag_name === 'string' ? data.tag_name : '';
  const latestVersion = tag.replace(/^v/i, '').trim();
  if (!latestVersion) throw new Error('GitHub Releaseのバージョンを確認できませんでした');

  return {
    kind: 'android',
    currentVersion: APP_VERSION,
    latestVersion,
    tag,
    publishedAt: typeof data?.published_at === 'string' ? data.published_at : null,
    assetUpdatedAt: apkAsset?.updated_at ?? apkAsset?.created_at ?? null,
    htmlUrl: typeof data?.html_url === 'string' ? data.html_url : null,
    downloadUrl: resolveApkDownloadUrl(apkAsset),
    updateAvailable: isNewerVersion(latestVersion),
    checkedAt: new Date().toISOString(),
  };
}

export async function checkLatestPwaBuild(): Promise<PwaBuildCheck> {
  const resp = await fetch(`/version.json?ts=${Date.now()}`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`PWAバージョンを確認できませんでした (${resp.status})`);

  const manifest = (await resp.json()) as VersionManifest;
  return {
    kind: 'pwa',
    currentVersion: APP_VERSION,
    currentBuildDate: BUILD_DATE,
    latestVersion: manifest.version?.trim() || null,
    latestBuildDate: manifest.buildDate?.trim() || null,
    updateAvailable: isDifferentPwaBuild(manifest),
    checkedAt: new Date().toISOString(),
  };
}

async function clearTrackLogCaches() {
  if (typeof window === 'undefined' || !('caches' in window)) return;
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith(PWA_CACHE_PREFIX)).map(key => caches.delete(key)));
}

async function activateWaitingWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  if (registration?.waiting) {
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  }
}

export async function reloadPwaForLatestBuild(manifest?: VersionManifest, options?: { force?: boolean }) {
  const key = `${manifest?.version ?? 'manual'}:${manifest?.buildDate ?? Date.now()}`;
  if (typeof sessionStorage !== 'undefined') {
    if (!options?.force && sessionStorage.getItem(PWA_RELOAD_KEY) === key) return false;
    sessionStorage.setItem(PWA_RELOAD_KEY, key);
  }
  await activateWaitingWorker();
  await clearTrackLogCaches();
  window.location.reload();
  return true;
}
