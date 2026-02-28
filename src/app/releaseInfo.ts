const DEFAULT_GITHUB_OWNER = 'Koutacode';
const DEFAULT_GITHUB_REPO = 'tracklog-pwa';
const DEFAULT_RELEASE_APK_NAME = 'tracklog-assist-debug.apk';

export const GITHUB_OWNER =
  typeof __TRACKLOG_GITHUB_OWNER__ === 'string' && __TRACKLOG_GITHUB_OWNER__.trim()
    ? __TRACKLOG_GITHUB_OWNER__
    : DEFAULT_GITHUB_OWNER;
export const GITHUB_REPO =
  typeof __TRACKLOG_GITHUB_REPO__ === 'string' && __TRACKLOG_GITHUB_REPO__.trim()
    ? __TRACKLOG_GITHUB_REPO__
    : DEFAULT_GITHUB_REPO;
export const RELEASE_APK_NAME =
  typeof __TRACKLOG_RELEASE_APK_NAME__ === 'string' && __TRACKLOG_RELEASE_APK_NAME__.trim()
    ? __TRACKLOG_RELEASE_APK_NAME__
    : DEFAULT_RELEASE_APK_NAME;

export const LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
export const RELEASE_PAGE_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
export const DEFAULT_APK_DOWNLOAD_URL = `${RELEASE_PAGE_URL}/download/${RELEASE_APK_NAME}`;

export const PREFERRED_APK_ASSET_NAMES = [
  RELEASE_APK_NAME,
] as const;

export type GithubReleaseAsset = {
  name?: string | null;
  browser_download_url?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

export function pickPreferredApkAsset(assets: GithubReleaseAsset[]): GithubReleaseAsset | null {
  for (const name of PREFERRED_APK_ASSET_NAMES) {
    const found = assets.find(asset => asset?.name === name);
    if (found) return found;
  }
  return assets.find(asset => typeof asset?.name === 'string' && asset.name.toLowerCase().endsWith('.apk')) ?? null;
}

export function resolveApkDownloadUrl(asset: GithubReleaseAsset | null): string {
  const fromAsset = asset?.browser_download_url;
  if (fromAsset && fromAsset.trim().length > 0) return fromAsset;
  return DEFAULT_APK_DOWNLOAD_URL;
}
