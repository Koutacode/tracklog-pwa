import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { deleteTrip, listTrips, TripSummary } from '../../db/repositories';

function fmtLocal(ts?: string) {
  if (!ts) return '-';
  const d = new Date(ts);
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

function diffMinutes(start?: string, end?: string) {
  if (!start) return undefined;
  const s = Date.parse(start);
  const e = end ? Date.parse(end) : Date.now();
  if (Number.isNaN(s) || Number.isNaN(e)) return undefined;
  const diff = Math.max(0, Math.floor((e - s) / 60000));
  return diff;
}

function fmtDuration(mins?: number) {
  if (mins == null) return '-';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}分`;
  if (m === 0) return `${h}時間`;
  return `${h}時間${m}分`;
}

export default function HistoryScreen() {
  const [rows, setRows] = useState<TripSummary[]>([]);
  const [err, setErr] = useState<string | null>(null);
  async function load() {
    setErr(null);
    try {
      const r = await listTrips();
      setRows(r);
    } catch (e: any) {
      setErr(e?.message ?? '読み込みに失敗しました');
    }
  }
  useEffect(() => {
    load();
  }, []);
  async function handleDelete(tripId: string) {
    const ok = window.confirm('この運行を削除します。よろしいですか？');
    if (!ok) return;
    try {
      await deleteTrip(tripId);
      await load();
    } catch (e: any) {
      setErr(e?.message ?? '削除に失敗しました');
    }
  }
  return (
    <div className="page-shell">
      <div className="page-head">
        <div className="page-head__title">運行履歴</div>
        <div className="page-head__actions">
          <Link to="/" className="pill-link">ホーム</Link>
        </div>
      </div>
      {err && <div className="trip-detail__alert">{err}</div>}
      <div className="history-list">
        {rows.length === 0 && !err && (
          <div className="card history-card" style={{ textAlign: 'center' }}>
            まだ履歴がありません。運行開始から記録を作成してください。
          </div>
        )}
        {rows.map(r => (
          <Link
            key={r.tripId}
            to={`/trip/${r.tripId}`}
            className="card history-card"
          >
            <div className="history-card__row">
              <div className={`history-card__status ${r.status === 'active' ? 'history-card__status--active' : ''}`}>
                {r.status === 'active' ? '運行中' : '運行終了'}
              </div>
              <div className="history-card__id">#{r.tripId.slice(0, 8)}</div>
            </div>
            <div className="history-card__range">
              {fmtLocal(r.startTs)} → {fmtLocal(r.endTs)}
            </div>
            <div className="history-card__meta">
              {r.endTs ? '所要' : '経過'}: {fmtDuration(diffMinutes(r.startTs, r.endTs))}
            </div>
            <div className="history-card__metrics">
              <div className="metric-chip"><span>ODO</span> {r.odoStart} → {r.odoEnd ?? '-'}</div>
              <div className="metric-chip"><span>総距離</span> {r.totalKm ?? '-'} km</div>
              <div className="metric-chip"><span>最終区間</span> {r.lastLegKm ?? '-'} km</div>
            </div>
            <div className="history-card__actions">
              <button
                onClick={e => {
                  e.preventDefault();
                  e.stopPropagation();
                  void handleDelete(r.tripId);
                }}
                className="trip-detail__button trip-detail__button--danger trip-detail__button--small"
              >
                削除
              </button>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
