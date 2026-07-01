import { useEffect, useMemo, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { APP_VERSION, BUILD_DATE } from './version';
import {
  LATEST_RELEASE_API,
  pickPreferredApkAsset,
  resolveApkDownloadUrl,
} from './releaseInfo';
import { startNativeAppUpdate } from '../services/appUpdate';

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const UPDATE_GRACE_MS = 10 * 60 * 1000;

type ReleaseInfo = {
  tag: string;
  publishedAt: string;
  assetUpdatedAt?: string | null;
  htmlUrl: string | null;
  downloadUrl: string;
};

function isNewerRelease(release: ReleaseInfo) {
  const releaseVersion = release.tag.replace(/^v/i, '').trim();
  if (releaseVersion) {
    const versionCompare = compareVersions(releaseVersion, APP_VERSION);
    return versionCompare > 0;
  }

  const buildTime = Date.parse(BUILD_DATE);
  const effectiveTime = release.assetUpdatedAt || release.publishedAt;
  const releaseTime = Date.parse(effectiveTime);
  if (!Number.isFinite(buildTime) || !Number.isFinite(releaseTime)) return false;
  return releaseTime > buildTime + UPDATE_GRACE_MS;
}

function compareVersions(a: string, b: string) {
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

export default function NativeUpdateNotice() {
  const isNative = useMemo(() => Capacitor.isNativePlatform(), []);
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isNative) return;
    let cancelled = false;
    const runCheck = async () => {
      try {
        const resp = await fetch(LATEST_RELEASE_API, {
          headers: { Accept: 'application/vnd.github+json' },
        });
        if (!resp.ok) return;
        const data = await resp.json();
        const assets = Array.isArray(data?.assets) ? data.assets : [];
        const apkAsset = pickPreferredApkAsset(assets);
        const info: ReleaseInfo = {
          tag: data?.tag_name ?? '',
          publishedAt: data?.published_at ?? '',
          assetUpdatedAt: apkAsset?.updated_at ?? apkAsset?.created_at ?? null,
          htmlUrl: data?.html_url ?? null,
          downloadUrl: resolveApkDownloadUrl(apkAsset),
        };
        if (!info.tag || !info.publishedAt) return;
        if (!isNewerRelease(info)) return;
        if (cancelled) return;
        if (!cancelled) setRelease(info);
      } catch {
        // ignore
      }
    };

    void runCheck();
    const intervalId = window.setInterval(runCheck, CHECK_INTERVAL_MS);
    const onFocus = () => {
      void runCheck();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void runCheck();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [isNative]);

  if (!isNative || !release) return null;

  const published = new Date(release.assetUpdatedAt || release.publishedAt);
  const publishedText = Number.isFinite(published.getTime())
    ? published.toLocaleString('ja-JP')
    : release.publishedAt;

  return (
    <div className="native-update-modal" role="dialog" aria-modal="true" aria-labelledby="native-update-title">
      <div className="native-update-card">
        <div id="native-update-title" className="native-update-card__title">アップデートします</div>
        <div className="native-update-card__body">
          新しいアプリがあります。OKを押すと最新版APKを取得し、Androidの更新画面を開きます。
        </div>
        <div className="native-update-card__meta">
          現在: v{APP_VERSION} / 最新: {release.tag}（{publishedText}）
        </div>
        {updateMessage && <div className="native-update-card__message">{updateMessage}</div>}
        <button
          className="native-update-card__button"
          disabled={updating}
          onClick={async () => {
            setUpdating(true);
            setUpdateMessage('更新ファイルを準備しています...');
            try {
              const result = await startNativeAppUpdate(release.downloadUrl);
              if (result.requiresPermission) {
                setUpdateMessage('インストール許可の設定画面を開きました。許可後、もう一度OKを押してください。');
                setUpdating(false);
                return;
              }
              setUpdateMessage('Androidの更新画面を開きました。画面の案内に従って更新してください。');
            } catch (error: any) {
              setUpdateMessage(error?.message ?? 'アップデートを開始できませんでした。通信状態を確認してください。');
              setUpdating(false);
            }
          }}
        >
          {updating ? '準備中...' : 'OK'}
        </button>
      </div>
    </div>
  );
}
