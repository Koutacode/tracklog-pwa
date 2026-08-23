export {};

import type { AndroidReleaseCheck } from './appVersionCheck';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

async function assertRejects(action: () => Promise<unknown>, pattern: RegExp, message: string) {
  let errorMessage = '';
  try {
    await action();
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }
  assert(pattern.test(errorMessage), `${message}: received ${errorMessage || 'no error'}`);
}

async function run() {
  Object.assign(globalThis, {
    __APP_VERSION__: '0.1.53',
    __BUILD_DATE__: 'test',
    __TRACKLOG_GITHUB_OWNER__: 'Koutacode',
    __TRACKLOG_GITHUB_REPO__: 'tracklog-pwa',
    __TRACKLOG_RELEASE_APK_NAME__: 'tracklog-assist-debug.apk',
  });

  const releaseInfo = await import('../app/releaseInfo');
  const versionCheck = await import('./appVersionCheck');
  const distribution = await import('./appDistribution');

  const pinnedAssetUrl = 'https://github.com/Koutacode/tracklog-pwa/releases/download/v0.1.53/tracklog-assist-debug.apk';
  const preferred = releaseInfo.pickPreferredApkAsset([
    { name: 'old-build.apk', browser_download_url: 'https://example.invalid/old.apk' },
    { name: releaseInfo.RELEASE_APK_NAME, browser_download_url: pinnedAssetUrl },
  ]);
  assertEqual(preferred?.name, releaseInfo.RELEASE_APK_NAME, 'the exact configured APK asset is selected');
  assertEqual(
    releaseInfo.pickPreferredApkAsset([{ name: 'some-other-build.apk' }]),
    null,
    'an arbitrary APK is never used as a fallback',
  );
  assertEqual(
    releaseInfo.resolveApkDownloadUrl(),
    'https://github.com/Koutacode/tracklog-pwa/releases/latest/download/tracklog-assist-debug.apk',
    'the download URL always uses the latest-release alias',
  );

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      tag_name: 'v0.1.53',
      assets: [{ name: 'some-other-build.apk', browser_download_url: 'https://example.invalid/other.apk' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    await assertRejects(
      versionCheck.checkLatestAndroidRelease,
      /tracklog-assist-debug\.apk/,
      'a release without the fixed APK asset is rejected',
    );

    globalThis.fetch = async () => new Response(JSON.stringify({
      tag_name: 'v0.1.53',
      assets: [{ name: releaseInfo.RELEASE_APK_NAME }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    await assertRejects(
      versionCheck.checkLatestAndroidRelease,
      /ダウンロード可能な状態ではありません/,
      'an incomplete fixed-name asset is rejected',
    );

    globalThis.fetch = async () => new Response(JSON.stringify({
      tag_name: 'v0.1.53',
      published_at: '2026-08-23T00:00:00.000Z',
      html_url: 'https://github.com/Koutacode/tracklog-pwa/releases/tag/v0.1.53',
      assets: [{
        name: releaseInfo.RELEASE_APK_NAME,
        browser_download_url: pinnedAssetUrl,
        updated_at: '2026-08-23T00:01:00.000Z',
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const checked = await versionCheck.checkLatestAndroidRelease();
    assertEqual(
      checked.downloadUrl,
      releaseInfo.LATEST_APK_DOWNLOAD_URL,
      'version-specific asset URLs are replaced by the stable latest alias',
    );
    assertEqual(checked.updateAvailable, false, 'the same published version does not show an update');

    globalThis.fetch = async () => new Response(JSON.stringify({
      tag_name: 'v0.1.54',
      published_at: '2026-08-23T00:03:00.000Z',
      assets: [{
        name: releaseInfo.RELEASE_APK_NAME,
        browser_download_url: pinnedAssetUrl.replace('v0.1.53', 'v0.1.54'),
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const newer = await versionCheck.checkLatestAndroidRelease();
    assertEqual(newer.updateAvailable, true, 'a newer published APK triggers the existing install notice');
    assertEqual(newer.downloadUrl, releaseInfo.LATEST_APK_DOWNLOAD_URL, 'the install notice uses the latest alias');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const makeRelease = (latestVersion: string): AndroidReleaseCheck => ({
    kind: 'android',
    currentVersion: '0.1.53',
    latestVersion,
    tag: `v${latestVersion}`,
    publishedAt: '2026-08-23T00:00:00.000Z',
    assetUpdatedAt: '2026-08-23T00:01:00.000Z',
    htmlUrl: `https://github.com/Koutacode/tracklog-pwa/releases/tag/v${latestVersion}`,
    downloadUrl: releaseInfo.LATEST_APK_DOWNLOAD_URL,
    updateAvailable: versionCheck.compareVersions(latestVersion, '0.1.53') > 0,
    checkedAt: '2026-08-23T00:02:00.000Z',
  });

  let olderBlocked = false;
  try {
    distribution.createLatestApkSharePayload(makeRelease('0.1.52'), '0.1.53');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    olderBlocked = message.includes('端末内は v0.1.53') && message.includes('公開版は v0.1.52');
  }
  assert(olderBlocked, 'sharing is blocked with both versions when the published APK is older');

  const payload = distribution.createLatestApkSharePayload(makeRelease('0.1.53'), '0.1.53');
  assertEqual(payload.url, releaseInfo.LATEST_APK_DOWNLOAD_URL, 'share payload uses only the latest alias');
  assert(payload.text.includes(releaseInfo.LATEST_APK_DOWNLOAD_URL), 'share text contains the direct APK URL');
  assert(!payload.text.includes(releaseInfo.PWA_URL), 'share text does not include the compatibility PWA');
  assert(!payload.text.includes(pinnedAssetUrl), 'share text does not pin an old release tag');

  let nativeShareCalls = 0;
  let clipboardText = '';
  const clipboardResult = await distribution.shareLatestAndroidApk({
    checkRelease: async () => makeRelease('0.1.53'),
    nativeShare: async () => {
      nativeShareCalls += 1;
      return false;
    },
    webShare: null,
    copyText: async text => {
      clipboardText = text;
    },
  });
  assertEqual(nativeShareCalls, 1, 'native sharing is attempted once');
  assertEqual(clipboardResult.delivery, 'clipboard', 'clipboard is the final fallback');
  assertEqual(clipboardText, payload.text, 'clipboard fallback copies the verified APK share text');

  let blockedShareCalls = 0;
  await assertRejects(
    () => distribution.shareLatestAndroidApk({
      checkRelease: async () => makeRelease('0.1.52'),
      nativeShare: async () => {
        blockedShareCalls += 1;
        return true;
      },
      webShare: null,
      copyText: async () => undefined,
    }),
    /まだ公開されていないため共有できません/,
    'an older published release is blocked before opening a share target',
  );
  assertEqual(blockedShareCalls, 0, 'no share target is opened for an older public APK');

  let copiedUrl = '';
  const copied = await distribution.copyLatestAndroidApkUrl({
    checkRelease: async () => makeRelease('0.1.54'),
    nativeCopyText: async () => null,
    copyText: async text => {
      copiedUrl = text;
    },
  });
  assertEqual(copiedUrl, releaseInfo.LATEST_APK_DOWNLOAD_URL, 'copy action copies only the verified latest alias');
  assertEqual(copied.release.latestVersion, '0.1.54', 'copy action returns the verified public version');

  console.log('appDistribution: 19 tests passed');
}

void run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
