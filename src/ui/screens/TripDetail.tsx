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
    case 'unload_start':
      return '荷卸開始';
    case 'unload_end':
      return '荷卸終了';
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

const toggleDefs = [
  { start: 'rest_start', end: 'rest_end', key: 'restSessionId', label: '休息' },
  { start: 'break_start', end: 'break_end', key: 'breakSessionId', label: '休憩' },
  { start: 'load_start', end: 'load_end', key: 'loadSessionId', label: '積込' },
  { start: 'unload_start', end: 'unload_end', key: 'unloadSessionId', label: '荷卸' },
  { start: 'expressway_start', end: 'expressway_end', key: 'expresswaySessionId', label: '高速道路' },
];

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

type GroupedItem = {
  id: string;
  title: string;
  range?: string;
  duration?: string;
  detail?: string;
  addresses?: string[];
  places?: Array<{ label?: string; lat?: number; lng?: number; address?: string }>;
};

type AiSharePayload = {
  tripId: string;
  generatedAt: string;
  summary: {
    hasTripEnd: boolean;
    startTs: string | null;
    endTs: string | null;
    startAddress: string | null;
    endAddress: string | null;
    odoStart: number;
    odoEnd: number | null;
    totalKm: number | null;
    lastLegKm: number | null;
  };
  validation: TripViewModel['validation'];
  segments: TripViewModel['segments'];
  dayRuns: TripViewModel['dayRuns'];
  timeline: TripViewModel['timeline'];
  events: AppEvent[];
};

function buildGrouped(events: AppEvent[]): GroupedItem[] {
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  const used = new Set<string>();
  const out: GroupedItem[] = [];

  const findStartForEnd = (endEv: AppEvent, def: typeof toggleDefs[number]) => {
    const keyVal = (endEv as any).extras?.[def.key];
    const candidates = sorted.filter(e => e.type === def.start);
    let start = candidates.find(s => ((s as any).extras?.[def.key] ?? '__legacy__') === (keyVal ?? '__legacy__'));
    if (!start && candidates.length > 0) {
      start = [...candidates].reverse().find(s => s.ts <= endEv.ts);
    }
    return start;
  };

  for (const ev of sorted) {
    if (used.has(ev.id)) continue;
    // Pairable types
    const def = toggleDefs.find(d => d.start === ev.type || d.end === ev.type);
    if (def) {
      let start: AppEvent | undefined;
      let end: AppEvent | undefined;
      if (ev.type === def.start) {
        start = ev;
        const keyVal = (ev as any).extras?.[def.key];
        end = sorted.find(
          e => e.type === def.end && ((e as any).extras?.[def.key] ?? '__legacy__') === (keyVal ?? '__legacy__') && e.ts >= ev.ts,
        );
      } else {
        end = ev;
        start = findStartForEnd(ev, def);
      }
      if (start && end) {
        used.add(start.id);
        used.add(end.id);
        const range = fmtRange(start.ts, end.ts);
        const duration = fmtDurationMs(new Date(end.ts).getTime() - new Date(start.ts).getTime());
        const addresses = [start.address, end.address].filter((a): a is string => !!a);
        const places: GroupedItem['places'] = [];
        if ((start as any).geo) places.push({ label: '開始', ...(start as any).geo, address: start.address });
        if ((end as any).geo) places.push({ label: '終了', ...(end as any).geo, address: end.address });
        let detail: string | undefined;
        if (def.label === '高速道路') {
          const icFrom = (start as any).extras?.icName;
          const icTo = (end as any).extras?.icName;
          detail = `IC: ${icFrom ?? '不明'} → ${icTo ?? '不明'}`;
        }
        out.push({
          id: `${start.id}-${end.id}`,
          title: def.label,
          range,
          duration,
          detail,
          addresses: addresses.length ? Array.from(new Set(addresses)) : undefined,
          places: places.length ? places : undefined,
        });
        continue;
      }
    }

    // Trip start/end grouping
    if (ev.type === 'trip_start') {
      const end = sorted.find(e => e.type === 'trip_end');
      if (end) {
        used.add(ev.id);
        used.add(end.id);
        out.push({
          id: `${ev.id}-${end.id}`,
          title: '運行',
          range: fmtRange(ev.ts, end.ts),
          duration: fmtDurationMs(new Date(end.ts).getTime() - new Date(ev.ts).getTime()),
          addresses: [ev.address, end.address].filter((a): a is string => !!a),
          places: [
            ...(ev.geo ? [{ label: '開始', ...(ev.geo as any), address: ev.address }] : []),
            ...(end.geo ? [{ label: '終了', ...(end.geo as any), address: end.address }] : []),
          ].filter(Boolean),
          detail: (() => {
            const totalKm = (end as any).extras?.totalKm;
            const lastLegKm = (end as any).extras?.lastLegKm;
            if (totalKm != null && lastLegKm != null) return `総距離 ${totalKm}km / 最終区間 ${lastLegKm}km`;
            return undefined;
          })(),
        });
        continue;
      }
    }
    if (ev.type === 'trip_end' && sorted.find(e => e.type === 'trip_start')) {
      // trip_end は trip_start で処理済み
      if (!used.has(ev.id)) used.add(ev.id);
      continue;
    }

    // Single events
    used.add(ev.id);
    let detail: string | undefined;
    if (ev.type === 'refuel') {
      const liters = (ev as any).extras?.liters;
      detail = liters != null ? `${liters} L` : undefined;
    } else if (ev.type === 'expressway') {
      const st = (ev as any).extras?.icResolveStatus;
      const name = (ev as any).extras?.icName;
      detail = st === 'resolved' ? `${name ?? 'IC'}（取得済）` : st === 'failed' ? 'IC取得失敗' : 'IC検索中';
    } else if (ev.type === 'rest_end') {
      const dc = (ev as any).extras?.dayClose;
      const di = (ev as any).extras?.dayIndex;
      detail = dc ? `${di ?? ''}日目を締める` : '分割休息';
    }

    out.push({
      id: ev.id,
      title: label(ev),
      range: fmtRange(ev.ts),
      detail,
      addresses: ev.address ? [ev.address] : undefined,
      places: ev.geo ? [{ ...(ev as any).geo, address: ev.address }] : undefined,
    });
  }

  return out;
}

function buildAiPayload(tripId: string, vm: TripViewModel, events: AppEvent[]): AiSharePayload {
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  const tripStart = sorted.find(e => e.type === 'trip_start');
  const tripEnd = [...sorted].reverse().find(e => e.type === 'trip_end');
  return {
    tripId,
    generatedAt: new Date().toISOString(),
    summary: {
      hasTripEnd: vm.hasTripEnd,
      startTs: tripStart?.ts ?? null,
      endTs: tripEnd?.ts ?? null,
      startAddress: tripStart?.address ?? null,
      endAddress: tripEnd?.address ?? null,
      odoStart: vm.odoStart,
      odoEnd: vm.odoEnd ?? null,
      totalKm: vm.totalKm ?? null,
      lastLegKm: vm.lastLegKm ?? null,
    },
    validation: vm.validation,
    segments: vm.segments,
    dayRuns: vm.dayRuns,
    timeline: vm.timeline,
    events: sorted,
  };
}

function buildAiShareText(payload: AiSharePayload) {
  return [
    '以下の運行履歴を要約してください。',
    '',
    '---',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.focus();
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) {
    throw new Error('コピーに失敗しました');
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
  const [sharing, setSharing] = useState(false);
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

  async function handleShareAi() {
    if (!tripId || !vm) return;
    setSharing(true);
    setErr(null);
    try {
      const payload = buildAiPayload(tripId, vm, events);
      const text = buildAiShareText(payload);
      if (navigator.share) {
        try {
          await navigator.share({ title: '運行ログ', text });
          return;
        } catch (e: any) {
          if (e?.name === 'AbortError') return;
        }
      }
      await copyText(text);
      alert('AI送信用テキストをコピーしました。ChatGPT/Geminiに貼り付けてください。');
    } catch (e: any) {
      setErr(e?.message ?? 'AI共有に失敗しました');
    } finally {
      setSharing(false);
    }
  }

  if (!tripId) {
    return <div style={{ padding: 16 }}>tripId が不正です</div>;
  }
  const grouped = buildGrouped(events);
  return (
    <div style={{ padding: 18, maxWidth: 960, margin: '0 auto', fontSize: 17, lineHeight: 1.6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontSize: 24, fontWeight: 900 }}>運行詳細</div>
          <div style={{ opacity: 0.8, fontSize: 15 }}>tripId: {tripId}</div>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Link to="/" className="pill-link">ホーム</Link>
          <Link to="/history" className="pill-link">履歴</Link>
          <button
            onClick={handleShareAi}
            disabled={sharing || !vm}
            className="pill-link"
            style={{ borderColor: '#334155', background: '#0f172a' }}
          >
            {sharing ? 'AI共有中…' : 'AI共有'}
          </button>
          <button onClick={load} style={{ padding: '12px 14px', borderRadius: 12, fontWeight: 800, fontSize: 15 }}>再読込</button>
        </div>
      </div>
      {err && (
        <div style={{ background: '#7f1d1d', color: '#fff', padding: 12, borderRadius: 12 }}>{err}</div>
      )}
      {!vm && !err && <div>読み込み中…</div>}
      {vm && (
        <>
          <div style={{ marginBottom: 16 }}>
            <button
              style={{ padding: '12px 16px', borderRadius: 16, background: '#7f1d1d', color: '#fff', fontWeight: 850, fontSize: 16 }}
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
          <div style={{ display: 'grid', gap: 14, marginBottom: 18 }}>
            <div className="card" style={{ color: '#fff', padding: 18, borderRadius: 20 }}>
              <div style={{ fontWeight: 900, marginBottom: 10, fontSize: 18 }}>距離サマリー</div>
              <div style={{ opacity: 0.92, fontSize: 16 }}>
                開始ODO: {vm.odoStart} km / 終了ODO: {vm.odoEnd ?? '-'} km
              </div>
              <div style={{ marginTop: 10, display: 'grid', gap: 8, fontSize: 16 }}>
                <div>総距離: {vm.totalKm ?? '-'} km</div>
                <div>最終区間: {vm.lastLegKm ?? '-'} km</div>
              </div>
            </div>
            {!vm.validation.ok && (
              <div style={{ background: '#7c2d12', color: '#fff', padding: 14, borderRadius: 16, fontSize: 15 }}>
                <div style={{ fontWeight: 900, marginBottom: 8 }}>整合性チェック</div>
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {vm.validation.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div style={{ display: 'grid', gap: 14 }}>
            <div className="card" style={{ color: '#fff', padding: 18, borderRadius: 20 }}>
              <div style={{ fontWeight: 900, marginBottom: 12, fontSize: 18 }}>区間距離一覧（分割休息も含む）</div>
              <div style={{ display: 'grid', gap: 10 }}>
                {vm.segments.map(seg => (
                  <div key={seg.index} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, padding: '12px 14px', borderRadius: 16, background: '#0b0b0b' }}>
                    <div style={{ opacity: 0.95 }}>
                      <div style={{ fontWeight: 850, fontSize: 17 }}>{seg.fromLabel} → {seg.toLabel}</div>
                      <div style={{ opacity: 0.85, fontSize: 14 }}>{fmtLocal(seg.fromTs)} → {fmtLocal(seg.toTs)}</div>
                    </div>
                    <div style={{ fontSize: 21, fontWeight: 900, color: seg.valid ? '#fff' : '#fecaca' }}>{seg.km} km</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="card" style={{ color: '#fff', padding: 18, borderRadius: 20 }}>
              <div style={{ fontWeight: 900, marginBottom: 12, fontSize: 18 }}>日別運行（休息終了で「はい」を押した分だけ確定）</div>
              <div style={{ display: 'grid', gap: 10 }}>
                {vm.dayRuns.map(day => (
                  <div key={day.dayIndex} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, padding: '12px 14px', borderRadius: 16, background: '#0b0b0b' }}>
                    <div>
                      <div style={{ fontWeight: 900, fontSize: 17 }}>{day.dayIndex}日目 {day.status === 'pending' ? '（締め待ち）' : ''}</div>
                      <div style={{ opacity: 0.85, fontSize: 14 }}>{day.fromLabel} → {day.toLabel}</div>
                      {day.closeOdo != null && (
                        <div style={{ opacity: 0.85, fontSize: 14 }}>ODO: {day.closeOdo} km</div>
                      )}
                    </div>
                    <div style={{ fontSize: 21, fontWeight: 900 }}>{day.km} km</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="card" style={{ color: '#fff', padding: 18, borderRadius: 20 }}>
              <div style={{ fontWeight: 900, marginBottom: 12, fontSize: 18 }}>イベント一覧</div>
              <div style={{ display: 'grid', gap: 12 }}>
                {grouped.map(item => (
                  <div key={item.id} style={{ padding: '14px 14px', borderRadius: 16, background: '#0b0b0b', display: 'grid', gap: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
                      <div style={{ fontWeight: 900, fontSize: 18 }}>{item.title}</div>
                      {item.range && <div style={{ fontSize: 16, opacity: 0.92 }}>{item.range}</div>}
                    </div>
                    {item.duration && (
                      <div style={{ fontSize: 16, fontWeight: 700, opacity: 0.9 }}>所要時間: {item.duration}</div>
                    )}
                    {item.detail && <div style={{ opacity: 0.92, fontSize: 15 }}>{item.detail}</div>}
                    {item.addresses && item.addresses.length > 0 && (
                      <div style={{ display: 'grid', gap: 4, fontSize: 15, opacity: 0.92 }}>
                        {item.addresses.map((a, i) => (
                          <div key={i}>住所: {a}</div>
                        ))}
                      </div>
                    )}
                    {item.places && item.places.length > 0 && (
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {item.places.map((p, i) => {
                          const query = p.lat != null && p.lng != null
                            ? `${p.lat},${p.lng}`
                            : encodeURIComponent(p.address ?? '');
                          const mapUrl = p.lat != null && p.lng != null
                            ? `https://www.google.com/maps?q=${query}`
                            : `https://www.google.com/maps/search/?api=1&query=${query}`;
                          const navUrl = `https://www.google.com/maps/dir/?api=1&destination=${query}`;
                          const label = p.label ? `${p.label}地点` : '地点';
                          return (
                            <div key={i} style={{ display: 'flex', gap: 6 }}>
                              <a
                                href={mapUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="pill-link"
                                style={{ fontSize: 13 }}
                              >
                                {label}を地図で開く
                              </a>
                              <a
                                href={navUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="pill-link"
                                style={{ fontSize: 13 }}
                              >
                                ナビで開く
                              </a>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
