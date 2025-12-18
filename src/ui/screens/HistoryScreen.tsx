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
    const ok = window.confirm('この運行の履歴を削除します。よろしいですか？');
    if (!ok) return;
    try {
      await deleteTrip(tripId);
      await load();
    } catch (e: any) {
      setErr(e?.message ?? '削除に失敗しました');
    }
  }
  return (
    <div style={{ padding: 16, maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 20, fontWeight: 900 }}>履歴</div>
        <Link to="/" style={{ color: '#93c5fd' }}>ホーム</Link>
      </div>
      {err && <div style={{ background: '#7f1d1d', color: '#fff', padding: 12, borderRadius: 12 }}>{err}</div>}
      <div style={{ display: 'grid', gap: 8 }}>
        {rows.map(r => (
          <Link
            key={r.tripId}
            to={`/trip/${r.tripId}`}
            style={{ textDecoration: 'none', color: '#fff', background: '#111', padding: 12, borderRadius: 16 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <div>
                <div style={{ fontWeight: 900, lineHeight: 1.4 }}>
                  {r.status === 'active' ? '運行中' : '運行終了'} / {fmtLocal(r.startTs)} → {fmtLocal(r.endTs)}
                  <div style={{ fontSize: 12, opacity: 0.85 }}>
                    {r.endTs ? '所要' : '経過'}: {fmtDuration(diffMinutes(r.startTs, r.endTs))}
                  </div>
                </div>
                <div style={{ opacity: 0.85, fontSize: 12 }}>
                  ODO: {r.odoStart} → {r.odoEnd ?? '-'} / 総距離: {r.totalKm ?? '-'} km / 最終区間: {r.lastLegKm ?? '-'} km
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                <div style={{ opacity: 0.8, fontSize: 12 }}>{r.tripId.slice(0, 8)}</div>
                <button
                  onClick={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    void handleDelete(r.tripId);
                  }}
                  style={{ padding: '4px 6px', borderRadius: 8, fontSize: 12 }}
                >
                  削除
                </button>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
