import { APP_VERSION } from '../app/version';
import { LATEST_APK_DOWNLOAD_URL } from '../app/releaseInfo';
import {
  checkLatestAndroidRelease,
  compareVersions,
  type AndroidReleaseCheck,
} from './appVersionCheck';
import { copyNativeText, shareText } from './nativeShare';

const SHARE_TITLE = 'TrackLog Androidアプリ';

export type LatestApkSharePayload = {
  title: string;
  text: string;
  url: string;
  publishedVersion: string;
};

export type LatestApkShareResult = {
  delivery: 'native-share' | 'web-share' | 'clipboard' | 'cancelled';
  release: AndroidReleaseCheck;
  payload: LatestApkSharePayload;
};

type LatestApkDistributionDependencies = {
  checkRelease: () => Promise<AndroidReleaseCheck>;
  nativeShare: typeof shareText;
  webShare: ((data: ShareData) => Promise<void>) | null;
  copyText: (text: string) => Promise<void>;
  nativeCopyText: typeof copyNativeText;
};

function isShareCancelled(error: unknown) {
  return !!error
    && typeof error === 'object'
    && 'name' in error
    && (error as { name?: unknown }).name === 'AbortError';
}

function getDefaultWebShare(): LatestApkDistributionDependencies['webShare'] {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return null;
  return data => navigator.share(data);
}

async function defaultCopyText(text: string) {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    throw new Error('この端末ではURLをコピーできません');
  }
  await navigator.clipboard.writeText(text);
}

export function createLatestApkSharePayload(
  release: AndroidReleaseCheck,
  currentVersion = APP_VERSION,
): LatestApkSharePayload {
  if (compareVersions(release.latestVersion, currentVersion) < 0) {
    throw new Error(
      `最新版APKがまだ公開されていないため共有できません。`
      + `端末内は v${currentVersion}、公開版は v${release.latestVersion} です。`
      + `v${currentVersion} 以上を公開してから再度お試しください。`,
    );
  }

  return {
    title: SHARE_TITLE,
    text: `【TrackLog Androidアプリ】\n最新版APK（v${release.latestVersion}）はこちらからダウンロードしてください。\n${LATEST_APK_DOWNLOAD_URL}`,
    url: LATEST_APK_DOWNLOAD_URL,
    publishedVersion: release.latestVersion,
  };
}

export async function prepareLatestApkShare(
  checkRelease: () => Promise<AndroidReleaseCheck> = checkLatestAndroidRelease,
): Promise<{ release: AndroidReleaseCheck; payload: LatestApkSharePayload }> {
  const release = await checkRelease();
  return {
    release,
    payload: createLatestApkSharePayload(release),
  };
}

export async function shareLatestAndroidApk(
  overrides: Partial<LatestApkDistributionDependencies> = {},
): Promise<LatestApkShareResult> {
  const prepared = await prepareLatestApkShare(overrides.checkRelease ?? checkLatestAndroidRelease);
  const nativeShare = overrides.nativeShare ?? shareText;

  try {
    if (await nativeShare({ title: prepared.payload.title, text: prepared.payload.text })) {
      return { ...prepared, delivery: 'native-share' };
    }
  } catch (error) {
    if (isShareCancelled(error)) return { ...prepared, delivery: 'cancelled' };
  }

  const webShare = overrides.webShare === undefined ? getDefaultWebShare() : overrides.webShare;
  if (webShare) {
    try {
      await webShare({ title: prepared.payload.title, text: prepared.payload.text });
      return { ...prepared, delivery: 'web-share' };
    } catch (error) {
      if (isShareCancelled(error)) return { ...prepared, delivery: 'cancelled' };
    }
  }

  await (overrides.copyText ?? defaultCopyText)(prepared.payload.text);
  return { ...prepared, delivery: 'clipboard' };
}

export async function copyLatestAndroidApkUrl(
  overrides: Pick<Partial<LatestApkDistributionDependencies>, 'checkRelease' | 'copyText' | 'nativeCopyText'> = {},
) {
  const prepared = await prepareLatestApkShare(overrides.checkRelease ?? checkLatestAndroidRelease);
  const nativeCopy = overrides.nativeCopyText ?? copyNativeText;
  const copiedLength = await nativeCopy({
    label: 'TrackLog 最新APK URL',
    text: prepared.payload.url,
  });
  if (copiedLength == null) {
    await (overrides.copyText ?? defaultCopyText)(prepared.payload.url);
  }
  return prepared;
}
