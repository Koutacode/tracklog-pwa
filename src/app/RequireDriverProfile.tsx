import type { FormEvent, ReactElement } from 'react';
import { useEffect, useState } from 'react';
import type { DriverIdentity } from '../domain/remoteTypes';
import {
  getDriverIdentity,
  initializeDriverIdentity,
  sendDriverMagicLink,
  setDriverProfileLocal,
} from '../services/remoteAuth';
import { hydrateRemoteSyncState, runRemoteSync } from '../services/remoteSync';

type Props = {
  children: ReactElement;
};

function shouldAllowApp(identity: DriverIdentity | null) {
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
  return '管理者承認待ち';
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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setDisplayName(identity.displayName);
    setVehicleLabel(identity.vehicleLabel);
    setPhone(identity.phone);
    setEmail(identity.email ?? '');
  }, [identity]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await setDriverProfileLocal({ displayName, vehicleLabel, phone, email });
      await hydrateRemoteSyncState();
      if (identity.configured && !identity.authInitialized) {
        await sendDriverMagicLink(email);
        setMessage('認証メールを送信しました。メール内のリンクで認証後、「認証状態を更新」を押してください。');
      } else {
        await runRemoteSync('profile-registration');
        setMessage('端末プロフィールを保存しました。管理者の承認後に利用できます。');
      }
      await onRefresh();
    } catch (error: any) {
      setMessage(error?.message ?? '登録に失敗しました');
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

  return (
    <div className="screen-shell">
      <div className="screen-card screen-card--narrow">
        <div className="screen-card__header">
          <div>
            <div className="screen-card__eyebrow">初回登録</div>
            <h1 className="screen-card__title">端末プロフィール登録</h1>
          </div>
        </div>

        <div className="settings-note">
          名前、メールアドレス、電話番号、車両番号を登録し、メール認証と管理者承認が完了するまで運行開始画面は利用できません。
          {!identity.configured && ' 現在はクラウド設定を読み込めていないため、管理者承認を確認できません。'}
        </div>

        {waitingForApproval && (
          <div className={`approval-wait-card approval-wait-card--${identity.approvalStatus}`}>
            <strong>{statusLabel}</strong>
            <span>
              {identity.approvalStatus === 'rejected'
                ? 'この登録は管理者により拒否されています。内容を確認する場合は管理者へ連絡してください。'
                : '登録申請は管理画面に届いています。管理者が許可するとこの端末で機能を使えるようになります。'}
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
              required
            />
          </label>
          <label className="settings-field">
            <span>メールアドレス</span>
            <input
              value={email}
              onChange={event => setEmail(event.target.value)}
              placeholder="driver@example.com"
              type="email"
              required
            />
          </label>
          <label className="settings-field">
            <span>電話番号</span>
            <input
              value={phone}
              onChange={event => setPhone(event.target.value)}
              placeholder="例: 090-1234-5678"
              inputMode="tel"
              required
            />
          </label>
          <label className="settings-field">
            <span>車両番号（車番）</span>
            <input
              value={vehicleLabel}
              onChange={event => setVehicleLabel(event.target.value)}
              placeholder="例: 札幌 100 あ 1234"
              required
            />
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

export default function RequireDriverProfile({ children }: Props) {
  const [identity, setIdentity] = useState<DriverIdentity | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshIdentity = async () => {
    setLoading(true);
    try {
      const current = await getDriverIdentity();
      const next = current.configured ? await initializeDriverIdentity() : current;
      setIdentity(next);
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

  if (!identity) {
    return <div style={{ padding: 24, color: '#fff' }}>登録状態を確認中…</div>;
  }

  if (!shouldAllowApp(identity)) {
    return (
      <DriverRegistrationGate
        identity={identity as DriverIdentity}
        loading={loading}
        onRefresh={refreshIdentity}
      />
    );
  }

  return children;
}
