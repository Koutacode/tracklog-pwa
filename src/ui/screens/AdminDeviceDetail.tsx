import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import AdminMap from '../components/AdminMap';
import { getAdminDeviceBundle } from '../../services/remoteAdmin';
import { getAdminSession } from '../../services/remoteAuth';

export default function AdminDeviceDetail() {
  const { deviceId = '' } = useParams();
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [bundle, setBundle] = useState<Awaited<ReturnType<typeof getAdminDeviceBundle>> | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      label: bundle.profile.display_name,
    };
  }, [bundle]);

  if (!ready) return <div className="screen-shell"><div className="screen-card">読み込み中…</div></div>;
  if (!authenticated) return <Navigate to="/login" replace />;

  return (
    <div className="screen-shell">
      <div className="screen-card">
        <div className="screen-card__header">
          <div>
            <div className="screen-card__eyebrow">端末詳細</div>
            <h1 className="screen-card__title">{bundle?.profile?.display_name ?? deviceId}</h1>
          </div>
          <div className="screen-card__actions">
            <Link to="/admin" className="pill-link">一覧へ戻る</Link>
          </div>
        </div>
        {error && <div className="settings-toast">{error}</div>}
        {bundle?.profile && (
          <section className="settings-grid">
            <article className="card settings-panel">
              <div className="settings-panel__title">最新位置</div>
              <AdminMap center={marker} markers={marker ? [marker] : []} />
            </article>
            <article className="card settings-panel">
              <div className="settings-panel__title">概要</div>
              <div className="settings-info-row"><span>端末ID</span><strong>{bundle.profile.device_id}</strong></div>
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
