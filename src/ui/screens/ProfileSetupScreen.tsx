import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { getDriverIdentity, setDriverProfileLocal } from '../../services/remoteAuth';
import { runRemoteSync } from '../../services/remoteSync';

export default function ProfileSetupScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [displayName, setDisplayName] = useState('');
  const [vehicleLabel, setVehicleLabel] = useState('');
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
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
    })();
    return () => {
      active = false;
    };
  }, [navigate, searchParams]);

  return (
    <div className="screen-shell">
      <div className="screen-card">
        <div className="screen-card__header">
          <div>
            <div className="screen-card__eyebrow">初回セットアップ</div>
            <h1 className="screen-card__title">端末プロフィールを設定</h1>
          </div>
        </div>

        <section className="settings-grid">
          <article className="card settings-panel settings-panel--full">
            <div className="settings-panel__title">この端末の識別情報</div>
            <div className="settings-note">
              管理画面で端末を見分けやすくするため、最初に表示名と車番を設定します。同じ端末では、この名前を引き継いで同期します。
            </div>
            <label className="settings-field">
              <span>表示名</span>
              <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="例: 札幌便 1号車" />
            </label>
            <label className="settings-field">
              <span>車番・識別名</span>
              <input value={vehicleLabel} onChange={e => setVehicleLabel(e.target.value)} placeholder="例: 札幌 100 あ 1234" />
            </label>
            <div className="settings-info-row">
              <span>端末ID</span>
              <strong>{deviceId ?? '初期化中'}</strong>
            </div>
            <button
              className="trip-btn trip-btn--primary"
              disabled={saving || !displayName.trim() || !vehicleLabel.trim()}
              onClick={async () => {
                setSaving(true);
                setMessage(null);
                try {
                  await setDriverProfileLocal({ displayName, vehicleLabel });
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
