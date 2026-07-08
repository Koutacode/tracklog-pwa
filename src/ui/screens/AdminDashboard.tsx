import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import type { RemoteDeviceProfile } from '../../domain/remoteTypes';
import { deleteAdminDevice, listAdminDevices, setAdminDeviceApproval } from '../../services/remoteAdmin';
import { getAdminSession, signOutAdmin } from '../../services/remoteAuth';
import { shareText } from '../../services/nativeShare';
import { DEFAULT_APK_DOWNLOAD_URL, PWA_URL } from '../../app/releaseInfo';
import AdminMap from '../components/AdminMap';
import {
  DEFAULT_LOCATION_NOTIFICATION_TEXT,
  loadTracklogRuntimeConfig,
  normalizeLocationNotificationText,
  saveTracklogRuntimeConfig,
} from '../../services/runtimeConfig';

function fmtDateTime(ts?: string | null) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('ja-JP');
}

function getLocationTimestamp(profile: RemoteDeviceProfile) {
  if (profile.latest_lat == null || profile.latest_lng == null) return null;
  return profile.latest_location_at ?? profile.last_seen_at ?? null;
}

function formatAccuracy(value?: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return `精度 約${Math.round(value)}m`;
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

function getDisplayName(profile: RemoteDeviceProfile) {
  const fallbackFromEmail = profile.driver_email ? profile.driver_email.split('@')[0] : null;
  return profile.display_name || fallbackFromEmail || profile.device_id;
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

function formatProfileValue(value: string | null | undefined) {
  return value && value.trim() ? value.trim() : '-';
}

function getApprovalStatus(profile: RemoteDeviceProfile) {
  if (profile.approval_status === 'approved' || profile.approval_status === 'rejected') {
    return profile.approval_status;
  }
  return 'pending';
}

function getApprovalLabel(profile: RemoteDeviceProfile) {
  const status = getApprovalStatus(profile);
  if (status === 'approved') return '承認済み';
  if (status === 'rejected') return '拒否済み';
  return '承認待ち';
}

export default function AdminDashboard() {
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [devices, setDevices] = useState<RemoteDeviceProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deletingDeviceId, setDeletingDeviceId] = useState<string | null>(null);
  const [approvingDeviceId, setApprovingDeviceId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);
  const [notificationText, setNotificationText] = useState(DEFAULT_LOCATION_NOTIFICATION_TEXT);
  const [notificationDraft, setNotificationDraft] = useState(DEFAULT_LOCATION_NOTIFICATION_TEXT);
  const [savingNotificationText, setSavingNotificationText] = useState(false);

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
        const [nextDevices, runtimeConfig] = await Promise.all([
          listAdminDevices(),
          loadTracklogRuntimeConfig({ force: true, admin: true }),
        ]);
        if (!active) return;
        setDevices(nextDevices);
        setNotificationText(runtimeConfig.locationNotificationText);
        setNotificationDraft(runtimeConfig.locationNotificationText);
        setLastLoadedAt(new Date().toISOString());
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

  useEffect(() => {
    if (!authenticated) return;
    let active = true;

    const refresh = async () => {
      if (!active || document.visibilityState !== 'visible') return;
      try {
        const nextDevices = await listAdminDevices();
        if (!active) return;
        setDevices(nextDevices);
        setLastLoadedAt(new Date().toISOString());
      } catch (err: any) {
        if (active) setError(err?.message ?? '端末一覧の再取得に失敗しました');
      }
    };

    const timer = window.setInterval(() => {
      void refresh();
    }, 15000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [authenticated]);

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

  const pendingDevices = useMemo(
    () => devices.filter(device => getApprovalStatus(device) === 'pending'),
    [devices],
  );

  const mapMarkers = useMemo(
    () =>
      devices
        .filter(device => device.latest_lat != null && device.latest_lng != null)
        .map(device => {
          const seenStatus = deviceStatus.get(device.device_id) ?? getSeenStatus(device.last_seen_at);
          const displayName = getDisplayName(device);
          const latestStatus = device.latest_status ?? '-';
          const vehicleLabel = device.vehicle_label ?? '-';
          const lastSeen = fmtDateTime(device.last_seen_at);
          const locationAt = fmtDateTime(getLocationTimestamp(device));
          const accuracy = formatAccuracy(device.latest_accuracy);
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
              `メール: ${escapeHtml(formatProfileValue(device.driver_email))}`,
              `電話: ${escapeHtml(formatProfileValue(device.driver_phone))}`,
              `現在地更新: ${escapeHtml(locationAt)}`,
              ...(accuracy ? [`${escapeHtml(accuracy)}`] : []),
              `最終同期: ${escapeHtml(lastSeen)}`,
            ].join('<br />'),
          };
        }),
    [deviceStatus, devices],
  );

  async function refreshAdminDevices() {
    setRefreshing(true);
    setError(null);
    try {
      const nextDevices = await listAdminDevices();
      setDevices(nextDevices);
      setLastLoadedAt(new Date().toISOString());
      setNotice('端末一覧を再取得しました');
    } catch (err: any) {
      setError(err?.message ?? '端末一覧の再取得に失敗しました');
    } finally {
      setRefreshing(false);
    }
  }

  async function handleDeleteDevice(device: RemoteDeviceProfile) {
    const displayName = getDisplayName(device);
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

  async function handleSetApproval(device: RemoteDeviceProfile, decision: 'approved' | 'rejected') {
    const displayName = getDisplayName(device);
    const confirmed = window.confirm(
      decision === 'approved'
        ? `${displayName} の利用を許可しますか？`
        : `${displayName} の利用申請を拒否しますか？\n\n拒否すると、この端末は運行記録と同期を利用できません。`,
    );
    if (!confirmed) return;

    setError(null);
    setNotice(null);
    setApprovingDeviceId(device.device_id);
    try {
      const updated = await setAdminDeviceApproval(device.device_id, decision);
      setDevices(current => current.map(item => (item.device_id === updated.device_id ? updated : item)));
      setNotice(decision === 'approved' ? `${displayName} を許可しました` : `${displayName} を拒否しました`);
    } catch (err: any) {
      setError(err?.message ?? '承認状態の更新に失敗しました');
    } finally {
      setApprovingDeviceId(null);
    }
  }

  async function handleSaveNotificationText() {
    const nextText = normalizeLocationNotificationText(notificationDraft);
    setSavingNotificationText(true);
    setError(null);
    setNotice(null);
    try {
      const config = await saveTracklogRuntimeConfig({ locationNotificationText: nextText });
      setNotificationText(config.locationNotificationText);
      setNotificationDraft(config.locationNotificationText);
      setNotice('常駐通知文を保存しました');
    } catch (err: any) {
      setError(err?.message ?? '常駐通知文の保存に失敗しました');
    } finally {
      setSavingNotificationText(false);
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
              disabled={refreshing}
              onClick={() => void refreshAdminDevices()}
              type="button"
            >
              {refreshing ? '再取得中' : '再取得'}
            </button>
            <button
              className="pill-link"
              onClick={async () => {
                const text = `【TrackLog 配布用アプリ】\nAndroidはこちらのAPKをインストールしてください。\n${DEFAULT_APK_DOWNLOAD_URL}\n\niPhoneはSafariでこちらを開いてホーム画面に追加してください。\n${PWA_URL}\n\n※管理者画面は ${PWA_URL}/admin です。`;
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
        <div className="settings-note">端末一覧は15秒ごとに自動更新します。最終再取得: {fmtDateTime(lastLoadedAt)}</div>
        {error && <div className="settings-toast">{error}</div>}
        {notice && <div className="settings-toast settings-toast--success">{notice}</div>}
        <section className="approval-admin-panel">
          <div className="approval-admin-panel__header">
            <div>
              <div className="settings-panel__title">常駐通知文</div>
              <p>Android端末の位置記録通知に表示する文言です。端末側の次回同期で反映されます。</p>
            </div>
            <strong>{notificationText}</strong>
          </div>
          <label className="settings-field">
            <span>通知文</span>
            <input
              value={notificationDraft}
              maxLength={40}
              onChange={event => setNotificationDraft(event.target.value)}
              placeholder={DEFAULT_LOCATION_NOTIFICATION_TEXT}
            />
          </label>
          <div className="approval-request__actions">
            <button
              type="button"
              className="pill-link pill-link--approve"
              disabled={savingNotificationText}
              onClick={() => void handleSaveNotificationText()}
            >
              {savingNotificationText ? '保存中' : '保存'}
            </button>
          </div>
        </section>
        <section className="approval-admin-panel">
          <div className="approval-admin-panel__header">
            <div>
              <div className="settings-panel__title">承認待ち一覧</div>
              <p>新規登録後、管理者が許可するまで運行記録と同期は使えません。</p>
            </div>
            <strong>{pendingDevices.length}件</strong>
          </div>
          {pendingDevices.length === 0 ? (
            <div className="settings-note">現在、承認待ちの登録はありません。</div>
          ) : (
            <div className="approval-request-list">
              {pendingDevices.map(device => (
                <article className="approval-request" key={device.device_id}>
                  <div>
                    <strong>{getDisplayName(device)}</strong>
                    <span>{formatProfileValue(device.driver_email)} / {formatProfileValue(device.driver_phone)}</span>
                    <span>車番: {formatProfileValue(device.vehicle_label)} / 申請: {fmtDateTime(device.approval_requested_at ?? device.created_at ?? device.last_seen_at)}</span>
                  </div>
                  <div className="approval-request__actions">
                    <button
                      type="button"
                      className="pill-link pill-link--approve"
                      disabled={approvingDeviceId === device.device_id}
                      onClick={() => void handleSetApproval(device, 'approved')}
                    >
                      許可
                    </button>
                    <button
                      type="button"
                      className="pill-link pill-link--danger"
                      disabled={approvingDeviceId === device.device_id}
                      onClick={() => void handleSetApproval(device, 'rejected')}
                    >
                      拒否
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
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
                <th>メール</th>
                <th>電話</th>
                <th>承認</th>
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
                    <Link to={`/admin/devices/${encodeURIComponent(device.device_id)}`}>{getDisplayName(device)}</Link>
                  </td>
                  <td>{device.device_id.slice(0, 8)}</td>
                  <td>{formatProfileValue(device.driver_email)}</td>
                  <td>{formatProfileValue(device.driver_phone)}</td>
                  <td>
                    <span className={`approval-badge approval-badge--${getApprovalStatus(device)}`}>
                      {getApprovalLabel(device)}
                    </span>
                    {device.approval_decided_at && (
                      <div className="admin-table__subtext">{fmtDateTime(device.approval_decided_at)}</div>
                    )}
                  </td>
                  <td>
                    <span className={`admin-status-badge admin-status-badge--${deviceStatus.get(device.device_id)?.kind ?? 'stale'}`}>
                      {deviceStatus.get(device.device_id)?.label ?? '要確認'}
                    </span>
                    <div className="admin-table__subtext">{device.latest_status ?? '-'}</div>
                  </td>
                  <td>
                    {device.latest_lat != null && device.latest_lng != null
                      ? (
                        <>
                          <span>{device.latest_lat.toFixed(4)}, {device.latest_lng.toFixed(4)}</span>
                          <div className="admin-table__subtext">
                            {fmtDateTime(getLocationTimestamp(device))}
                            {formatAccuracy(device.latest_accuracy) ? ` / ${formatAccuracy(device.latest_accuracy)}` : ''}
                          </div>
                        </>
                      )
                      : '-'}
                  </td>
                  <td>{fmtDateTime(device.last_seen_at)}</td>
                  <td>{device.latest_trip_id ? device.latest_trip_id.slice(0, 8) : '-'}</td>
                  <td className="admin-action-cell">
                    {getApprovalStatus(device) !== 'approved' && (
                      <button
                        type="button"
                        className="pill-link pill-link--approve admin-delete-button"
                        disabled={approvingDeviceId === device.device_id}
                        onClick={() => void handleSetApproval(device, 'approved')}
                      >
                        許可
                      </button>
                    )}
                    {getApprovalStatus(device) !== 'rejected' && (
                      <button
                        type="button"
                        className="pill-link pill-link--danger admin-delete-button"
                        disabled={approvingDeviceId === device.device_id}
                        onClick={() => void handleSetApproval(device, 'rejected')}
                      >
                        拒否
                      </button>
                    )}
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
