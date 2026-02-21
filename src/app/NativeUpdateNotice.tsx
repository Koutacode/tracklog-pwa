import { useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { APP_VERSION, BUILD_DATE } from './version';

const LATEST_RELEASE_API = 'https://api.github.com/repos/Koutacode/tracklog-pwa/releases/latest';
const LATEST_APK_URL = 'https://github.com/Koutacode/tracklog-pwa/releases/latest/download/tracklog-debug.apk';
const RELEASE_PAGE_URL = 'https://github.com/Koutacode/tracklog-pwa/releases/latest';
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const UPDATE_GRACE_MS = 2 * 60 * 1000;
const DISMISS_KEY = 'tracklog-dismissed-release';

type ReleaseInfo = {
  tag: string;
  publishedAt: string;
  assetUpdatedAt?: string | null;
  htmlUrl: string | null;
};

function isNewerRelease(release: ReleaseInfo) {
  const buildTime = Date.parse(BUILD_DATE);
  const effectiveTime = release.assetUpdatedAt || release.publishedAt;
  const releaseTime = Date.parse(effectiveTime);
  if (!Number.isFinite(buildTime) || !Number.isFinite(releaseTime)) return false;
  return releaseTime > buildTime + UPDATE_GRACE_MS;
}

async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fallback below
  }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', 'true');
    el.style.position = 'absolute';
    el.style.left = '-9999px';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

export default function NativeUpdateNotice() {
  const isNative = useMemo(() => Capacitor.isNativePlatform(), []);
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

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
        const apkAsset = assets.find((asset: any) => asset?.name === 'tracklog-debug.apk');
        const info: ReleaseInfo = {
          tag: data?.tag_name ?? '',
          publishedAt: data?.published_at ?? '',
          assetUpdatedAt: apkAsset?.updated_at ?? apkAsset?.created_at ?? null,
          htmlUrl: data?.html_url ?? null,
        };
        if (!info.tag || !info.publishedAt) return;
        if (!isNewerRelease(info)) return;
        const effectiveTime = info.assetUpdatedAt || info.publishedAt;
        const dismissKey = `${info.tag}:${effectiveTime}`;
        const dismissed = localStorage.getItem(DISMISS_KEY);
        if (dismissed && dismissed === dismissKey) return;
        if (cancelled) return;
        if (!cancelled) setRelease(info);
      } catch {
        // ignore
      }
    };

    void runCheck();
    const intervalId = window.setInterval(runCheck, CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [isNative]);

  useEffect(() => {
    return () => {
      if (copyTimer.current != null) {
        window.clearTimeout(copyTimer.current);
        copyTimer.current = null;
      }
    };
  }, []);

  if (!isNative || !release) return null;

  const published = new Date(release.assetUpdatedAt || release.publishedAt);
  const publishedText = Number.isFinite(published.getTime())
    ? published.toLocaleString('ja-JP')
    : release.publishedAt;

  return (
    <div
      style={{
        position: 'fixed',
        top: 'calc(12px + env(safe-area-inset-top))',
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'min(94vw, 640px)',
        zIndex: 9999,
      }}
    >
      <div
        className="card"
        style={{
          padding: 12,
          borderRadius: 16,
          border: '1px solid rgba(59, 130, 246, 0.5)',
          background: 'rgba(15, 23, 42, 0.95)',
        }}
      >
        <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 6 }}>新しいバージョンがあります</div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)' }}>
          現在: v{APP_VERSION} / 最新: {release.tag}（{publishedText}）
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          <button className="trip-btn" onClick={() => window.open(LATEST_APK_URL, '_blank', 'noopener')}>
            ダウンロード
          </button>
          <button
            className="trip-btn"
            onClick={async () => {
              const ok = await copyText(LATEST_APK_URL);
              if (!ok) return;
              setCopied(true);
              if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
              copyTimer.current = window.setTimeout(() => {
                setCopied(false);
                copyTimer.current = null;
              }, 2000);
            }}
          >
            URLコピー
          </button>
          <button
            className="trip-btn trip-btn--ghost"
            onClick={() => window.open(release.htmlUrl || RELEASE_PAGE_URL, '_blank', 'noopener')}
          >
            リリースページ
          </button>
          <button
            className="trip-btn trip-btn--ghost"
            onClick={() => {
              const effectiveTime = release.assetUpdatedAt || release.publishedAt;
              localStorage.setItem(DISMISS_KEY, `${release.tag}:${effectiveTime}`);
              setRelease(null);
            }}
          >
            あとで
          </button>
        </div>
        {copied && <div style={{ fontSize: 12, color: '#86efac', marginTop: 6 }}>コピーしました</div>}
      </div>
    </div>
  );
}
