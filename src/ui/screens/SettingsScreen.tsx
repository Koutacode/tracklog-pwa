import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { getDriverIdentity, sendDriverMagicLink, setDriverProfileLocal } from '../../services/remoteAuth';
import { getRemoteSyncState, hydrateRemoteSyncState, runRemoteSync, subscribeRemoteSyncState } from '../../services/remoteSync';
import { shareText } from '../../services/nativeShare';
import { PWA_URL, DEFAULT_APK_DOWNLOAD_URL } from '../../app/releaseInfo';
import { openAppPermissionSettings } from '../../services/nativeSetup';

function isStandaloneMode() {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true;
}

export default function SettingsScreen() {
  const [displayName, setDisplayName] = useState('');
  const [vehicleLabel, setVehicleLabel] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [authInitialized, setAuthInitialized] = useState(false);
  const [profileComplete, setProfileComplete] = useState(false);
  const [sendingMagic, setSendingMagic] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [syncState, setSyncState] = useState(getRemoteSyncState());

  const isNative = Capacitor.isNativePlatform();
  const standalone = useMemo(() => isStandaloneMode(), []);
  const profileLocked = authInitialized && profileComplete;
  const authStatusLabel = authInitialized ? '認証済み' : email.trim() ? '認証待ち' : '未登録';

  useEffect(() => {
    let active = true;
    void (async () => {
      const identity = await getDriverIdentity();
      if (!active) return;
      setDisplayName(identity.displayName);
      setVehicleLabel(identity.vehicleLabel);
      setPhone(identity.phone);
      setEmail(identity.email || '');
      setAuthInitialized(identity.authInitialized);
      setProfileComplete(identity.profileComplete);
    })();
    void hydrateRemoteSyncState();
    const unsubscribe = subscribeRemoteSyncState(next => {
      if (active) setSyncState(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return (
    <div className="screen-shell">
      <div className="screen-card">
        <div className="screen-card__header">
          <div>
            <div className="screen-card__eyebrow">同期と端末情報</div>
            <h1 className="screen-card__title">端末設定</h1>
          </div>
          <div className="screen-card__actions">
            <button
              className="pill-link"
              onClick={async () => {
                const url = PWA_URL;
                const text = `【TrackLog 配布用アプリ】\nAndroidはAPK、iPhoneはSafariで以下のURLを開いてホーム画面に追加してください。\n${url}`;
                try {
                  const shared = await shareText({ title: 'TrackLog アプリを共有', text });
                  if (!shared && navigator.share) {
                    await navigator.share({ title: 'TrackLog アプリ', text });
                  } else if (!shared) {
                    await navigator.clipboard.writeText(text);
                    setMessage('クリップボードにURLをコピーしました');
                  }
                } catch (e) {
                  console.error(e);
                  await navigator.clipboard.writeText(text);
                  setMessage('クリップボードにURLをコピーしました');
                }
              }}
            >
              アプリ共有
            </button>
            <Link to="/" className="pill-link">
              ホーム
            </Link>
            <Link to="/login" className="pill-link">
              管理者ログイン
            </Link>
          </div>
        </div>

        <section className="settings-grid">
          <article className="card settings-panel">
            <div className="settings-panel__title">端末プロフィール</div>
            <label className="settings-field">
              <span>表示名</span>
              <input
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="例: 札幌便 1号車"
                disabled={profileLocked}
              />
            </label>
            <label className="settings-field">
              <span>車番・識別名</span>
              <input
                value={vehicleLabel}
                onChange={e => setVehicleLabel(e.target.value)}
                placeholder="例: 札幌 100 あ 1234"
                disabled={profileLocked}
              />
            </label>
            <label className="settings-field">
              <span>電話番号</span>
              <input
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="例: 090-1234-5678"
                disabled={profileLocked}
              />
            </label>
            <label className="settings-field">
              <span>メールアドレス</span>
              <input
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="例: sample@example.com"
                type="email"
                disabled={profileLocked}
              />
            </label>
            <div className="settings-info-row">
              <span>端末ID</span>
              <strong>{syncState.deviceId ?? '未発行'}</strong>
            </div>
            <div className="settings-info-row">
              <span>認証状態</span>
              <strong>{authStatusLabel}</strong>
            </div>
            {profileLocked && (
              <div className="settings-note">
                登録済みプロフィールは不正利用防止のため、この端末からは変更できません。
              </div>
            )}
            <button
              className="trip-btn"
              disabled={profileLocked || !email.trim() || sendingMagic}
              onClick={async () => {
                setMessage(null);
                setSendingMagic(true);
                try {
                  await sendDriverMagicLink(email);
                  setMessage('認証リンクを送信しました。メールから開いて再度端末を更新してください。');
                } catch (error: any) {
                  setMessage(error?.message ?? '認証リンク送信に失敗しました');
                } finally {
                  setSendingMagic(false);
                }
              }}
            >
              {sendingMagic ? '送信中…' : '認証メールを送信'}
            </button>
            <button
              className="trip-btn trip-btn--primary"
              disabled={profileLocked || saving}
              onClick={async () => {
                setSaving(true);
                setMessage(null);
                try {
                  await setDriverProfileLocal({ displayName, vehicleLabel, phone, email });
                  await hydrateRemoteSyncState();
                  await runRemoteSync('profile-save');
                  const identity = await getDriverIdentity();
                  setAuthInitialized(identity.authInitialized);
                  setProfileComplete(identity.profileComplete);
                  setMessage('端末プロフィールを保存しました');
                } catch (error: any) {
                  setMessage(error?.message ?? '保存に失敗しました');
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saving ? '保存中…' : '保存して同期'}
            </button>
          </article>

          <article className="card settings-panel">
            <div className="settings-panel__title">クラウド同期</div>
            <div className="settings-note">クラウド同期は常時有効です。操作や記録のたびに自動で同期します。</div>
            <div className="settings-info-row">
              <span>状態</span>
              <strong>{syncState.configured ? (syncState.syncing ? '同期中' : '常時同期') : '未設定'}</strong>
            </div>
            <div className="settings-info-row">
              <span>最終同期</span>
              <strong>{syncState.lastSyncAt ? new Date(syncState.lastSyncAt).toLocaleString('ja-JP') : 'まだありません'}</strong>
            </div>
            <div className="settings-info-row">
              <span>最終エラー</span>
              <strong>{syncState.lastError ?? 'なし'}</strong>
            </div>
            <button
              className="trip-btn"
              disabled={!syncState.configured || syncState.syncing}
              onClick={async () => {
                setMessage(null);
                await runRemoteSync('manual');
              }}
            >
              今すぐ同期
            </button>
          </article>

          <article className="card settings-panel">
            <div className="settings-panel__title">PWA / 配布</div>
            <div className="settings-info-row">
              <span>実行形態</span>
              <strong>{isNative ? 'Android ネイティブ' : standalone ? 'PWA' : 'ブラウザ'}</strong>
            </div>
            <div className="settings-note">
              iPhone等でPWAとして利用するには、以下の共有URLを Safari で開いて「ホーム画面に追加」してください。
            </div>
            <div className="settings-card__actions" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                className="trip-btn"
                style={{ flex: 1, minWidth: '140px' }}
                onClick={() => {
                  const url = PWA_URL;
                  navigator.clipboard.writeText(url).then(() => {
                    setMessage('共有URLをコピーしました');
                  }).catch(() => {
                    setMessage('コピーに失敗しました');
                  });
                }}
              >
                共有URLをコピー
              </button>
              {!isNative && (
                <a
                  href={DEFAULT_APK_DOWNLOAD_URL}
                  className="trip-btn trip-btn--ghost"
                  style={{ flex: 1, minWidth: '140px', textAlign: 'center', textDecoration: 'none' }}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Android用APKをDL
                </a>
              )}
            </div>
            <div className="settings-note" style={{ marginTop: '1rem' }}>
              管理画面は同じ URL の <code>/admin</code> で開きます。
            </div>
            {isNative && (
              <Link
                to="/admin"
                className="trip-btn"
                style={{ textAlign: 'center', textDecoration: 'none', display: 'block' }}
              >
                アプリ内で管理画面を開く
              </Link>
            )}
          </article>

          {isNative && (
            <article className="card settings-panel">
              <div className="settings-panel__title">アプリの権限設定</div>
              <div className="settings-note">
                位置情報（常に許可）などのシステム権限を変更するには、OSの設定画面を開いてください。<br />
                ※Androidの制限により、権限はユーザー自身で許可する必要があります。
              </div>
              <button
                className="trip-btn"
                onClick={async () => {
                  try {
                    const opened = await openAppPermissionSettings();
                    if (!opened) setMessage('設定画面を開けませんでした');
                  } catch (e: any) {
                    setMessage('設定画面を開けませんでした');
                  }
                }}
              >
                OSの権限設定を開く
              </button>
            </article>
          )}
        </section>

        {message && <div className="settings-toast">{message}</div>}
      </div>
    </div>
  );
}
