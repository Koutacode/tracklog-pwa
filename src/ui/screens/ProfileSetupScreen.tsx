import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { getDriverIdentity, sendDriverMagicLink, setDriverProfileLocal } from '../../services/remoteAuth';
import { runRemoteSync } from '../../services/remoteSync';

export default function ProfileSetupScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [displayName, setDisplayName] = useState('');
  const [vehicleLabel, setVehicleLabel] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sendingMagic, setSendingMagic] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const identity = await getDriverIdentity();
      if (!active) return;
      setDeviceId(identity.deviceId);
      if (identity.profileComplete) {
        navigate(searchParams.get('next') || '/', { replace: true });
        return;
      }
      if (identity.displayName && !identity.displayName.startsWith('ANDROID-') && !identity.displayName.startsWith('WEB-')) {
        setDisplayName(identity.displayName);
      }
      setVehicleLabel(identity.vehicleLabel);
      if (identity.phone) {
        setPhone(identity.phone);
      }
      if (identity.email) {
        setEmail(identity.email);
      }
    })();
    return () => {
      active = false;
    };
  }, [navigate, searchParams]);

  const disabledSave = !displayName.trim() || !vehicleLabel.trim() || !phone.trim() || !email.trim();
  const canSave = !disabledSave && !saving;
  const canSend = !!email.trim() && !sendingMagic;

  return (
    <div className="screen-shell">
      <div className="screen-card">
        <div className="screen-card__header">
          <div>
            <div className="screen-card__eyebrow">初回セットアップ</div>
            <h1 className="screen-card__title">ドライバー情報を登録</h1>
          </div>
        </div>

        <section className="settings-grid">
          <article className="card settings-panel settings-panel--full">
            <div className="settings-panel__title">運行端末の識別情報を設定</div>
            <div className="settings-note">
              名前・車番・電話番号・メールアドレスを登録すると、端末名で履歴を特定できるようになり
              別端末でもアカウント単位で同期しやすくなります。
            </div>
            <label className="settings-field">
              <span>表示名（ドライバー名）</span>
              <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="例: 田中 太郎" />
            </label>
            <label className="settings-field">
              <span>車番・識別名</span>
              <input value={vehicleLabel} onChange={e => setVehicleLabel(e.target.value)} placeholder="例: 札幌 100 あ 1234" />
            </label>
            <label className="settings-field">
              <span>電話番号</span>
              <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="例: 090-1234-5678" />
            </label>
            <label className="settings-field">
              <span>メールアドレス</span>
              <input value={email} onChange={e => setEmail(e.target.value)} placeholder="例: sample@example.com" type="email" />
            </label>
            <div className="settings-info-row">
              <span>端末ID</span>
              <strong>{deviceId ?? '初期化中'}</strong>
            </div>
            <div className="settings-info-row">
              <span>補足</span>
              <strong>先に保存後、必要に応じて「認証メールを送信」を押してください</strong>
            </div>
            <button
              className="trip-btn"
              disabled={!canSend}
              onClick={async () => {
                setMessage(null);
                setSendingMagic(true);
                try {
                  await sendDriverMagicLink(email);
                  setMessage('認証リンクを送信しました。メールから開いてサインインしてください。');
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
              disabled={!canSave}
              onClick={async () => {
                setSaving(true);
                setMessage(null);
                try {
                  await setDriverProfileLocal({ displayName, vehicleLabel, phone, email });
                  await runRemoteSync('profile-setup');
                  navigate(searchParams.get('next') || '/', { replace: true });
                } catch (error: any) {
                  setMessage(error?.message ?? 'プロフィールの保存に失敗しました');
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saving ? '保存中…' : '保存して開始'}
            </button>
          </article>
        </section>

        {message && <div className="settings-toast">{message}</div>}
      </div>
    </div>
  );
}
