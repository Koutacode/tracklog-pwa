import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { deleteTrip, getAllEvents, listTrips, TripSummary } from '../../db/repositories';

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

function downloadBlob(filename: string, data: string, type: string) {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function toCsvValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    v = JSON.stringify(v);
  }
  const s = String(v);
  const escaped = s.replace(/"/g, '""');
  return `"${escaped}"`;
}

export default function HistoryScreen() {
  const [rows, setRows] = useState<TripSummary[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
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

  async function handleExportJSON() {
    setExporting(true);
    setErr(null);
    try {
      const events = await getAllEvents();
      downloadBlob(`tracklog-events-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(events, null, 2), 'application/json');
    } catch (e: any) {
      setErr(e?.message ?? 'JSON出力に失敗しました');
    } finally {
      setExporting(false);
    }
  }

  async function handleExportCSV() {
    setExporting(true);
    setErr(null);
    try {
      const events = await getAllEvents();
      const header = ['id', 'tripId', 'type', 'ts', 'address', 'lat', 'lng', 'accuracy', 'syncStatus', 'extras'];
      const rowsCsv = events.map(ev => {
        const geo = (ev as any).geo as any;
        const extras = (ev as any).extras ?? {};
        return [
          toCsvValue(ev.id),
          toCsvValue(ev.tripId),
          toCsvValue(ev.type),
          toCsvValue(ev.ts),
          toCsvValue(ev.address ?? ''),
          toCsvValue(geo?.lat ?? ''),
          toCsvValue(geo?.lng ?? ''),
          toCsvValue(geo?.accuracy ?? ''),
          toCsvValue(ev.syncStatus),
          toCsvValue(extras),
        ].join(',');
      });
      const csv = [header.join(','), ...rowsCsv].join('\r\n');
      downloadBlob(`tracklog-events-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv');
    } catch (e: any) {
      setErr(e?.message ?? 'CSV出力に失敗しました');
    } finally {
      setExporting(false);
    }
  }
  return (
    <div className="page-shell">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 20, fontWeight: 900 }}>運行履歴</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button
            onClick={handleExportJSON}
            disabled={exporting}
            className="pill-link"
            style={{ borderColor: '#334155', background: '#0f172a' }}
          >
            {exporting ? '出力中…' : 'JSON出力'}
          </button>
          <button
            onClick={handleExportCSV}
            disabled={exporting}
            className="pill-link"
            style={{ borderColor: '#334155', background: '#0f172a' }}
          >
            {exporting ? '出力中…' : 'CSV出力'}
          </button>
          <Link to="/" className="pill-link">ホーム</Link>
        </div>
      </div>
      {err && <div style={{ background: '#7f1d1d', color: '#fff', padding: 12, borderRadius: 12 }}>{err}</div>}
      <div style={{ display: 'grid', gap: 8 }}>
        {rows.map(r => (
          <Link
            key={r.tripId}
            to={`/trip/${r.tripId}`}
            className="card"
            style={{ textDecoration: 'none', color: '#fff', padding: 12, borderRadius: 16, border: '1px solid rgba(255,255,255,0.08)' }}
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
                  className="trip-detail__button trip-detail__button--danger trip-detail__button--small"
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
