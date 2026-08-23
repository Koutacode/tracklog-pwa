const DEFAULT_GITHUB_OWNER = 'Koutacode';
const DEFAULT_GITHUB_REPO = 'tracklog-pwa';

export const GITHUB_OWNER =
  typeof __TRACKLOG_GITHUB_OWNER__ === 'string' && __TRACKLOG_GITHUB_OWNER__.trim()
    ? __TRACKLOG_GITHUB_OWNER__
    : DEFAULT_GITHUB_OWNER;
export const GITHUB_REPO =
  typeof __TRACKLOG_GITHUB_REPO__ === 'string' && __TRACKLOG_GITHUB_REPO__.trim()
    ? __TRACKLOG_GITHUB_REPO__
    : DEFAULT_GITHUB_REPO;
// Company distribution relies on one immutable asset name. Keeping this out of
// runtime/build configuration prevents a newer app from accidentally sharing a
// differently named or older APK.
export const RELEASE_APK_NAME = 'tracklog-assist-debug.apk';

export const LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
export const RELEASE_PAGE_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
// This stable alias always resolves through GitHub's current latest release.
// Do not replace it with an asset-specific URL, which would keep pointing at an
// old tag after the next release is published.
export const LATEST_APK_DOWNLOAD_URL = `${RELEASE_PAGE_URL}/download/${RELEASE_APK_NAME}`;
export const PWA_URL = 'https://tracklog-assist.pages.dev';

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
  return null;
}

export function resolveApkDownloadUrl(): string {
  return LATEST_APK_DOWNLOAD_URL;
}
