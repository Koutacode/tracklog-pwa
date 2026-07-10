import { useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { APP_VERSION } from './version';
import { checkLatestAndroidRelease, type AndroidReleaseCheck } from '../services/appVersionCheck';
import { startNativeAppUpdate } from '../services/appUpdate';

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

export default function NativeUpdateNotice() {
  const isNative = useMemo(() => Capacitor.isNativePlatform(), []);
  const [release, setRelease] = useState<AndroidReleaseCheck | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const updateButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!isNative) return;
    let cancelled = false;
    const runCheck = async () => {
      try {
        const info = await checkLatestAndroidRelease();
        if (!info.updateAvailable) return;
        if (cancelled) return;
        setRelease(info);
      } catch {
        // ignore
      }
    };

    void runCheck();
    const intervalId = window.setInterval(runCheck, CHECK_INTERVAL_MS);
    const onFocus = () => {
      setUpdating(false);
      void runCheck();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        setUpdating(false);
        void runCheck();
      }
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

  useEffect(() => {
    if (release) updateButtonRef.current?.focus();
  }, [release?.downloadUrl]);

  if (!isNative || !release) return null;

  const published = new Date(release.publishedAt ?? '');
  const publishedText = Number.isFinite(published.getTime())
    ? published.toLocaleString('ja-JP')
    : release.publishedAt ?? '不明';

  return (
    <div
      aria-describedby="native-update-description native-update-version"
      aria-labelledby="native-update-title"
      aria-modal="true"
      className="native-update-modal"
      role="dialog"
    >
      <div className="native-update-card">
        <div id="native-update-title" className="native-update-card__title">アップデートします</div>
        <div id="native-update-description" className="native-update-card__body">
          新しいアプリがあります。下のボタンを押すと最新版APKを取得し、Androidの更新画面を開きます。
        </div>
        <div id="native-update-version" className="native-update-card__meta">
          現在: v{APP_VERSION} / 最新: {release.tag}（公開: {publishedText}）
        </div>
        {updateMessage && <div aria-live="polite" className="native-update-card__message" role="status">{updateMessage}</div>}
        <button
          aria-label="最新版をインストール"
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
              if (result.upToDate) {
                setUpdateMessage('この端末にはすでに最新版が入っています。');
                setRelease(null);
                setUpdating(false);
                return;
              }
              setUpdateMessage('Androidの更新画面を開きました。画面の案内に従って更新してください。');
            } catch (error: any) {
              setUpdateMessage(error?.message ?? 'アップデートを開始できませんでした。通信状態を確認してください。');
            } finally {
              setUpdating(false);
            }
          }}
          ref={updateButtonRef}
          type="button"
        >
          {updating ? '準備中...' : '最新版をインストール'}
        </button>
      </div>
    </div>
  );
}
