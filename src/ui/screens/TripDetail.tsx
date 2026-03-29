import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  deleteEvent,
  deleteTrip,
  getEventsByTripId,
  refreshEventAddressFromGeo,
  updateEventAddressManual,
  updateEventLiters,
  updateEventOdo,
  updateEventTimestamp,
  updateEventType,
} from '../../db/repositories';
import { getReportTrip, saveReportTrip } from '../../db/reportRepository';
import type { AppEvent, EventType } from '../../domain/types';
import {
  buildImportableDayRunsFromAppEvents,
  buildReportTripFromAppEvents,
  computeDayMetrics,
  computeTripDayMetrics,
  formatMinutes,
  formatMinutesShort,
  formatRoundedJstTime,
  parseJsonToTrip,
} from '../../domain/reportLogic';
import { buildTripViewModel, TripViewModel } from '../../state/selectors';
import { DAY_MS, getJstDateInfo } from '../../domain/jst';
import { openNoteInObsidian, saveMarkdownToObsidian, shareText, shareTextToPackage } from '../../services/nativeShare';

const OBSIDIAN_VAULT_NAME = 'AI';
const OBSIDIAN_NOTE_DIR = 'Inbox';

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
      return 'フェリー乗船';
    case 'disembark':
      return 'フェリー下船';
    case 'point_mark':
      return '地点マーク';
    default:
      return 'イベント';
  }
}

const toggleDefs = [
  { start: 'rest_start', end: 'rest_end', key: 'restSessionId', label: '休息' },
  { start: 'break_start', end: 'break_end', key: 'breakSessionId', label: '休憩' },
  { start: 'load_start', end: 'load_end', key: 'loadSessionId', label: '積込' },
  { start: 'unload_start', end: 'unload_end', key: 'unloadSessionId', label: '荷卸' },
  { start: 'expressway_start', end: 'expressway_end', key: 'expresswaySessionId', label: '高速道路' },
  { start: 'boarding', end: 'disembark', key: 'ferrySessionId', label: 'フェリー' },
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
  ts: string;
  title: string;
  range?: string;
  duration?: string;
  detail?: string;
  addresses?: string[];
  places?: Array<{ label?: string; lat?: number; lng?: number; address?: string }>;
};

type NumericEditField = 'odoKm' | 'liters';

type NumericEditDef = {
  field: NumericEditField;
  label: string;
  value?: number;
  min?: number;
  step?: number;
};

const EDITABLE_EVENT_TYPES: EventType[] = [
  'rest_start',
  'rest_end',
  'break_start',
  'break_end',
  'load_start',
  'load_end',
  'unload_start',
  'unload_end',
  'expressway_start',
  'expressway_end',
  'expressway',
  'refuel',
  'boarding',
  'disembark',
  'point_mark',
];

type DayGroup<T> = {
  dayIndex: number;
  dateLabel: string;
  items: T[];
};

type AiSharePayload = {
  recordType: 'operation_log';
  tripId: string;
  generatedAt: string;
  dayRuns: ReturnType<typeof buildImportableDayRunsFromAppEvents>;
  summary: {
    hasTripEnd: boolean;
    startTs: string;
    endTs: string | null;
    startAddress?: string;
    endAddress?: string;
    odoStart: number;
    odoEnd: number | null;
    totalKm: number | null;
    lastLegKm: number | null;
  };
  segments: Array<{
    index: number;
    toTs?: string;
    toOdo: number;
    restSessionIdTo?: string;
  }>;
  timeline: TripViewModel['timeline'];
};

function getNumericEditDef(ev: AppEvent): NumericEditDef | null {
  const extras = (ev as any).extras ?? {};
  if (ev.type === 'trip_start') {
    return { field: 'odoKm', label: '開始ODO（km）', value: extras.odoKm, min: 0, step: 1 };
  }
  if (ev.type === 'rest_start') {
    return { field: 'odoKm', label: '休息開始ODO（km）', value: extras.odoKm, min: 0, step: 1 };
  }
  if (ev.type === 'trip_end') {
    return { field: 'odoKm', label: '終了ODO（km）', value: extras.odoKm, min: 0, step: 1 };
  }
  if (ev.type === 'refuel') {
    return { field: 'liters', label: '給油量（L）', value: extras.liters, min: 0, step: 0.1 };
  }
  return null;
}

function getDayIndexByStamp(dayStamp: number, startDayStamp: number) {
  if (!Number.isFinite(dayStamp) || !Number.isFinite(startDayStamp)) return 1;
  return Math.floor((dayStamp - startDayStamp) / DAY_MS) + 1;
}

function groupItemsByDay<T extends { ts: string }>(items: T[], tripStartTs: string): DayGroup<T>[] {
  if (items.length === 0) return [];
  const startInfo = getJstDateInfo(tripStartTs);
  const startDayStamp = startInfo.dayStamp;
  const groups = new Map<number, DayGroup<T>>();
  for (const item of items) {
    const info = getJstDateInfo(item.ts);
    const dayIndex = getDayIndexByStamp(info.dayStamp, startDayStamp);
    const entry = groups.get(info.dayStamp);
    if (entry) {
      entry.items.push(item);
    } else {
      groups.set(info.dayStamp, {
        dayIndex,
        dateLabel: info.dateLabel,
        items: [item],
      });
    }
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

function buildGrouped(events: AppEvent[]): GroupedItem[] {
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  const tripStart = sorted.find(e => e.type === 'trip_start');
  const startDayStamp = tripStart ? getJstDateInfo(tripStart.ts).dayStamp : null;
  const getDayIndex = (ts: string) => {
    if (startDayStamp == null) return undefined;
    const info = getJstDateInfo(ts);
    return getDayIndexByStamp(info.dayStamp, startDayStamp);
  };
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
          ts: start.ts,
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
      const di = dc ? getDayIndex(ev.ts) : undefined;
      if (dc) detail = `${di ?? ''}日目を締める`;
    } else if (ev.type === 'point_mark') {
      detail = ((ev as any).extras?.label as string | undefined) ?? '地点マーク';
    } else if (ev.type === 'trip_end') {
      const totalKm = (ev as any).extras?.totalKm;
      const lastLegKm = (ev as any).extras?.lastLegKm;
      if (totalKm != null && lastLegKm != null) {
        detail = `総距離 ${totalKm}km / 最終区間 ${lastLegKm}km`;
      }
    }

    out.push({
      id: ev.id,
      ts: ev.ts,
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
  if (!tripStart) {
    throw new Error('運行開始イベントが見つからないため共有できません');
  }
  const tripEnd = [...sorted].reverse().find(e => e.type === 'trip_end');
  const dayRuns = buildImportableDayRunsFromAppEvents(events, vm.dayRuns);
  return {
    recordType: 'operation_log',
    tripId,
    generatedAt: new Date().toISOString(),
    dayRuns,
    summary: {
      hasTripEnd: vm.hasTripEnd,
      startTs: tripStart.ts,
      endTs: tripEnd?.ts ?? null,
      ...(tripStart.address ? { startAddress: tripStart.address } : {}),
      ...(tripEnd?.address ? { endAddress: tripEnd.address } : {}),
      odoStart: vm.odoStart,
      odoEnd: vm.odoEnd ?? null,
      totalKm: vm.totalKm ?? null,
      lastLegKm: vm.lastLegKm ?? null,
    },
    segments: vm.segments.map(seg => ({
      index: seg.index,
      ...(seg.toTs ? { toTs: seg.toTs } : {}),
      toOdo: seg.toOdo,
      ...(seg.restSessionIdTo ? { restSessionIdTo: seg.restSessionIdTo } : {}),
    })),
    timeline: vm.timeline,
  };
}

function buildAiShareText(payload: AiSharePayload) {
  return [
    '運行履歴データ:',
    JSON.stringify(payload),
  ].join('\n');
}

function buildObsidianRestoreJson(payload: AiSharePayload) {
  return JSON.stringify(payload, null, 2);
}

function buildObsidianNoteTitle(payload: AiSharePayload) {
  const startInfo = getJstDateInfo(payload.summary.startTs);
  return `TrackLog運行記録 ${startInfo.dateKey} ${payload.tripId.slice(0, 8)}`;
}

function buildObsidianNotePath(title: string) {
  const safeName = title
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${OBSIDIAN_NOTE_DIR}/${safeName || 'TrackLog運行記録'}.md`;
}

function getObsidianBusinessMinutes(metrics: ReturnType<typeof computeDayMetrics>) {
  return metrics.workMinutes + metrics.loadMinutes + metrics.unloadMinutes + metrics.waitMinutes;
}

const OBSIDIAN_ACTIVITY_TITLES = new Set([
  '運行開始',
  '運行終了',
  '積込',
  '荷卸',
  '休憩',
  '休息',
  'フェリー',
  '給油',
  '地点マーク',
]);

function compactLocationLabel(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function getItemLocationLabels(item: GroupedItem): string[] {
  const values = [
    ...(item.addresses ?? []),
    ...((item.places ?? []).map(place => place.address).filter((address): address is string => !!address)),
  ]
    .map(compactLocationLabel)
    .filter(Boolean);
  const unique = Array.from(new Set(values));
  if (unique.length > 0) return unique;
  const coordinate = item.places?.find(place => Number.isFinite(place.lat) && Number.isFinite(place.lng));
  if (!coordinate || coordinate.lat == null || coordinate.lng == null) return [];
  return [`(${coordinate.lat.toFixed(5)}, ${coordinate.lng.toFixed(5)})`];
}

function summarizeLocationLabels(labels: string[], limit = 4) {
  if (labels.length === 0) return '-';
  if (labels.length <= limit) return labels.join(' / ');
  return `${labels.slice(0, limit).join(' / ')} / ほか${labels.length - limit}箇所`;
}

function summarizeLocationsByTitle(items: GroupedItem[], title: string) {
  const locations = items
    .filter(item => item.title === title)
    .flatMap(item => getItemLocationLabels(item));
  return summarizeLocationLabels(Array.from(new Set(locations)));
}

function formatGroupedRange(item: GroupedItem) {
  if (!item.range) return '';
  return item.range.replace(/\s*→\s*-\s*$/, '');
}

function buildObsidianActivityLine(item: GroupedItem) {
  const segments: string[] = [];
  const range = formatGroupedRange(item);
  if (range) segments.push(range);
  if (item.duration && item.duration !== '0分') segments.push(item.duration);
  const locations = getItemLocationLabels(item);
  if (locations.length > 0) {
    segments.push(`場所: ${summarizeLocationLabels(locations, 2)}`);
  }
  if (item.detail) segments.push(item.detail);
  return `- ${item.title}: ${segments.join(' / ') || '-'}`;
}

function buildObsidianMarkdown(tripId: string, vm: TripViewModel, payload: AiSharePayload, events: AppEvent[]) {
  const reportTrip = parseJsonToTrip(JSON.stringify(payload), tripId);
  const metricsList = computeTripDayMetrics(reportTrip);
  const restoreJson = buildObsidianRestoreJson(payload);
  const grouped = buildGrouped(events);
  const tripStartTs = events.find(event => event.type === 'trip_start')?.ts ?? events[0]?.ts;
  const groupedByDay = tripStartTs ? groupItemsByDay(grouped, tripStartTs) : [];
  const startAddress = payload.summary.startAddress ?? summarizeLocationsByTitle(grouped, '運行開始');
  const endAddress = payload.summary.endAddress ?? summarizeLocationsByTitle(grouped, '運行終了');
  const routeSummaryLines = [
    `- 出発地: ${startAddress || '-'}`,
    `- 到着地: ${payload.summary.endTs ? (endAddress || '-') : '進行中'}`,
    `- 積込地: ${summarizeLocationsByTitle(grouped, '積込')}`,
    `- 荷卸地: ${summarizeLocationsByTitle(grouped, '荷卸')}`,
    `- 休憩地: ${summarizeLocationsByTitle(grouped, '休憩')}`,
    `- 休息地: ${summarizeLocationsByTitle(grouped, '休息')}`,
    `- フェリー: ${summarizeLocationsByTitle(grouped, 'フェリー')}`,
  ];
  const dailySections = reportTrip.days.map((day, index) => {
    const metrics = metricsList[index] ?? computeDayMetrics(day);
    const businessMinutes = getObsidianBusinessMinutes(metrics);
    const totalMinutes = metrics.driveMinutes
      + businessMinutes
      + metrics.breakMinutes
      + metrics.ferryMinutes
      + metrics.restMinutes;
    const dayActivities = groupedByDay
      .find(group => group.dayIndex === day.dayIndex)
      ?.items.filter(item => OBSIDIAN_ACTIVITY_TITLES.has(item.title)) ?? [];

    return [
      `### ${day.dayIndex}日目 ${day.dateKey}`,
      `- 距離: ${day.km} km`,
      `- 運転: ${formatMinutesShort(metrics.driveMinutes)}`,
      `- 業務: ${formatMinutesShort(businessMinutes)}`,
      `- 休憩: ${formatMinutesShort(metrics.breakMinutes)}`,
      ...(metrics.ferryMinutes > 0 ? [`- フェリー: ${formatMinutesShort(metrics.ferryMinutes)}`] : []),
      `- 休息: ${formatMinutesShort(metrics.restMinutes)}`,
      `- 合計: ${formatMinutesShort(totalMinutes)}`,
      `- ルール: ${metrics.ruleModeLabel}`,
      ...(metrics.ruleModeReason ? [`- 判定理由: ${metrics.ruleModeReason}`] : []),
      ...(metrics.earliestRestart ? [`- 再開目安: ${formatRoundedJstTime(metrics.earliestRestart)}`] : []),
      ...(metrics.alerts.length > 0
        ? [`- 警告: ${metrics.alerts.map(alert => alert.message).join(' / ')}`]
        : []),
      ...(dayActivities.length > 0
        ? [
            '',
            '#### 主な地点',
            ...dayActivities.map(buildObsidianActivityLine),
          ]
        : []),
      '',
    ].join('\n');
  });

  return [
    '---',
    'tags: [tracklog, 運行記録]',
    `tripId: ${tripId}`,
    `generatedAt: ${payload.generatedAt}`,
    'source: TrackLog運行アシスト',
    '---',
    '',
    `# ${buildObsidianNoteTitle(payload)}`,
    '',
    '## サマリー',
    `- 作成: ${fmtLocal(payload.generatedAt)}`,
    `- 開始: ${fmtLocal(payload.summary.startTs)}`,
    `- 終了: ${payload.summary.endTs ? fmtLocal(payload.summary.endTs) : '進行中'}`,
    `- 日数: ${reportTrip.days.length}日`,
    `- 総距離: ${vm.totalKm != null ? `${vm.totalKm} km` : '-'}`,
    `- 最終区間: ${vm.lastLegKm != null ? `${vm.lastLegKm} km` : '-'}`,
    `- 保存先: ${OBSIDIAN_VAULT_NAME}/${buildObsidianNotePath(buildObsidianNoteTitle(payload))}`,
    '',
    '## 運行内容',
    ...routeSummaryLines,
    '',
    '## 日報',
    ...dailySections,
    '## 復元用JSON',
    '`運行日報 > 現行運行へ復元する` に、そのまま貼り付けできます。',
    '```json',
    restoreJson,
    '```',
  ].join('\n');
}

function buildObsidianMinimalMarkdown(payload: AiSharePayload, vm: TripViewModel) {
  return [
    `# ${buildObsidianNoteTitle(payload)}`,
    '',
    `- 作成: ${fmtLocal(payload.generatedAt)}`,
    `- 開始: ${fmtLocal(payload.summary.startTs)}`,
    `- 終了: ${payload.summary.endTs ? fmtLocal(payload.summary.endTs) : '進行中'}`,
    `- 日数: ${payload.dayRuns.length}日`,
    `- 総距離: ${vm.totalKm != null ? `${vm.totalKm} km` : '-'}`,
    `- tripId: ${payload.tripId}`,
  ].join('\n');
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'unknown error';
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Android WebView can deny clipboard writes even when the API exists.
      // Fall back to a hidden textarea copy before surfacing an error.
    }
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
  const [typeEditing, setTypeEditing] = useState<{ id: string; value: EventType } | null>(null);
  const [addressEditing, setAddressEditing] = useState<{ id: string; value: string } | null>(null);
  const [numberEditing, setNumberEditing] = useState<{ id: string; field: NumericEditField; value: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [obsidianSending, setObsidianSending] = useState(false);
  const [reportOpening, setReportOpening] = useState(false);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [openEditorId, setOpenEditorId] = useState<string | null>(null);

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
    const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
    const idx = sorted.findIndex(e => e.id === editing.id);
    const prev = idx > 0 ? sorted[idx - 1] : null;
    const next = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null;
    if (prev && iso <= prev.ts) {
      const ok = window.confirm(
        `この時刻は直前のイベント（${label(prev)} ${fmtLocal(prev.ts)}）より前です。順序が崩れますが保存しますか？`,
      );
      if (!ok) return;
    }
    if (next && iso >= next.ts) {
      const ok = window.confirm(
        `この時刻は次のイベント（${label(next)} ${fmtLocal(next.ts)}）より後です。順序が崩れますが保存しますか？`,
      );
      if (!ok) return;
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

  async function handleSaveType() {
    if (!typeEditing) return;
    setSaving(true);
    setWorkingId(typeEditing.id);
    try {
      await updateEventType(typeEditing.id, typeEditing.value);
      setTypeEditing(null);
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

  async function handleSaveNumber() {
    if (!numberEditing) return;
    const raw = numberEditing.value.trim();
    if (!raw) {
      alert('数値を入力してください');
      return;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      alert('数値の形式が不正です');
      return;
    }
    if (numberEditing.field === 'odoKm' && parsed <= 0) {
      alert('ODOが不正です');
      return;
    }
    if (numberEditing.field === 'liters' && parsed <= 0) {
      alert('給油量が不正です');
      return;
    }
    setSaving(true);
    setWorkingId(numberEditing.id);
    try {
      if (numberEditing.field === 'odoKm') {
        await updateEventOdo(numberEditing.id, parsed);
      } else {
        await updateEventLiters(numberEditing.id, parsed);
      }
      setNumberEditing(null);
      await load();
    } catch (e: any) {
      setErr(e?.message ?? '更新に失敗しました');
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
            await navigator.share({ title: '運行記録', text });
            return;
          } catch (e: any) {
            if (e?.name === 'AbortError') return;
          }
        }
      if (Capacitor.isNativePlatform()) {
        try {
          const opened = await shareText({ title: '運行記録', subject: '運行記録', text });
          if (opened) return;
        } catch {
          // Fall back to clipboard copy below.
        }
      }
      await copyText(text);
      alert('AI要約用テキストをコピーしました。ChatGPT/Geminiに貼り付けてください。');
    } catch (e: any) {
      setErr('AI要約テキストを共有またはコピーできませんでした。共有先アプリを選ぶか、再度お試しください。');
    } finally {
      setSharing(false);
    }
  }

  async function handleSendToObsidian() {
    if (!tripId || !vm) return;
    setObsidianSending(true);
    setErr(null);
    try {
      const payload = buildAiPayload(tripId, vm, events);
      const title = buildObsidianNoteTitle(payload);
      const markdown = buildObsidianMarkdown(tripId, vm, payload, events);
      const minimalMarkdown = buildObsidianMinimalMarkdown(payload, vm);
      const notePath = buildObsidianNotePath(title);
      const failureReasons: string[] = [];

      for (const candidate of [
        { content: markdown, mode: 'full' },
        { content: minimalMarkdown, mode: 'minimal' },
      ] as const) {
        try {
          const saved = await saveMarkdownToObsidian({
            vault: OBSIDIAN_VAULT_NAME,
            file: notePath,
            content: candidate.content,
            overwrite: true,
            silent: true,
          });
          if (saved) {
            const opened = await openNoteInObsidian({
              vault: OBSIDIAN_VAULT_NAME,
              file: notePath,
            });
            if (!opened) {
              alert(`Obsidian に保存しました: ${notePath}`);
            }
            if (candidate.mode === 'minimal') {
              setErr('Obsidian では簡易版を表示しています。詳細版は今後さらに詰めます。');
            }
            return;
          }
          failureReasons.push(`保存(${candidate.mode}) が opened=false`);
        } catch (error) {
          failureReasons.push(`保存(${candidate.mode}): ${getErrorMessage(error)}`);
        }
      }

      try {
        const opened = await shareTextToPackage({
          packageName: 'md.obsidian',
          title,
          subject: title,
          text: minimalMarkdown,
        });
        if (opened) {
          return;
        }
        failureReasons.push('共有(minimal) が opened=false');
      } catch (error) {
        failureReasons.push(`共有(minimal): ${getErrorMessage(error)}`);
      }

      if (navigator.share) {
        try {
          await navigator.share({ title, text: minimalMarkdown });
          return;
        } catch (e: any) {
          if (e?.name === 'AbortError') return;
          failureReasons.push(`navigator.share: ${getErrorMessage(e)}`);
        }
      }

      await copyText(minimalMarkdown);
      const failureSummary = failureReasons.length > 0 ? `\n\n失敗理由:\n- ${failureReasons.join('\n- ')}` : '';
      alert(`Obsidian 用の日報 Markdown をコピーしました。Obsidian に貼り付けて保存してください。${failureSummary}`);
    } catch (e: any) {
      setErr(e?.message ?? 'Obsidian 送信の準備に失敗しました');
    } finally {
      setObsidianSending(false);
    }
  }

  async function handleOpenReport() {
    if (!tripId || !vm) return;
    setReportOpening(true);
    setErr(null);
    try {
      const existingReport = await getReportTrip(tripId);
      const existingLabel = existingReport?.label || (vm.dayRuns[0]?.dateKey ? `${vm.dayRuns[0].dateKey} の運行` : '');
      const reportTrip = buildReportTripFromAppEvents({
        tripId,
        events,
        dayRuns: vm.dayRuns,
        label: existingLabel,
      });
        await saveReportTrip(reportTrip);
        navigate(`/report?tripId=${encodeURIComponent(tripId)}`, {
          state: { initialReportTrip: reportTrip },
        });
    } catch (e: any) {
      setErr(e?.message ?? '日報の作成に失敗しました');
    } finally {
      setReportOpening(false);
    }
  }

  if (!tripId) {
    return <div style={{ padding: 16 }}>tripId が不正です</div>;
  }
  const grouped = buildGrouped(events);
  const tripStartEvent = events.find(e => e.type === 'trip_start');
  const tripStartTs = tripStartEvent?.ts ?? events[0]?.ts;
  const groupedByDay = tripStartTs ? groupItemsByDay(grouped, tripStartTs) : [];
  const editingEvents = [...events].sort((a, b) => b.ts.localeCompare(a.ts));
  return (
    <div className="page-shell trip-detail">
      <div className="trip-detail__header">
        <div>
          <div className="trip-detail__title">運行詳細・編集</div>
          <div className="trip-detail__meta">運行ID: {tripId}</div>
        </div>
        <div className="trip-detail__actions">
          <Link to="/" className="trip-detail__button">ホーム</Link>
          <Link to="/history" className="trip-detail__button">運行履歴</Link>
          <Link to={`/trip/${tripId}/route`} className="trip-detail__button">ルート表示</Link>
          <button
            onClick={handleShareAi}
            disabled={sharing || !vm}
            className="trip-detail__button trip-detail__button--accent"
          >
            {sharing ? '作成中…' : 'AI要約'}
          </button>
          <button
            onClick={handleSendToObsidian}
            disabled={obsidianSending || !vm}
            className="trip-detail__button trip-detail__button--accent"
          >
            {obsidianSending ? '送信中…' : 'Obsidian送信'}
          </button>
          <button
            onClick={handleOpenReport}
            disabled={reportOpening || !vm}
            className="trip-detail__button trip-detail__button--accent"
          >
            {reportOpening ? '更新中…' : '日報を作成/更新'}
          </button>
          <button onClick={load} className="trip-detail__button">再読み込み</button>
        </div>
      </div>
      {err && (
        <div className="trip-detail__alert">{err}</div>
      )}
      {!vm && !err && <div>読み込み中…</div>}
      {vm && (
        <>
          <div className="trip-detail__toolbar">
            <button
              className="trip-detail__button trip-detail__button--danger"
              onClick={async () => {
                if (!tripId) return;
                const ok = window.confirm('この運行を削除します。よろしいですか？');
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
              {deleting ? '削除中…' : '運行を削除'}
            </button>
          </div>
          <div className="trip-detail__layout">
            <div className="trip-detail__column">
              <div className="card trip-section">
                <div className="trip-section__title">距離サマリー</div>
                <div className="trip-list">
                  <div className="trip-item trip-item--split">
                    <div className="trip-item__title">開始ODO</div>
                    <div className="trip-item__value">{vm.odoStart} km</div>
                  </div>
                  <div className="trip-item trip-item--split">
                    <div className="trip-item__title">終了ODO</div>
                    <div className="trip-item__value">{vm.odoEnd != null ? `${vm.odoEnd} km` : '-'}</div>
                  </div>
                  <div className="trip-item trip-item--split">
                    <div className="trip-item__title">総距離</div>
                    <div className="trip-item__value">{vm.totalKm != null ? `${vm.totalKm} km` : '-'}</div>
                  </div>
                  <div className="trip-item trip-item--split">
                    <div className="trip-item__title">最終区間</div>
                    <div className="trip-item__value">{vm.lastLegKm != null ? `${vm.lastLegKm} km` : '-'}</div>
                  </div>
                </div>
              </div>
              {!vm.validation.ok && (
                <div className="trip-detail__warning">
                  <div style={{ fontWeight: 900, marginBottom: 8 }}>整合性チェック</div>
                  <ul style={{ margin: 0, paddingLeft: 20 }}>
                    {vm.validation.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="card trip-section">
              <div className="trip-section__title">区間距離一覧</div>
              <div className="trip-section__note">休息開始ODOを区切りとして計算します。</div>
              <div className="trip-list">
                {vm.segments.map(seg => (
                    <div key={seg.index} className="trip-item trip-item--split">
                      <div>
                        <div className="trip-item__title">{seg.fromLabel} → {seg.toLabel}</div>
                        <div className="trip-item__meta">{fmtLocal(seg.fromTs)} → {fmtLocal(seg.toTs)}</div>
                      </div>
                      <div className={`trip-item__value${seg.valid ? '' : ' trip-item__value--bad'}`}>{seg.km} km</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="card trip-section">
                <div className="trip-section__title">日別運行</div>
                <div className="trip-section__note">日本時間24時で日付切替</div>
                <div className="trip-list">
                  {vm.dayRuns.map(day => (
                    <div key={day.dayIndex} className="trip-item trip-item--split">
                      <div>
                        <div className="trip-item__title">
                          {day.dayIndex}日目 {day.status === 'pending' ? '（運行中）' : ''}
                        </div>
                        <div className="trip-item__meta">{day.dateLabel}</div>
                        {day.closeOdo != null && (
                          <div className="trip-item__meta">{day.closeLabel ?? '休息開始'}: {day.closeOdo} km</div>
                        )}
                      </div>
                      <div className="trip-item__value">{day.km} km</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="trip-detail__column">
              <div className="card trip-section">
              <div className="trip-section__title">イベント一覧</div>
              <div className="trip-list">
                  {(groupedByDay.length > 0 ? groupedByDay : [{ dayIndex: 1, dateLabel: '', items: grouped }]).map(day => (
                    <div key={`${day.dayIndex}-${day.dateLabel}`} className="trip-day">
                      <div className="trip-day__title">
                        {day.dayIndex}日目 {day.dateLabel ? `(${day.dateLabel})` : ''}
                      </div>
                      <div className="trip-list">
                        {day.items.map(item => (
                          <div key={item.id} className="trip-item trip-event">
                            <div className="trip-event__header">
                              <div className="trip-event__title">{item.title}</div>
                              {item.range && <div className="trip-event__range">{item.range}</div>}
                            </div>
                            {item.duration && (
                              <div className="trip-event__detail">所要時間: {item.duration}</div>
                            )}
                            {item.detail && <div className="trip-event__detail">{item.detail}</div>}
                            {item.addresses && item.addresses.length > 0 && (
                              <div className="trip-event__address">
                                {item.addresses.map((a, i) => (
                                  <div key={i}>住所: {a}</div>
                                ))}
                              </div>
                            )}
                            {item.places && item.places.length > 0 && (
                              <div className="trip-event__actions">
                                {item.places.map((p, i) => {
                                  const hasCoord = p.lat != null && p.lng != null;
                                  const queryText = hasCoord ? `${p.lat},${p.lng}` : (p.address ?? '');
                                  const mapUrl = hasCoord
                                    ? `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=16/${p.lat}/${p.lng}`
                                    : `https://www.openstreetmap.org/search?query=${encodeURIComponent(queryText)}`;
                                  const navUrl = hasCoord
                                    ? `geo:${p.lat},${p.lng}?q=${encodeURIComponent(queryText)}`
                                    : `https://www.openstreetmap.org/search?query=${encodeURIComponent(queryText)}`;
                                  const label = p.label ? `${p.label}地点` : '地点';
                                  return (
                                    <div key={i} className="trip-event__action-pair">
                                      <a
                                        href={mapUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="trip-detail__button trip-detail__button--small"
                                      >
                                        {label}を地図で開く
                                      </a>
                                      <a
                                        href={navUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="trip-detail__button trip-detail__button--small"
                                      >
                                        ナビアプリで開く
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
                  ))}
                </div>
              </div>
              <div className="card trip-section">
              <div className="trip-section__title">イベント一覧（編集）</div>
              <div className="trip-section__note">
                新しい順で表示します。必要なイベントだけ開いて、時間・ODO・給油量・住所・項目を編集できます。
              </div>
              <div className="trip-list">
                  {editingEvents.map(ev => {
                    const numDef = getNumericEditDef(ev);
                    const isOpen = openEditorId === ev.id;
                    const timeEditing = editing?.id === ev.id;
                    const typeEditingActive = typeEditing?.id === ev.id;
                    const addressEditingActive = addressEditing?.id === ev.id;
                    const numberEditingActive =
                      !!numDef && numberEditing?.id === ev.id && numberEditing.field === numDef.field;
                    const canDelete = ev.type !== 'trip_start';
                    const canEditType = ev.type !== 'trip_start' && ev.type !== 'trip_end';
                    const typeOptions = EDITABLE_EVENT_TYPES.includes(ev.type)
                      ? EDITABLE_EVENT_TYPES
                      : [ev.type, ...EDITABLE_EVENT_TYPES];
                    return (
                      <div key={ev.id} className="trip-item trip-edit trip-edit--compact">
                        <div className="trip-edit__summary">
                          <div className="trip-edit__summary-main">
                            <div className="trip-item__title">{label(ev)}</div>
                            <div className="trip-item__meta">{fmtLocal(ev.ts)}</div>
                            {numDef && <div className="trip-item__meta">{numDef.label}: {numDef.value ?? '-'}</div>}
                            <div className="trip-item__meta trip-edit__address-preview">{ev.address ?? '住所未設定'}</div>
                          </div>
                          <div className="trip-edit__actions">
                            <div className="trip-edit__id">{ev.id.slice(0, 8)}</div>
                            <button
                              onClick={() => setOpenEditorId(current => (current === ev.id ? null : ev.id))}
                              className="trip-btn"
                              type="button"
                            >
                              {isOpen ? '閉じる' : '編集を開く'}
                            </button>
                            {canDelete && (
                              <button
                                onClick={() => handleDeleteEvent(ev.id)}
                                disabled={saving || workingId === ev.id}
                                className="trip-btn trip-btn--danger"
                              >
                                削除
                              </button>
                            )}
                          </div>
                        </div>
                        {isOpen && (
                          <div className="trip-edit__panel">
                            <div className="trip-edit__section">
                              <div className="trip-edit__label">項目</div>
                              {canEditType ? (
                                typeEditingActive ? (
                                  <div className="trip-edit__stack">
                                    <select
                                      value={typeEditing?.value ?? ev.type}
                                      onChange={e => setTypeEditing({ id: ev.id, value: e.target.value as EventType })}
                                      disabled={saving}
                                      className="trip-input"
                                    >
                                      {typeOptions.map(t => (
                                        <option key={t} value={t}>
                                          {label({ type: t } as AppEvent)}
                                        </option>
                                      ))}
                                    </select>
                                    <div className="trip-edit__inline-actions">
                                      <button onClick={handleSaveType} disabled={saving} className="trip-btn">保存</button>
                                      <button onClick={() => setTypeEditing(null)} disabled={saving} className="trip-btn trip-btn--ghost">取消</button>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="trip-edit__stack">
                                    <div>{label(ev)}</div>
                                    <div className="trip-edit__inline-actions">
                                      <button
                                        onClick={() => setTypeEditing({ id: ev.id, value: ev.type })}
                                        disabled={saving}
                                        className="trip-btn"
                                      >
                                        項目を編集
                                      </button>
                                    </div>
                                  </div>
                                )
                              ) : (
                                <div className="trip-edit__stack">
                                  <div>{label(ev)}</div>
                                  <div style={{ opacity: 0.7, fontSize: 12 }}>変更不可</div>
                                </div>
                              )}
                            </div>

                            <div className="trip-edit__section">
                              <div className="trip-edit__label">時間</div>
                              {timeEditing ? (
                                <div className="trip-edit__stack">
                                  <input
                                    type="datetime-local"
                                    value={editing.value}
                                    onChange={e => setEditing({ id: ev.id, value: e.target.value })}
                                    disabled={saving}
                                    className="trip-input"
                                  />
                                  <div className="trip-edit__inline-actions">
                                    <button onClick={handleSaveTime} disabled={saving} className="trip-btn">保存</button>
                                    <button onClick={() => setEditing(null)} disabled={saving} className="trip-btn trip-btn--ghost">取消</button>
                                  </div>
                                </div>
                              ) : (
                                <div className="trip-edit__stack">
                                  <div>{fmtLocal(ev.ts)}</div>
                                  <div className="trip-edit__inline-actions">
                                    <button
                                      onClick={() => setEditing({ id: ev.id, value: toLocalInputValue(ev.ts) })}
                                      disabled={saving}
                                      className="trip-btn"
                                    >
                                      時間を編集
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>

                            {numDef && (
                              <div className="trip-edit__section">
                                <div className="trip-edit__label">{numDef.label}</div>
                                {numberEditingActive ? (
                                  <div className="trip-edit__stack">
                                    <input
                                      type="number"
                                      value={numberEditing?.value ?? ''}
                                      min={numDef.min}
                                      step={numDef.step}
                                      onChange={e => setNumberEditing({ id: ev.id, field: numDef.field, value: e.target.value })}
                                      disabled={saving}
                                      className="trip-input"
                                    />
                                    <div className="trip-edit__inline-actions">
                                      <button onClick={handleSaveNumber} disabled={saving} className="trip-btn">保存</button>
                                      <button onClick={() => setNumberEditing(null)} disabled={saving} className="trip-btn trip-btn--ghost">取消</button>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="trip-edit__stack">
                                    <div>{numDef.value ?? '-'}</div>
                                    <div className="trip-edit__inline-actions">
                                      <button
                                        onClick={() =>
                                          setNumberEditing({
                                            id: ev.id,
                                            field: numDef.field,
                                            value: numDef.value != null ? String(numDef.value) : '',
                                          })
                                        }
                                        disabled={saving}
                                        className="trip-btn"
                                      >
                                        数値を編集
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}

                            <div className="trip-edit__section">
                              <div className="trip-edit__label">住所</div>
                              {addressEditingActive ? (
                                <div className="trip-edit__stack">
                                  <textarea
                                    value={addressEditing.value}
                                    onChange={e => setAddressEditing({ id: ev.id, value: e.target.value })}
                                    disabled={saving}
                                    className="trip-input trip-input--textarea"
                                    rows={3}
                                  />
                                  <div className="trip-edit__inline-actions">
                                    <button onClick={handleSaveAddress} disabled={saving} className="trip-btn">保存</button>
                                    <button onClick={() => setAddressEditing(null)} disabled={saving} className="trip-btn trip-btn--ghost">取消</button>
                                  </div>
                                </div>
                              ) : (
                                <div className="trip-edit__stack">
                                  <div className="trip-edit__address-preview">{ev.address ?? '住所未設定'}</div>
                                  <div className="trip-edit__inline-actions">
                                    <button
                                      onClick={() => setAddressEditing({ id: ev.id, value: ev.address ?? '' })}
                                      disabled={saving}
                                      className="trip-btn"
                                    >
                                      住所を編集
                                    </button>
                                    {ev.geo && (
                                      <button
                                        onClick={() => handleRefreshAddress(ev.id)}
                                        disabled={workingId === ev.id}
                                        className="trip-btn trip-btn--ghost"
                                      >
                                        住所を再取得
                                      </button>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
