import type {
  AppEvent,
  TripStartEvent,
  TripEndEvent,
  RestStartEvent,
  RestEndEvent,
  Segment,
  DayRun,
  TimelineItem,
} from '../domain/types';
import { computeSegments, computeDayRuns, computeTotals } from '../domain/metrics';

export type TripViewModel = {
  tripId: string;
  hasTripEnd: boolean;
  odoStart: number;
  odoEnd?: number;
  totalKm?: number;
  lastLegKm?: number;
  segments: Segment[];
  dayRuns: DayRun[];
  timeline: TimelineItem[];
  validation: { ok: boolean; errors: string[] };
};

/**
 * buildTripViewModel consolidates event data for a trip into a single
 * object suitable for rendering in the UI. It computes distances,
 * day boundaries, a chronological timeline and performs basic
 * validation checks.
 */
export function buildTripViewModel(tripId: string, events: AppEvent[]): TripViewModel {
  const sorted = events.filter(e => e.tripId === tripId).sort((a, b) => a.ts.localeCompare(b.ts));
  const tripStart = sorted.find(e => e.type === 'trip_start') as TripStartEvent | undefined;
  if (!tripStart) {
    return {
      tripId,
      hasTripEnd: false,
      odoStart: 0,
      segments: [],
      dayRuns: [],
      timeline: [],
      validation: { ok: false, errors: ['trip_start が存在しません'] },
    };
  }
  const tripEnd = [...sorted].reverse().find(e => e.type === 'trip_end') as TripEndEvent | undefined;
  const restStarts = sorted.filter(e => e.type === 'rest_start') as RestStartEvent[];
  const restEnds = sorted.filter(e => e.type === 'rest_end') as RestEndEvent[];
  const odoStart = tripStart.extras.odoKm;
  const odoEnd = tripEnd?.extras.odoKm;
  const errors: string[] = [];
  // Ensure each rest_end has matching rest_start
  const rsIds = new Set(restStarts.map(r => r.extras.restSessionId));
  for (const re of restEnds) {
    if (!rsIds.has(re.extras.restSessionId)) {
      errors.push(`rest_end の restSessionId が rest_start と対応しません: ${re.extras.restSessionId}`);
    }
  }
  // Segments
  const segments = computeSegments({
    odoStart,
    tripStartTs: tripStart.ts,
    restStarts,
    tripEnd: odoEnd != null ? { odoEnd, tripEndTs: tripEnd!.ts } : undefined,
  });
  segments.forEach(seg => {
    if (!seg.valid) {
      errors.push(`区間距離が負数です: ${seg.fromLabel} → ${seg.toLabel} (${seg.km}km)`);
    }
  });
  // Day runs
  const dayRuns = computeDayRuns({ odoStart, restStarts, restEnds, odoEnd });
  // Totals and last leg
  let totalKm: number | undefined;
  let lastLegKm: number | undefined;
  if (odoEnd != null) {
    const lastRestStartOdo = restStarts.length > 0 ? restStarts.sort((a, b) => a.ts.localeCompare(b.ts))[restStarts.length - 1].extras.odoKm : undefined;
    const totals = computeTotals({ odoStart, odoEnd, lastRestStartOdo });
    totalKm = totals.totalKm;
    lastLegKm = totals.lastLegKm;
    if (!totals.valid) errors.push('運行距離が負数です（オド入力の逆転を確認してください）');
    const segSum = segments.reduce((acc, s) => acc + (s.valid ? s.km : 0), 0);
    if (segSum !== totalKm) {
      errors.push(`検算不一致: 区間合計=${segSum}km / 総距離=${totalKm}km`);
    }
  }
  // Timeline
  const timeline = buildTimeline(sorted);
  return {
    tripId,
    hasTripEnd: odoEnd != null,
    odoStart,
    odoEnd,
    totalKm,
    lastLegKm,
    segments,
    dayRuns,
    timeline,
    validation: { ok: errors.length === 0, errors },
  };
}

/**
 * buildTimeline maps events into a human-friendly chronological description.
 */
export function buildTimeline(events: AppEvent[]): TimelineItem[] {
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  const fmtRange = (s: string, e?: string) => {
    const fmt = (ts: string) =>
      new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
    return e ? `${fmt(s)} → ${fmt(e)}` : `${fmt(s)} → -`;
  };
  const fmtDuration = (s: string, e?: string) => {
    if (!e) return '';
    const diff = Math.max(0, new Date(e).getTime() - new Date(s).getTime());
    const mins = Math.floor(diff / 60000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}時間${m}分` : `${m}分`;
  };
  const formatGeo = (e: AppEvent) => {
    if (e.address) return e.address as string;
    if (e.geo) {
      const { lat, lng } = e.geo as any;
      return `(${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)})`;
    }
    return undefined;
  };
  const label = (e: AppEvent) => {
    switch (e.type) {
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
      case 'boarding':
        return '乗船';
      default:
        return e.type;
    }
  };

  const toggleDefs = [
    { start: 'rest_start', end: 'rest_end', key: 'restSessionId', label: '休息' },
    { start: 'break_start', end: 'break_end', key: 'breakSessionId', label: '休憩' },
    { start: 'load_start', end: 'load_end', key: 'loadSessionId', label: '積込' },
  ];
  const toggleMap = new Map<string, { start: AppEvent; def: any }>();
  const timeline: TimelineItem[] = [];

  for (const e of sorted) {
    const def = toggleDefs.find(d => d.start === e.type || d.end === e.type);
    if (def) {
      const key = (e as any).extras?.[def.key];
      if (def.start === e.type && key) {
        toggleMap.set(`${def.key}-${key}`, { start: e, def });
        continue;
      }
      if (def.end === e.type && key) {
        const entry = toggleMap.get(`${def.key}-${key}`);
        if (entry) {
          const start = entry.start;
          const loc = formatGeo(start) || formatGeo(e);
          const detail = `${fmtRange(start.ts, e.ts)}（${fmtDuration(start.ts, e.ts)}）${loc ? ' / ' + loc : ''}`;
          timeline.push({ ts: start.ts, title: def.label, detail });
          toggleMap.delete(`${def.key}-${key}`);
          continue;
        }
      }
    }

    let detail: string | undefined;
    if (e.type === 'refuel') {
      const liters = (e as any).extras?.liters;
      detail = liters != null ? `${liters} L` : undefined;
    }
    if (e.type === 'expressway') {
      const st = (e as any).extras?.icResolveStatus;
      const name = (e as any).extras?.icName;
      detail =
        st === 'resolved' ? `${name ?? 'IC'}（取得済）` : st === 'failed' ? 'IC取得失敗' : 'IC検索中';
    }
    if (e.type === 'trip_end') {
      const totalKm = (e as any).extras?.totalKm;
      const lastLegKm = (e as any).extras?.lastLegKm;
      if (totalKm != null && lastLegKm != null) {
        detail = `総距離 ${totalKm}km / 最終区間 ${lastLegKm}km`;
      }
    }
    if (e.type === 'rest_end') {
      const dc = (e as any).extras?.dayClose;
      const di = (e as any).extras?.dayIndex;
      detail = dc ? `${di ?? ''}日目を締める` : '分割休息';
    }
    const loc = formatGeo(e);
    const mergedDetail = detail ? (loc ? `${detail} / ${loc}` : detail) : loc;
    timeline.push({ ts: e.ts, title: label(e), detail: mergedDetail });
  }

  for (const { start, def } of toggleMap.values()) {
    const loc = formatGeo(start);
    const detail = `${fmtRange(start.ts, undefined)}（進行中）${loc ? ' / ' + loc : ''}`;
    timeline.push({ ts: start.ts, title: def.label, detail });
  }

  timeline.sort((a, b) => a.ts.localeCompare(b.ts));
  return timeline;
}
