import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import AdminMap from '../components/AdminMap';
import { deleteAdminDevice, getAdminDeviceBundle, setAdminDeviceApproval } from '../../services/remoteAdmin';
import { getAdminSession } from '../../services/remoteAuth';

function getApprovalStatus(profile: NonNullable<Awaited<ReturnType<typeof getAdminDeviceBundle>>['profile']>) {
  if (profile.approval_status === 'approved' || profile.approval_status === 'rejected') return profile.approval_status;
  return 'pending';
}

function getApprovalLabel(profile: NonNullable<Awaited<ReturnType<typeof getAdminDeviceBundle>>['profile']>) {
  const status = getApprovalStatus(profile);
  if (status === 'approved') return '承認済み';
  if (status === 'rejected') return '拒否済み';
  return '承認待ち';
}

export default function AdminDeviceDetail() {
  const { deviceId = '' } = useParams();
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [bundle, setBundle] = useState<Awaited<ReturnType<typeof getAdminDeviceBundle>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [approving, setApproving] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const session = await getAdminSession();
        if (!active) return;
        setAuthenticated(session.authenticated);
        if (!session.authenticated) {
          setReady(true);
          return;
        }
        const nextBundle = await getAdminDeviceBundle(deviceId);
        if (active) setBundle(nextBundle);
      } catch (err: any) {
        if (active) setError(err?.message ?? '端末詳細の取得に失敗しました');
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [deviceId]);

  const marker = useMemo(() => {
    if (bundle?.profile?.latest_lat == null || bundle?.profile?.latest_lng == null) return null;
    return {
      lat: bundle.profile.latest_lat,
      lng: bundle.profile.latest_lng,
      label: bundle.profile.display_name || bundle.profile.driver_email || bundle.profile.device_id,
    };
  }, [bundle]);

  async function handleDeleteDevice() {
    const profile = bundle?.profile;
    if (!profile) return;
    const displayName = profile.display_name || profile.driver_email || profile.device_id;
    const confirmed = window.confirm(
      `${displayName} を管理画面から消去します。\n\n` +
      'クラウド上の端末プロフィールと同期済みの運行データが削除されます。端末内のローカルデータは削除されません。\n\n' +
      'この操作を実行しますか？',
    );
    if (!confirmed) return;

    setError(null);
    setDeleting(true);
    try {
      await deleteAdminDevice(profile.device_id);
      navigate('/admin', { replace: true });
    } catch (err: any) {
      setError(err?.message ?? '端末IDの消去に失敗しました');
      setDeleting(false);
    }
  }

  async function handleApproval(decision: 'approved' | 'rejected') {
    const profile = bundle?.profile;
    if (!profile) return;
    const displayName = profile.display_name || profile.driver_email || profile.device_id;
    const confirmed = window.confirm(
      decision === 'approved'
        ? `${displayName} の利用を許可しますか？`
        : `${displayName} の利用申請を拒否しますか？`,
    );
    if (!confirmed) return;
    setError(null);
    setNotice(null);
    setApproving(true);
    try {
      const updated = await setAdminDeviceApproval(profile.device_id, decision);
      setBundle(current => current ? { ...current, profile: updated } : current);
      setNotice(decision === 'approved' ? `${displayName} を許可しました` : `${displayName} を拒否しました`);
    } catch (err: any) {
      setError(err?.message ?? '承認状態の更新に失敗しました');
    } finally {
      setApproving(false);
    }
  }

  if (!ready) return <div className="screen-shell"><div className="screen-card">読み込み中…</div></div>;
  if (!authenticated) return <Navigate to="/login" replace />;

  return (
    <div className="screen-shell">
      <div className="screen-card">
        <div className="screen-card__header">
          <div>
            <div className="screen-card__eyebrow">端末詳細</div>
            <h1 className="screen-card__title">{bundle?.profile?.display_name || bundle?.profile?.driver_email || deviceId}</h1>
          </div>
          <div className="screen-card__actions">
            <Link to="/admin" className="pill-link">一覧へ戻る</Link>
            {bundle?.profile && (
              <>
                {getApprovalStatus(bundle.profile) !== 'approved' && (
                  <button
                    type="button"
                    className="pill-link pill-link--approve"
                    disabled={approving}
                    onClick={() => void handleApproval('approved')}
                  >
                    許可
                  </button>
                )}
                {getApprovalStatus(bundle.profile) !== 'rejected' && (
                  <button
                    type="button"
                    className="pill-link pill-link--danger"
                    disabled={approving}
                    onClick={() => void handleApproval('rejected')}
                  >
                    拒否
                  </button>
                )}
              <button
                type="button"
                className="pill-link pill-link--danger"
                disabled={deleting}
                onClick={() => void handleDeleteDevice()}
              >
                {deleting ? '消去中' : '端末IDを消去'}
              </button>
              </>
            )}
          </div>
        </div>
        {error && <div className="settings-toast">{error}</div>}
        {notice && <div className="settings-toast settings-toast--success">{notice}</div>}
        {bundle?.profile && (
          <section className="settings-grid">
            <article className="card settings-panel">
              <div className="settings-panel__title">最新位置</div>
              <AdminMap center={marker} markers={marker ? [marker] : []} />
            </article>
            <article className="card settings-panel">
              <div className="settings-panel__title">概要</div>
              <div className="settings-info-row"><span>表示名</span><strong>{bundle.profile.display_name || '-'}</strong></div>
              <div className="settings-info-row"><span>メール</span><strong>{bundle.profile.driver_email || '-'}</strong></div>
              <div className="settings-info-row"><span>電話番号</span><strong>{bundle.profile.driver_phone || '-'}</strong></div>
              <div className="settings-info-row"><span>端末ID</span><strong>{bundle.profile.device_id}</strong></div>
              <div className="settings-info-row"><span>利用承認</span><strong>{getApprovalLabel(bundle.profile)}</strong></div>
              <div className="settings-info-row"><span>申請日時</span><strong>{bundle.profile.approval_requested_at ? new Date(bundle.profile.approval_requested_at).toLocaleString('ja-JP') : '-'}</strong></div>
              <div className="settings-info-row"><span>承認/拒否日時</span><strong>{bundle.profile.approval_decided_at ? new Date(bundle.profile.approval_decided_at).toLocaleString('ja-JP') : '-'}</strong></div>
              <div className="settings-info-row"><span>状態</span><strong>{bundle.profile.latest_status ?? '-'}</strong></div>
              <div className="settings-info-row"><span>車番</span><strong>{bundle.profile.vehicle_label ?? '-'}</strong></div>
              <div className="settings-info-row"><span>最終同期</span><strong>{bundle.profile.last_seen_at ? new Date(bundle.profile.last_seen_at).toLocaleString('ja-JP') : '-'}</strong></div>
            </article>
            <article className="card settings-panel settings-panel--full">
              <div className="settings-panel__title">運行一覧</div>
              <div className="admin-list">
                {bundle.trips.map(item => (
                  <Link key={item.trip_id} to={`/admin/trips/${encodeURIComponent(item.trip_id)}`} className="admin-list__item">
                    <strong>{new Date(item.start_ts).toLocaleString('ja-JP')}</strong>
                    <span>{item.status === 'active' ? '運行中' : '終了'} / {item.total_km ?? '-'} km</span>
                  </Link>
                ))}
              </div>
            </article>
          </section>
        )}
      </div>
    </div>
  );
}
