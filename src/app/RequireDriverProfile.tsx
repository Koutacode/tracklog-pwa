import type { FormEvent, ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DriverIdentity } from '../domain/remoteTypes';
import {
  getDriverIdentity,
  initializeDriverIdentity,
  sendDriverMagicLink,
  setDriverProfileLocal,
  verifyDriverEmailOtp,
} from '../services/remoteAuth';
import type { DriverProfileField } from '../services/driverProfileValidation';
import {
  normalizePhoneInput,
  toHalfWidthDigits,
  normalizeVehicleLabelInput,
  validateDriverProfile,
} from '../services/driverProfileValidation';
import { hydrateRemoteSyncState, runRemoteSync } from '../services/remoteSync';
import {
  checkNativeSetupReadiness,
  openAppPermissionSettings,
  openExactAlarmSettings,
  openSystemLocationSettings,
  requestBatteryOptimizationExemption,
  runNativeQuickSetup,
} from '../services/nativeSetup';
import type { NativeSetupReadiness } from '../services/nativeSetup';

type Props = {
  children: ReactElement;
};

function hasApprovedProfile(identity: DriverIdentity | null) {
  if (!identity) return false;
  if (!identity.configured) return false;
  return identity.authInitialized && identity.profileComplete && identity.approvalStatus === 'approved';
}

function getApprovalLabel(identity: DriverIdentity) {
  if (!identity.configured) return 'クラウド未設定';
  if (!identity.authInitialized) return 'メール認証待ち';
  if (!identity.profileComplete) return '登録情報不足';
  if (identity.approvalStatus === 'approved') return '承認済み';
  if (identity.approvalStatus === 'rejected') return '拒否済み';
  return '管理者認証待ち';
}

function formatDriverAuthError(error: any) {
  const raw = `${error?.message ?? error ?? ''}`.trim();
  if (!raw) return '認証に失敗しました';
  const normalized = raw.toLowerCase();
  if (
    normalized.includes('rate limit') ||
    normalized.includes('email rate limit') ||
    normalized.includes('over_email_send_rate_limit')
  ) {
    return 'メール送信の上限に達しています。少し待ってから再度試してください。';
  }
  if (normalized.includes('otp') || normalized.includes('token')) {
    return '6桁コードが無効です。最新の認証メールで再度試してください。';
  }
  return raw;
}

function DriverRegistrationGate(props: {
  identity: DriverIdentity;
  loading: boolean;
  onRefresh: () => Promise<void>;
}) {
  const { identity, loading, onRefresh } = props;
  const [displayName, setDisplayName] = useState(identity.displayName);
  const [vehicleLabel, setVehicleLabel] = useState(identity.vehicleLabel);
  const [phone, setPhone] = useState(identity.phone);
  const [email, setEmail] = useState(identity.email ?? '');
  const [otpToken, setOtpToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<DriverProfileField, string>>>({});

  useEffect(() => {
    setDisplayName(identity.displayName);
    setVehicleLabel(identity.vehicleLabel);
    setPhone(identity.phone);
    setEmail(identity.email ?? '');
  }, [identity]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
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
    setBusy(true);
    setMessage(null);
    try {
      await setDriverProfileLocal(validation.value);
      await hydrateRemoteSyncState();
      if (identity.configured && !identity.authInitialized) {
        await sendDriverMagicLink(validation.value.email);
        setMessage('認証メールを送信しました。メール本文の6桁コードをこの画面に入力してください。リンクで認証した場合は「認証状態を更新」を押してください。');
      } else {
        await runRemoteSync('profile-registration');
        setMessage('端末プロフィールを保存しました。管理者の承認後に利用できます。');
      }
      await onRefresh();
    } catch (error: any) {
      setMessage(formatDriverAuthError(error) || '登録に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyCode = async () => {
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
    const normalizedToken = toHalfWidthDigits(otpToken).replace(/\D/g, '').slice(0, 6);
    setOtpToken(normalizedToken);
    if (normalizedToken.length !== 6) {
      setMessage('認証メールに記載された6桁コードを入力してください。');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await setDriverProfileLocal(validation.value);
      await hydrateRemoteSyncState();
      await verifyDriverEmailOtp(validation.value.email, normalizedToken);
      await runRemoteSync('profile-registration-otp');
      setMessage('メール認証が完了しました。管理者の承認状態を確認します。');
      await onRefresh();
    } catch (error: any) {
      setMessage(formatDriverAuthError(error));
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = getApprovalLabel(identity);
  const waitingForApproval =
    identity.configured &&
    identity.authInitialized &&
    identity.profileComplete &&
    identity.approvalStatus !== 'approved';
  const showOtpPanel = identity.configured && !identity.authInitialized && email.trim().length > 0;

  return (
    <div className="screen-shell">
      <div className="screen-card screen-card--narrow">
        <div className="screen-card__header">
          <div>
            <div className="screen-card__eyebrow">初回登録</div>
            <h1 className="screen-card__title">端末プロフィール登録</h1>
          </div>
          <div className="screen-card__actions">
            <Link to="/driver-login" className="pill-link">
              登録済みログイン
            </Link>
          </div>
        </div>

        <div className="settings-note">
          名前、メールアドレス、電話番号、車両番号を登録し、メール本文の6桁コードで認証してください。メール認証と管理者承認が完了するまで運行開始画面は利用できません。
          {!identity.configured && ' 現在はクラウド設定を読み込めていないため、管理者承認を確認できません。'}
        </div>

        {waitingForApproval && (
          <div className={`approval-wait-card approval-wait-card--${identity.approvalStatus}`}>
            <strong>{statusLabel}</strong>
            <span>
              {identity.approvalStatus === 'rejected'
                ? 'この登録は管理者により拒否されています。内容を確認する場合は管理者へ連絡してください。'
                : 'メール認証は完了しています。管理者が許可するとこの端末で機能を使えるようになります。'}
            </span>
          </div>
        )}

        {!waitingForApproval && <form className="driver-registration" onSubmit={handleSubmit}>
          <label className="settings-field">
            <span>名前</span>
            <input
              value={displayName}
              onChange={event => setDisplayName(event.target.value)}
              placeholder="例: 山田 太郎"
              aria-invalid={fieldErrors.displayName ? true : undefined}
              required
            />
            {fieldErrors.displayName && <small className="settings-field-error">{fieldErrors.displayName}</small>}
          </label>
          <label className="settings-field">
            <span>メールアドレス</span>
            <input
              value={email}
              onChange={event => setEmail(event.target.value)}
              placeholder="driver@example.com"
              type="email"
              aria-invalid={fieldErrors.email ? true : undefined}
              required
            />
            {fieldErrors.email && <small className="settings-field-error">{fieldErrors.email}</small>}
          </label>
          <label className="settings-field">
            <span>電話番号</span>
            <input
              value={phone}
              onChange={event => setPhone(normalizePhoneInput(event.target.value))}
              placeholder="例: 090-1234-5678"
              inputMode="tel"
              aria-invalid={fieldErrors.phone ? true : undefined}
              required
            />
            {fieldErrors.phone && <small className="settings-field-error">{fieldErrors.phone}</small>}
          </label>
          <label className="settings-field">
            <span>車両番号（車番）</span>
            <input
              value={vehicleLabel}
              onChange={event => setVehicleLabel(normalizeVehicleLabelInput(event.target.value))}
              placeholder="例: 札幌101か8916"
              aria-invalid={fieldErrors.vehicleLabel ? true : undefined}
              required
            />
            {fieldErrors.vehicleLabel && <small className="settings-field-error">{fieldErrors.vehicleLabel}</small>}
          </label>

          <div className="settings-info-row">
            <span>認証状態</span>
            <strong>{statusLabel}</strong>
          </div>

          <button className="trip-btn trip-btn--primary" disabled={busy || loading} type="submit">
            {busy ? '処理中…' : identity.configured && !identity.authInitialized ? '登録して認証メールを送信' : '登録する'}
          </button>
          <button
            className="trip-btn"
            disabled={busy || loading}
            type="button"
            onClick={async () => {
              setMessage(null);
              await onRefresh();
            }}
          >
            {loading ? '確認中…' : '認証状態を更新'}
          </button>
        </form>}

        {!waitingForApproval && showOtpPanel && (
          <div className="driver-registration">
            <div className="settings-note">
              iPhoneのホーム画面PWAでは、メールのリンクを押すとSafari側だけが認証される場合があります。
              認証メールに表示された6桁コードをここに入力すると、このPWA内でログインできます。
            </div>
            <label className="settings-field">
              <span>6桁コード</span>
              <input
                value={otpToken}
                onChange={event => setOtpToken(toHalfWidthDigits(event.target.value).replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                inputMode="numeric"
                maxLength={6}
              />
            </label>
            <button
              className="trip-btn"
              disabled={busy || loading || otpToken.length !== 6}
              type="button"
              onClick={handleVerifyCode}
            >
              6桁コードでメール認証
            </button>
          </div>
        )}

        {waitingForApproval && (
          <button
            className="trip-btn trip-btn--primary"
            disabled={busy || loading}
            type="button"
            onClick={async () => {
              setMessage(null);
              await onRefresh();
            }}
          >
            {loading ? '確認中…' : '承認状態を更新'}
          </button>
        )}

        {message && <div className="settings-toast">{message}</div>}
      </div>
    </div>
  );
}

function DeviceSetupGate(props: {
  readiness: NativeSetupReadiness | null;
  loading: boolean;
  onRefresh: () => Promise<void>;
}) {
  const { readiness, loading, onRefresh } = props;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const steps = readiness?.steps ?? [];

  const runAction = async (action: () => Promise<unknown>, nextMessage: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage(nextMessage);
      await onRefresh();
    } catch (error: any) {
      setMessage(error?.message ?? '端末設定を確認できませんでした');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen-shell">
      <div className="screen-card screen-card--narrow">
        <div className="screen-card__header">
          <div>
            <div className="screen-card__eyebrow">初回設定</div>
            <h1 className="screen-card__title">端末設定を完了してください</h1>
          </div>
        </div>

        <div className="settings-note">
          管理者承認は完了しています。バックグラウンド記録を安定させるため、必要な端末設定が完了するまで運行機能は使えません。
        </div>

        <div className="setup-check-list">
          {loading && steps.length === 0 ? (
            <div className="setup-check-row setup-check-row--warn">
              <strong>確認中</strong>
              <span>端末設定の状態を確認しています。</span>
            </div>
          ) : (
            steps.map(step => (
              <div className={`setup-check-row setup-check-row--${step.level}`} key={step.id}>
                <strong>{step.label}</strong>
                <span>{step.detail}</span>
              </div>
            ))
          )}
        </div>

        <div className="setup-gate-actions">
          <button
            className="trip-btn trip-btn--primary"
            disabled={busy || loading}
            type="button"
            onClick={() => runAction(runNativeQuickSetup, '一括セットアップを実行しました。設定画面で許可後、再確認してください。')}
          >
            {busy ? '処理中…' : '一括セットアップ'}
          </button>
          <button
            className="trip-btn"
            disabled={busy || loading}
            type="button"
            onClick={() => runAction(onRefresh, '設定状態を再確認しました。')}
          >
            {loading ? '確認中…' : '設定状態を再確認'}
          </button>
          <button
            className="trip-btn"
            disabled={busy}
            type="button"
            onClick={() => runAction(openAppPermissionSettings, 'OSのアプリ権限設定を開きました。')}
          >
            OS権限設定
          </button>
          <button
            className="trip-btn"
            disabled={busy}
            type="button"
            onClick={() => runAction(openSystemLocationSettings, '位置情報設定を開きました。')}
          >
            位置情報設定
          </button>
          <button
            className="trip-btn"
            disabled={busy}
            type="button"
            onClick={() => runAction(requestBatteryOptimizationExemption, '電池最適化設定を開きました。')}
          >
            電池最適化
          </button>
          <button
            className="trip-btn"
            disabled={busy}
            type="button"
            onClick={() => runAction(openExactAlarmSettings, 'Exact Alarm設定を開きました。')}
          >
            Exact Alarm
          </button>
        </div>

        {message && <div className="settings-toast">{message}</div>}
      </div>
    </div>
  );
}

export default function RequireDriverProfile({ children }: Props) {
  const [identity, setIdentity] = useState<DriverIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupReadiness, setSetupReadiness] = useState<NativeSetupReadiness | null>(null);
  const [setupLoading, setSetupLoading] = useState(false);

  const refreshNativeSetup = async () => {
    setSetupLoading(true);
    try {
      setSetupReadiness(await checkNativeSetupReadiness());
    } finally {
      setSetupLoading(false);
    }
  };

  const refreshIdentity = async () => {
    setLoading(true);
    try {
      const current = await getDriverIdentity();
      const next = current.configured ? await initializeDriverIdentity() : current;
      setIdentity(next);
      if (hasApprovedProfile(next)) {
        await refreshNativeSetup();
      }
    } catch {
      setIdentity(await getDriverIdentity());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const current = await getDriverIdentity();
        const next = current.configured ? await initializeDriverIdentity() : current;
        if (active) {
          setIdentity(next);
        }
      } catch {
        if (active) {
          setIdentity(await getDriverIdentity());
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!hasApprovedProfile(identity)) {
      setSetupReadiness(null);
      return;
    }
    let active = true;
    setSetupLoading(true);
    void checkNativeSetupReadiness()
      .then(readiness => {
        if (active) setSetupReadiness(readiness);
      })
      .finally(() => {
        if (active) setSetupLoading(false);
      });
    return () => {
      active = false;
    };
  }, [identity?.configured, identity?.authInitialized, identity?.profileComplete, identity?.approvalStatus]);

  if (!identity) {
    return <div style={{ padding: 24, color: '#fff' }}>登録状態を確認中…</div>;
  }

  if (!hasApprovedProfile(identity)) {
    return (
      <DriverRegistrationGate
        identity={identity as DriverIdentity}
        loading={loading}
        onRefresh={refreshIdentity}
      />
    );
  }

  if (!setupReadiness?.ready) {
    return (
      <DeviceSetupGate
        readiness={setupReadiness}
        loading={setupLoading}
        onRefresh={refreshNativeSetup}
      />
    );
  }

  return children;
}
