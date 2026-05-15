import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import type { RemoteDeviceProfile } from '../../domain/remoteTypes';
import { deleteAdminDevice, listAdminDevices } from '../../services/remoteAdmin';
import { getAdminSession, signOutAdmin } from '../../services/remoteAuth';
import { shareText } from '../../services/nativeShare';
import { PWA_URL } from '../../app/releaseInfo';
import AdminMap from '../components/AdminMap';

function fmtDateTime(ts?: string | null) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('ja-JP');
}

type DeviceSeenStatus = {
  kind: 'active' | 'recent' | 'stale';
  label: string;
};

function getSeenStatus(lastSeenAt?: string | null): DeviceSeenStatus {
  if (!lastSeenAt) return { kind: 'stale', label: '未確認' };
  const seenAt = new Date(lastSeenAt).getTime();
  if (!Number.isFinite(seenAt)) return { kind: 'stale', label: '未確認' };
  const elapsedMinutes = (Date.now() - seenAt) / 60000;
  if (elapsedMinutes <= 15) return { kind: 'active', label: '稼働中' };
  if (elapsedMinutes <= 120) return { kind: 'recent', label: '最近同期' };
  return { kind: 'stale', label: '要確認' };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#039;';
      default:
        return char;
    }
  });
}

export default function AdminDashboard() {
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [devices, setDevices] = useState<RemoteDeviceProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deletingDeviceId, setDeletingDeviceId] = useState<string | null>(null);

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

  const deviceStatus = useMemo(
    () => new Map(devices.map(device => [device.device_id, getSeenStatus(device.last_seen_at)])),
    [devices],
  );

  const statusCounts = useMemo(
    () =>
      devices.reduce(
        (counts, device) => {
          const status = deviceStatus.get(device.device_id) ?? getSeenStatus(device.last_seen_at);
          counts[status.kind] += 1;
          if (device.latest_lat != null && device.latest_lng != null) counts.withLocation += 1;
          return counts;
        },
        { active: 0, recent: 0, stale: 0, withLocation: 0 },
      ),
    [deviceStatus, devices],
  );

  const mapMarkers = useMemo(
    () =>
      devices
        .filter(device => device.latest_lat != null && device.latest_lng != null)
        .map(device => {
          const seenStatus = deviceStatus.get(device.device_id) ?? getSeenStatus(device.last_seen_at);
          const displayName = device.display_name || device.device_id;
          const latestStatus = device.latest_status ?? '-';
          const vehicleLabel = device.vehicle_label ?? '-';
          const lastSeen = fmtDateTime(device.last_seen_at);
          const label = `${displayName} / ${seenStatus.label} / ${vehicleLabel}`;
          return {
            lat: device.latest_lat as number,
            lng: device.latest_lng as number,
            label,
            statusKind: seenStatus.kind,
            popup: [
              `<strong>${escapeHtml(displayName)}</strong>`,
              `状態: ${escapeHtml(latestStatus)} (${escapeHtml(seenStatus.label)})`,
              `車番: ${escapeHtml(vehicleLabel)}`,
              `最終同期: ${escapeHtml(lastSeen)}`,
            ].join('<br />'),
          };
        }),
    [deviceStatus, devices],
  );

  async function handleDeleteDevice(device: RemoteDeviceProfile) {
    const displayName = device.display_name || device.device_id;
    const confirmed = window.confirm(
      `${displayName} を管理画面から消去します。\n\n` +
      'クラウド上の端末プロフィールと同期済みの運行データが削除されます。端末内のローカルデータは削除されません。\n\n' +
      'この操作を実行しますか？',
    );
    if (!confirmed) return;

    setError(null);
    setNotice(null);
    setDeletingDeviceId(device.device_id);
    try {
      const result = await deleteAdminDevice(device.device_id);
      setDevices(current => current.filter(item => item.device_id !== device.device_id));
      setNotice(
        result.mode === 'deleted'
          ? `${displayName} をクラウドから消去しました`
          : `${displayName} を管理画面から非表示にしました`,
      );
    } catch (err: any) {
      setError(err?.message ?? '端末IDの消去に失敗しました');
    } finally {
      setDeletingDeviceId(null);
    }
  }

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
            <button
              className="pill-link"
              onClick={async () => {
                const url = PWA_URL;
                const text = `【TrackLog 配布用アプリ】\n以下のURLからアプリを開き、Androidの場合はインストールしてください。\n${url}\n\n※管理者画面は ${url}/admin です。`;
                try {
                  const shared = await shareText({ title: 'TrackLog アプリを共有', text });
                  if (!shared && navigator.share) {
                    await navigator.share({ title: 'TrackLog アプリ', text });
                  } else if (!shared) {
                    await navigator.clipboard.writeText(text);
                    setNotice('クリップボードにURLをコピーしました');
                  }
                } catch (e) {
                  console.error(e);
                  await navigator.clipboard.writeText(text);
                  setNotice('クリップボードにURLをコピーしました');
                }
              }}
            >
              アプリURLを共有
            </button>
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
        {notice && <div className="settings-toast settings-toast--success">{notice}</div>}
        <section className="admin-dashboard-map">
          <div className="admin-dashboard-map__header">
            <div>
              <div className="settings-panel__title">端末マップ</div>
              <p>最新位置を送信済みの端末を表示しています。</p>
            </div>
            <div className="admin-status-summary" aria-label="端末同期状態">
              <div className="admin-status-summary__item admin-status-summary__item--active">
                <span>稼働中</span>
                <strong>{statusCounts.active}</strong>
              </div>
              <div className="admin-status-summary__item admin-status-summary__item--recent">
                <span>最近同期</span>
                <strong>{statusCounts.recent}</strong>
              </div>
              <div className="admin-status-summary__item admin-status-summary__item--stale">
                <span>要確認</span>
                <strong>{statusCounts.stale}</strong>
              </div>
              <div className="admin-status-summary__item">
                <span>位置あり</span>
                <strong>{statusCounts.withLocation}/{devices.length}</strong>
              </div>
            </div>
          </div>
          <AdminMap markers={mapMarkers} height={420} />
        </section>
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
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {devices.map(device => (
                <tr key={device.device_id}>
                  <td>
                    <Link to={`/admin/devices/${encodeURIComponent(device.device_id)}`}>{device.display_name}</Link>
                  </td>
                  <td>{device.device_id.slice(0, 8)}</td>
                  <td>
                    <span className={`admin-status-badge admin-status-badge--${deviceStatus.get(device.device_id)?.kind ?? 'stale'}`}>
                      {deviceStatus.get(device.device_id)?.label ?? '要確認'}
                    </span>
                    <div className="admin-table__subtext">{device.latest_status ?? '-'}</div>
                  </td>
                  <td>
                    {device.latest_lat != null && device.latest_lng != null
                      ? `${device.latest_lat.toFixed(4)}, ${device.latest_lng.toFixed(4)}`
                      : '-'}
                  </td>
                  <td>{fmtDateTime(device.last_seen_at)}</td>
                  <td>{device.latest_trip_id ? device.latest_trip_id.slice(0, 8) : '-'}</td>
                  <td className="admin-action-cell">
                    <button
                      type="button"
                      className="pill-link pill-link--danger admin-delete-button"
                      disabled={deletingDeviceId === device.device_id}
                      onClick={() => void handleDeleteDevice(device)}
                    >
                      {deletingDeviceId === device.device_id ? '消去中' : '消去'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
