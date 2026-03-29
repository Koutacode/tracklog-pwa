import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import type { RemoteDeviceProfile } from '../../domain/remoteTypes';
import { listAdminDevices } from '../../services/remoteAdmin';
import { getAdminSession, signOutAdmin } from '../../services/remoteAuth';

function fmtDateTime(ts?: string | null) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('ja-JP');
}

export default function AdminDashboard() {
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [devices, setDevices] = useState<RemoteDeviceProfile[]>([]);
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
        const nextDevices = await listAdminDevices();
        if (!active) return;
        setDevices(nextDevices);
      } catch (err: any) {
        if (active) setError(err?.message ?? '管理画面の読み込みに失敗しました');
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (!ready) {
    return <div className="screen-shell"><div className="screen-card">読み込み中…</div></div>;
  }
  if (!authenticated) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="screen-shell">
      <div className="screen-card">
        <div className="screen-card__header">
          <div>
            <div className="screen-card__eyebrow">TrackLog 管理画面</div>
            <h1 className="screen-card__title">端末一覧</h1>
          </div>
          <div className="screen-card__actions">
            <Link to="/" className="pill-link">
              ホーム
            </Link>
            <button
              className="pill-link"
              onClick={async () => {
                await signOutAdmin();
                window.location.href = '/login';
              }}
            >
              ログアウト
            </button>
          </div>
        </div>
        {error && <div className="settings-toast">{error}</div>}
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>端末名</th>
                <th>端末ID</th>
                <th>現在状態</th>
                <th>最新位置</th>
                <th>最終同期</th>
                <th>運行ID</th>
              </tr>
            </thead>
            <tbody>
              {devices.map(device => (
                <tr key={device.device_id}>
                  <td>
                    <Link to={`/admin/devices/${encodeURIComponent(device.device_id)}`}>{device.display_name}</Link>
                  </td>
                  <td>{device.device_id.slice(0, 8)}</td>
                  <td>{device.latest_status ?? '-'}</td>
                  <td>
                    {device.latest_lat != null && device.latest_lng != null
                      ? `${device.latest_lat.toFixed(4)}, ${device.latest_lng.toFixed(4)}`
                      : '-'}
                  </td>
                  <td>{fmtDateTime(device.last_seen_at)}</td>
                  <td>{device.latest_trip_id ? device.latest_trip_id.slice(0, 8) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

