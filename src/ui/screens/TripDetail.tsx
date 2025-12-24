import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  deleteEvent,
  deleteTrip,
  getEventsByTripId,
  refreshEventAddressFromGeo,
  updateEventAddressManual,
  updateEventTimestamp,
} from '../../db/repositories';
import type { AppEvent } from '../../domain/types';
import { buildTripViewModel, TripViewModel } from '../../state/selectors';

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

function label(ev: AppEvent) {
  switch (ev.type) {
    case 'trip_start':
      return '運行開始';
    case 'trip_end':
      return '運行終了';
    case 'rest_start':
      return '休息開始';
    case 'rest_end':
      return '休息終了';
    case 'break_start':
      return '休憩開始';
    case 'break_end':
      return '休憩終了';
    case 'load_start':
      return '積込開始';
    case 'load_end':
      return '積込終了';
    case 'refuel':
      return '給油';
    case 'expressway':
      return '高速道路';
    case 'expressway_start':
      return '高速開始';
    case 'expressway_end':
      return '高速終了';
    case 'boarding':
      return '乗船';
    default:
      return ev.type;
  }
}

function fmtRange(s: string, e?: string) {
  const fmt = (ts: string) =>
    new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
  return e ? `${fmt(s)} → ${fmt(e)}` : `${fmt(s)} → -`;
}

function fmtDurationMs(ms: number) {
  const mins = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}時間${m}分` : `${m}分`;
}

function formatGeo(ev: AppEvent) {
  if (ev.address) return ev.address as string;
  if ((ev as any).geo) {
    const { lat, lng } = (ev as any).geo;
    return `(${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)})`;
  }
  return undefined;
}

function findTogglePair(events: AppEvent[], ev: AppEvent) {
  const defs = [
    { start: 'rest_start', end: 'rest_end', key: 'restSessionId', label: '休息' },
    { start: 'break_start', end: 'break_end', key: 'breakSessionId', label: '休憩' },
    { start: 'load_start', end: 'load_end', key: 'loadSessionId', label: '積込' },
    { start: 'expressway_start', end: 'expressway_end', key: 'expresswaySessionId', label: '高速道路' },
  ];
  const def = defs.find(d => d.start === ev.type || d.end === ev.type);
  if (!def) return null;
  const keyVal = (ev as any).extras?.[def.key];
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  if (ev.type === def.start) {
    const end = sorted.find(e => e.type === def.end && ((e as any).extras?.[def.key] ?? '__legacy__') === (keyVal ?? '__legacy__'));
    return { start: ev, end, def };
  }
  if (ev.type === def.end) {
    const startCandidates = sorted.filter(e => e.type === def.start);
    let start: AppEvent | undefined = startCandidates.find(
      s => ((s as any).extras?.[def.key] ?? '__legacy__') === (keyVal ?? '__legacy__'),
    );
    if (!start && startCandidates.length > 0) {
      // fallback to latest start before this end
      start = [...startCandidates].reverse().find(s => s.ts <= ev.ts);
    }
    return { start, end: ev, def };
  }
  return null;
}

function buildDetail(events: AppEvent[], ev: AppEvent): string | undefined {
  // Toggle pairs with duration
  const pair = findTogglePair(events, ev);
  if (pair && pair.start && pair.end) {
    const range = fmtRange(pair.start.ts, pair.end.ts);
    const dur = fmtDurationMs(new Date(pair.end.ts).getTime() - new Date(pair.start.ts).getTime());
    let text = `${range}（${dur}）`;
    if (pair.def.label === '高速道路') {
      const icFrom = (pair.start as any).extras?.icName;
      const icTo = (pair.end as any).extras?.icName;
      if (icFrom || icTo) {
        text = `IC: ${icFrom ?? '不明'} → ${icTo ?? '不明'} / ${text}`;
      }
    }
    const loc = formatGeo(pair.start) || formatGeo(pair.end);
    return loc ? `${text} / ${loc}` : text;
  }

  // Single event detail
  switch (ev.type) {
    case 'refuel': {
      const liters = (ev as any).extras?.liters;
      return liters != null ? `${liters} L` : undefined;
    }
    case 'expressway':
    case 'expressway_start':
    case 'expressway_end': {
      const st = (ev as any).extras?.icResolveStatus;
      const name = (ev as any).extras?.icName;
      return st === 'resolved' ? `${name ?? 'IC'}（取得済）` : st === 'failed' ? 'IC取得失敗' : 'IC検索中';
    }
    case 'trip_end': {
      const totalKm = (ev as any).extras?.totalKm;
      const lastLegKm = (ev as any).extras?.lastLegKm;
      if (totalKm != null && lastLegKm != null) {
        return `総距離 ${totalKm}km / 最終区間 ${lastLegKm}km`;
      }
      return undefined;
    }
    case 'rest_end': {
      const dc = (ev as any).extras?.dayClose;
      const di = (ev as any).extras?.dayIndex;
      return dc ? `${di ?? ''}日目を締める` : '分割休息';
    }
    default: {
      return formatGeo(ev);
    }
  }
}

export default function TripDetail() {
  const { tripId } = useParams();
  const navigate = useNavigate();
  const [vm, setVm] = useState<TripViewModel | null>(null);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [addressEditing, setAddressEditing] = useState<{ id: string; value: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [workingId, setWorkingId] = useState<string | null>(null);

  function toLocalInputValue(ts: string) {
    const d = new Date(ts);
    const iso = d.toISOString();
    return iso.slice(0, 16); // YYYY-MM-DDTHH:mm
  }

  function fromLocalInputValue(v: string) {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  async function load() {
    if (!tripId) return;
    setErr(null);
    try {
      const events = await getEventsByTripId(tripId);
      const model = buildTripViewModel(tripId, events);
      setVm(model);
      setEvents(events);
    } catch (e: any) {
      setErr(e?.message ?? '読み込みに失敗しました');
    }
  }
  useEffect(() => {
    load();
  }, [tripId]);

  async function handleSaveTime() {
    if (!editing) return;
    const iso = fromLocalInputValue(editing.value);
    if (!iso) {
      alert('日時の形式が不正です');
      return;
    }
    setSaving(true);
    setWorkingId(editing.id);
    try {
      await updateEventTimestamp(editing.id, iso);
      setEditing(null);
      await load();
    } catch (e: any) {
      setErr(e?.message ?? '更新に失敗しました');
    } finally {
      setSaving(false);
      setWorkingId(null);
    }
  }

  async function handleSaveAddress() {
    if (!addressEditing) return;
    setSaving(true);
    setWorkingId(addressEditing.id);
    try {
      await updateEventAddressManual(addressEditing.id, addressEditing.value);
      setAddressEditing(null);
      await load();
    } catch (e: any) {
      setErr(e?.message ?? '住所の保存に失敗しました');
    } finally {
      setSaving(false);
      setWorkingId(null);
    }
  }

  async function handleRefreshAddress(eventId: string) {
    setWorkingId(eventId);
    try {
      const updated = await refreshEventAddressFromGeo(eventId);
      if (updated) {
        await load();
      } else {
        alert('住所を再取得できませんでした（通信状況と権限を確認してください）');
      }
    } catch (e: any) {
      setErr(e?.message ?? '住所の再取得に失敗しました');
    } finally {
      setWorkingId(null);
    }
  }

  async function handleDeleteEvent(eventId: string) {
    const ok = window.confirm('このイベントを削除します。よろしいですか？');
    if (!ok) return;
    setWorkingId(eventId);
    try {
      await deleteEvent(eventId);
      await load();
    } catch (e: any) {
      setErr(e?.message ?? '削除に失敗しました');
    } finally {
      setWorkingId(null);
    }
  }

  if (!tripId) {
    return <div style={{ padding: 16 }}>tripId が不正です</div>;
  }
  return (
    <div style={{ padding: 16, maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 900 }}>運行詳細</div>
          <div style={{ opacity: 0.8, fontSize: 12 }}>tripId: {tripId}</div>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <Link to="/" className="pill-link">ホーム</Link>
          <Link to="/history" className="pill-link">履歴</Link>
          <button onClick={load} style={{ padding: '8px 10px', borderRadius: 12 }}>再読込</button>
        </div>
      </div>
      {err && (
        <div style={{ background: '#7f1d1d', color: '#fff', padding: 12, borderRadius: 12 }}>{err}</div>
      )}
      {!vm && !err && <div>読み込み中…</div>}
      {vm && (
        <>
          <div style={{ marginBottom: 12 }}>
            <button
              style={{ padding: '8px 12px', borderRadius: 12, background: '#7f1d1d', color: '#fff', fontWeight: 800 }}
              onClick={async () => {
                if (!tripId) return;
                const ok = window.confirm('この運行の履歴をすべて削除します。よろしいですか？');
                if (!ok) return;
                setDeleting(true);
                try {
                  await deleteTrip(tripId);
                  navigate('/history');
                } catch (e: any) {
                  setErr(e?.message ?? '削除に失敗しました');
                } finally {
                  setDeleting(false);
                }
              }}
              disabled={deleting}
            >
              {deleting ? '削除中…' : 'この運行を削除'}
            </button>
          </div>
          <div style={{ display: 'grid', gap: 10, marginBottom: 14 }}>
            <div className="card" style={{ color: '#fff', padding: 12, borderRadius: 16 }}>
              <div style={{ fontWeight: 900, marginBottom: 6 }}>距離サマリー</div>
              <div style={{ opacity: 0.9 }}>
                開始ODO: {vm.odoStart} km / 終了ODO: {vm.odoEnd ?? '-'} km
              </div>
              <div style={{ marginTop: 8 }}>
                <div>総距離: {vm.totalKm ?? '-'} km</div>
                <div>最終区間: {vm.lastLegKm ?? '-'} km</div>
              </div>
            </div>
            {!vm.validation.ok && (
              <div style={{ background: '#7c2d12', color: '#fff', padding: 12, borderRadius: 16 }}>
                <div style={{ fontWeight: 900, marginBottom: 6 }}>整合性チェック</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {vm.validation.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div style={{ display: 'grid', gap: 10 }}>
            <div className="card" style={{ color: '#fff', padding: 12, borderRadius: 16 }}>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>区間距離一覧（分割休息も含む）</div>
              <div style={{ display: 'grid', gap: 6 }}>
                {vm.segments.map(seg => (
                  <div key={seg.index} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, padding: '8px 10px', borderRadius: 12, background: '#0b0b0b' }}>
                    <div style={{ opacity: 0.95 }}>
                      <div style={{ fontWeight: 800 }}>{seg.fromLabel} → {seg.toLabel}</div>
                      <div style={{ opacity: 0.8, fontSize: 12 }}>{fmtLocal(seg.fromTs)} → {fmtLocal(seg.toTs)}</div>
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 900, color: seg.valid ? '#fff' : '#fecaca' }}>{seg.km} km</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="card" style={{ color: '#fff', padding: 12, borderRadius: 16 }}>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>日別運行（休息終了で「はい」を押した分だけ確定）</div>
              <div style={{ display: 'grid', gap: 6 }}>
                {vm.dayRuns.map(day => (
                  <div key={day.dayIndex} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, padding: '8px 10px', borderRadius: 12, background: '#0b0b0b' }}>
                    <div>
                      <div style={{ fontWeight: 900 }}>{day.dayIndex}日目 {day.status === 'pending' ? '（締め待ち）' : ''}</div>
                      <div style={{ opacity: 0.8, fontSize: 12 }}>{day.fromLabel} → {day.toLabel}</div>
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 900 }}>{day.km} km</div>
                  </div>
                ))}
              </div>
            </div>
              <div className="card" style={{ color: '#fff', padding: 12, borderRadius: 16 }}>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>イベント一覧</div>
              <div style={{ display: 'grid', gap: 6 }}>
                {events.map((ev, idx) => {
                  const t = timeline[idx];
                  const isEditing = editing?.id === ev.id;
                  const isEditingAddress = addressEditing?.id === ev.id;
                  const busy = workingId === ev.id;
                  const geo = (ev as any).geo as any;
                  const title = label(ev);
                  return (
                    <div key={ev.id} style={{ padding: '8px 10px', borderRadius: 12, background: '#0b0b0b' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                        <div>
                          <div style={{ fontWeight: 900 }}>{t?.title ?? title}</div>
                          <div style={{ opacity: 0.8, fontSize: 12 }}>
                            {isEditing ? (
                              <input
                                type="datetime-local"
                                value={editing?.value ?? toLocalInputValue(ev.ts)}
                                onChange={e => setEditing({ id: ev.id, value: e.target.value })}
                                style={{ background: '#111', color: '#fff', border: '1px solid #374151', borderRadius: 8, padding: '4px 6px' }}
                              />
                            ) : (
                              fmtLocal(ev.ts)
                            )}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          {isEditing ? (
                            <>
                              <button
                                onClick={handleSaveTime}
                                disabled={saving || busy}
                                style={{ padding: '6px 8px', borderRadius: 8 }}
                              >
                                {saving ? '保存中…' : '保存'}
                              </button>
                              <button
                                onClick={() => setEditing(null)}
                                style={{ padding: '6px 8px', borderRadius: 8 }}
                              >
                                キャンセル
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => setEditing({ id: ev.id, value: toLocalInputValue(ev.ts) })}
                              style={{ padding: '6px 8px', borderRadius: 8 }}
                            >
                              時刻編集
                            </button>
                          )}
                          <button
                            onClick={() => void handleDeleteEvent(ev.id)}
                            disabled={busy}
                            style={{ padding: '6px 8px', borderRadius: 8, background: '#7f1d1d', color: '#fff' }}
                          >
                            {busy ? '削除中…' : '削除'}
                          </button>
                        </div>
                      </div>
                      {t?.detail && <div style={{ opacity: 0.85, fontSize: 12, marginTop: 4 }}>{t.detail}</div>}
                      <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
                        <div style={{ fontSize: 12, opacity: 0.85 }}>
                          地点: {ev.address ?? '未取得'}
                          {geo ? (
                            <span style={{ marginLeft: 6, opacity: 0.75 }}>
                              ({Number(geo.lat).toFixed(5)}, {Number(geo.lng).toFixed(5)})
                            </span>
                          ) : (
                            <span style={{ marginLeft: 6, opacity: 0.65 }}>(位置情報なし)</span>
                          )}
                        </div>
                        {isEditingAddress ? (
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <input
                              type="text"
                              value={addressEditing?.value ?? ''}
                              onChange={e => setAddressEditing({ id: ev.id, value: e.target.value })}
                              style={{ flex: 1, minWidth: 220, background: '#111', color: '#fff', border: '1px solid #374151', borderRadius: 8, padding: '6px 8px' }}
                            />
                            <button
                              onClick={handleSaveAddress}
                              disabled={saving || busy}
                              style={{ padding: '6px 8px', borderRadius: 8 }}
                            >
                              {saving ? '保存中…' : '住所保存'}
                            </button>
                            <button onClick={() => setAddressEditing(null)} style={{ padding: '6px 8px', borderRadius: 8 }}>
                              キャンセル
                            </button>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <button
                              onClick={() => setAddressEditing({ id: ev.id, value: ev.address ?? '' })}
                              style={{ padding: '6px 8px', borderRadius: 8 }}
                            >
                              住所編集
                            </button>
                            <button
                              onClick={() => void handleRefreshAddress(ev.id)}
                              disabled={!geo || busy}
                              style={{ padding: '6px 8px', borderRadius: 8, opacity: geo ? 1 : 0.5 }}
                            >
                              {busy ? '再取得中…' : '位置から再取得'}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
