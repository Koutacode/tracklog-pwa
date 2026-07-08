import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { getDriverIdentity, sendDriverMagicLink, setDriverProfileLocal } from '../../services/remoteAuth';
import { getRemoteSyncState, hydrateRemoteSyncState, runRemoteSync, subscribeRemoteSyncState } from '../../services/remoteSync';
import { shareText } from '../../services/nativeShare';
import { PWA_URL, DEFAULT_APK_DOWNLOAD_URL } from '../../app/releaseInfo';
import { openAppPermissionSettings } from '../../services/nativeSetup';
import type { DriverProfileField } from '../../services/driverProfileValidation';
import {
  normalizePhoneInput,
  normalizeVehicleLabelInput,
  validateDriverProfile,
} from '../../services/driverProfileValidation';

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
  const [approvalStatus, setApprovalStatus] = useState<'unregistered' | 'pending' | 'approved' | 'rejected'>('unregistered');
  const [sendingMagic, setSendingMagic] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [syncState, setSyncState] = useState(getRemoteSyncState());
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<DriverProfileField, string>>>({});

  const isNative = Capacitor.isNativePlatform();
  const standalone = useMemo(() => isStandaloneMode(), []);
  const profileLocked = authInitialized && profileComplete && approvalStatus === 'approved';
  const authStatusLabel = authInitialized ? '認証済み' : email.trim() ? '認証待ち' : '未登録';
  const approvalStatusLabel =
    approvalStatus === 'approved'
      ? '承認済み'
      : approvalStatus === 'rejected'
        ? '拒否済み'
        : authInitialized
          ? '管理者認証待ち'
          : '未申請';
  const syncAvailable = syncState.configured && authInitialized && profileComplete && approvalStatus === 'approved';

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
      setApprovalStatus(identity.approvalStatus);
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
                const text = `【TrackLog 配布用アプリ】\nAndroidはこちらのAPKをインストールしてください。\n${DEFAULT_APK_DOWNLOAD_URL}\n\niPhoneはSafariでこちらを開いてホーム画面に追加してください。\n${PWA_URL}`;
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
                aria-invalid={fieldErrors.displayName ? true : undefined}
              />
              {fieldErrors.displayName && <small className="settings-field-error">{fieldErrors.displayName}</small>}
            </label>
            <label className="settings-field">
              <span>車番・識別名</span>
              <input
                value={vehicleLabel}
                onChange={e => setVehicleLabel(normalizeVehicleLabelInput(e.target.value))}
                placeholder="例: 札幌101か8916"
                disabled={profileLocked}
                aria-invalid={fieldErrors.vehicleLabel ? true : undefined}
              />
              {fieldErrors.vehicleLabel && <small className="settings-field-error">{fieldErrors.vehicleLabel}</small>}
            </label>
            <label className="settings-field">
              <span>電話番号</span>
              <input
                value={phone}
                onChange={e => setPhone(normalizePhoneInput(e.target.value))}
                placeholder="例: 090-1234-5678"
                disabled={profileLocked}
                aria-invalid={fieldErrors.phone ? true : undefined}
              />
              {fieldErrors.phone && <small className="settings-field-error">{fieldErrors.phone}</small>}
            </label>
            <label className="settings-field">
              <span>メールアドレス</span>
              <input
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="例: sample@example.com"
                type="email"
                disabled={profileLocked}
                aria-invalid={fieldErrors.email ? true : undefined}
              />
              {fieldErrors.email && <small className="settings-field-error">{fieldErrors.email}</small>}
            </label>
            <div className="settings-info-row">
              <span>端末ID</span>
              <strong>{syncState.deviceId ?? '未発行'}</strong>
            </div>
            <div className="settings-info-row">
              <span>認証状態</span>
              <strong>{authStatusLabel}</strong>
            </div>
            <div className="settings-info-row">
              <span>利用承認</span>
              <strong>{approvalStatusLabel}</strong>
            </div>
            {authInitialized && profileComplete && approvalStatus !== 'approved' && (
              <div className={`approval-wait-card approval-wait-card--${approvalStatus}`}>
                <strong>{approvalStatusLabel}</strong>
                <span>
                  {approvalStatus === 'rejected'
                    ? '管理者により拒否されています。利用する場合は管理者へ確認してください。'
                    : 'メール認証は完了しています。管理者が許可するまで、運行記録とクラウド同期は利用できません。'}
                </span>
              </div>
            )}
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
                  const validation = validateDriverProfile({ displayName, vehicleLabel, phone, email });
                  setDisplayName(validation.value.displayName);
                  setVehicleLabel(validation.value.vehicleLabel);
                  setPhone(validation.value.phone);
                  setEmail(validation.value.email);
                  setFieldErrors(validation.errors);
                  if (!validation.valid) {
                    setMessage(validation.firstError);
                    return;
                  }
                  await setDriverProfileLocal(validation.value);
                  await sendDriverMagicLink(validation.value.email);
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
                  const validation = validateDriverProfile({ displayName, vehicleLabel, phone, email });
                  setDisplayName(validation.value.displayName);
                  setVehicleLabel(validation.value.vehicleLabel);
                  setPhone(validation.value.phone);
                  setEmail(validation.value.email);
                  setFieldErrors(validation.errors);
                  if (!validation.valid) {
                    setMessage(validation.firstError);
                    return;
                  }
                  await setDriverProfileLocal(validation.value);
                  await hydrateRemoteSyncState();
                  await runRemoteSync('profile-save');
                  const identity = await getDriverIdentity();
                  setAuthInitialized(identity.authInitialized);
                  setProfileComplete(identity.profileComplete);
                  setApprovalStatus(identity.approvalStatus);
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
              <strong>{syncAvailable ? (syncState.syncing ? '同期中' : '常時同期') : syncState.configured ? '承認待ち' : '未設定'}</strong>
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
              disabled={!syncAvailable || syncState.syncing}
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
              PWAの位置・同期更新はアプリを開いている間、操作時、再表示時に行います。
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
