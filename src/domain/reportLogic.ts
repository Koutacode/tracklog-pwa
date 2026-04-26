import type {
  TripEvent,
  TripEventType,
  DayRecord,
  DayMetrics,
  LoadDetail,
  TimeSegmentDetail,
  ReportAlert,
  Trip,
  JobInfo,
  MonthSummary,
  ComplianceRuleMode,
} from './reportTypes';
import type { AppEvent, DayRun as SourceDayRun } from './types';
import { parseJsonInput } from './jsonInput';

// --- Regulation constants (令和6年4月改正) ---
const CONSTRAINT_WARNING_MIN = 13 * 60;         // 原則拘束 13h
const GENERAL_CONSTRAINT_MAX_MIN = 15 * 60;     // 一般最大拘束 15h
const SPECIAL_CONSTRAINT_MAX_MIN = 16 * 60;     // 特例最大拘束 16h
const GENERAL_REST_MIN_MIN = 9 * 60;            // 一般最短休息 9h
const SPECIAL_REST_MIN_MIN = 8 * 60;            // 特例最短休息 8h
const TARGET_REST_MIN = 11 * 60;                // 確保に努める休息 11h
const TWO_DAY_DRIVE_LIMIT_MIN = 18 * 60;        // 2日平均1日9h -> 48hで18h
const TWO_WEEK_DRIVE_LIMIT_MIN = 88 * 60;       // 2週平均1週44h -> 14日で88h
const CONTINUOUS_DRIVE_LIMIT_MIN = 4 * 60;      // 連続運転 4h
const CONTINUOUS_DRIVE_EMERGENCY_LIMIT_MIN = 4 * 60 + 30; // やむを得ない場合 4h30m
const LONG_DISTANCE_THRESHOLD_KM = 450;
const DAY_TOTAL_MIN = 24 * 60;
const QUARTER_MIN = 15;

// --- UTC→JST offset ---
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function toJstDate(utcIso: string): Date {
  return new Date(new Date(utcIso).getTime() + JST_OFFSET_MS);
}

function jstDateKey(utcIso: string): string {
  const d = toJstDate(utcIso);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function minuteOfDayJst(utcIso: string): number {
  const d = toJstDate(utcIso);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function diffMinutes(startUtc: string, endUtc: string): number {
  return Math.max(0, Math.round((new Date(endUtc).getTime() - new Date(startUtc).getTime()) / 60000));
}

function formatJstTime(utcIso: string): string {
  const d = toJstDate(utcIso);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function formatRoundedJstTime(utcIso: string): string {
  const rounded = roundToQuarterMinutes(minuteOfDayExactJst(jstDateKey(utcIso), utcIso));
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
  if (hours >= 24) return '24:00';
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function jstDayStartMs(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00+09:00`).getTime();
}

function minuteOfDayExactJst(dateKey: string, utcIso: string): number {
  const raw = (new Date(utcIso).getTime() - jstDayStartMs(dateKey)) / 60000;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(DAY_TOTAL_MIN, Math.max(0, raw));
}

function roundToQuarterMinutes(minutes: number): number {
  const rounded = Math.round(minutes / QUARTER_MIN) * QUARTER_MIN;
  return Math.min(DAY_TOTAL_MIN, Math.max(0, rounded));
}

function utcFromJstMinute(dateKey: string, minute: number, clamp = true): string {
  const normalized = clamp
    ? Math.min(DAY_TOTAL_MIN, Math.max(0, minute))
    : Math.max(0, minute);
  return new Date(jstDayStartMs(dateKey) + normalized * 60000).toISOString();
}

// --- JSON parsing ---
type RawEvent = {
  type: string;
  ts: string;
  address?: string;
  customer?: string;
  volume?: number;
  memo?: string;
  odoKm?: number;
};

type RawDayRun = {
  dateKey: string;
  events: RawEvent[];
  km?: number;
  odoStart?: number;
  odoEnd?: number;
};

export type ImportableReportDayRun = RawDayRun;

type RawJson = {
  events?: RawEvent[];
  dayRuns?: RawDayRun[];
  jobs?: Array<{
    id?: string;
    customer?: string;
    volume?: number;
    loadAt?: string;
    loadTime?: string;
    dropAt?: string;
    dropDate?: string;
    isBranchDrop?: boolean;
    completed?: boolean;
  }>;
  label?: string;
  recordType?: string;
  summary?: {
    startTs?: string;
    startAddress?: string;
    odoStart?: number;
  };
  segments?: Array<{
    index?: number;
    toTs?: string;
    toOdo?: number;
    restSessionIdTo?: string;
  }>;
  timeline?: Array<{
    ts?: string;
    title?: string;
    detail?: string;
  }>;
};

const VALID_EVENT_TYPES: Set<string> = new Set([
  'trip_start', 'trip_end',
  'load_start', 'load_end',
  'unload_start', 'unload_end',
  'break_start', 'break_end',
  'rest_start', 'rest_end',
  'boarding', 'disembark',
  'wait_start', 'wait_end',
  'drive_start', 'drive_end',
  'work_start', 'work_end',
]);

function mapEvent(raw: RawEvent): TripEvent | null {
  if (!VALID_EVENT_TYPES.has(raw.type)) return null;
  if (!raw.ts) return null;
  return {
    type: raw.type as TripEventType,
    ts: raw.ts,
    address: raw.address,
    customer: raw.customer,
    volume: raw.volume,
    memo: raw.memo,
  };
}

function hasImportableDayRuns(rawDayRuns?: RawDayRun[]): rawDayRuns is RawDayRun[] {
  return Array.isArray(rawDayRuns)
    && rawDayRuns.length > 0
    && rawDayRuns.every(dr => !!dr && typeof dr.dateKey === 'string' && Array.isArray(dr.events));
}

function looksLikeOperationLog(raw: RawJson): boolean {
  return raw.recordType === 'operation_log'
    || (
      Array.isArray(raw.timeline)
      && raw.timeline.length > 0
      && !!raw.summary
      && (!Array.isArray(raw.events) || raw.events.length === 0)
      && !hasImportableDayRuns(raw.dayRuns)
    );
}

function parseDetailDurationMinutes(detail?: string): number | null {
  if (!detail) return null;
  const m = detail.match(/（(?:(\d+)時間)?(\d+)分）/);
  if (!m) return null;
  const hours = Number(m[1] ?? 0);
  const minutes = Number(m[2] ?? 0);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function deriveEndTsFromDetail(startTs: string, detail?: string): string | null {
  const minutes = parseDetailDurationMinutes(detail);
  if (minutes == null) return null;
  return new Date(new Date(startTs).getTime() + minutes * 60000).toISOString();
}

function extractAddressFromDetail(detail?: string): string | undefined {
  if (!detail) return undefined;
  const parts = detail.split(' / ').map(part => part.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  const last = parts[parts.length - 1];
  if (!last || last.includes('→') || /IC[:：]/.test(last)) {
    return undefined;
  }
  return last;
}

function buildEventsFromOperationLog(raw: RawJson): RawEvent[] {
  const summary = raw.summary;
  const startTs = typeof summary?.startTs === 'string' ? summary.startTs.trim() : '';
  if (!startTs || !Number.isFinite(Date.parse(startTs))) return [];
  const startAddress = typeof summary?.startAddress === 'string' ? summary.startAddress.trim() : undefined;
  const startOdo = typeof summary?.odoStart === 'number' && Number.isFinite(summary.odoStart)
    ? summary.odoStart
    : undefined;

  const timeline = Array.isArray(raw.timeline)
    ? raw.timeline
        .filter((item): item is NonNullable<RawJson['timeline']>[number] => !!item && typeof item.ts === 'string' && typeof item.title === 'string')
        .filter(item => !!item.ts && !!item.title && Number.isFinite(Date.parse(item.ts)))
        .sort((a, b) => a.ts!.localeCompare(b.ts!))
    : [];
  if (timeline.length === 0) return [];

  const segments = Array.isArray(raw.segments) ? raw.segments : [];
  const events: RawEvent[] = [
    {
      type: 'trip_start',
      ts: startTs,
      address: startAddress,
      odoKm: startOdo,
    },
  ];

  let restIndex = 0;
  for (const item of timeline) {
    const title = item.title!.trim();
    const ts = item.ts!.trim();
    const detail = typeof item.detail === 'string' ? item.detail.trim() : undefined;
    if (!title || title === '運行開始') continue;

    const address = extractAddressFromDetail(detail);
    if (title === '休息') {
      const segment = segments[restIndex];
      events.push({
        type: 'rest_start',
        ts,
        address,
        odoKm: Number.isFinite(segment?.toOdo) ? segment.toOdo : undefined,
      });
      if (!detail?.includes('進行中')) {
        const endTs = deriveEndTsFromDetail(ts, detail);
        if (endTs) {
          events.push({
            type: 'rest_end',
            ts: endTs,
            address,
          });
        }
      }
      restIndex += 1;
      continue;
    }

    const endTs = deriveEndTsFromDetail(ts, detail);
    switch (title) {
      case '積込':
      case '積込み':
        events.push({ type: 'load_start', ts, address });
        if (endTs) events.push({ type: 'load_end', ts: endTs, address });
        break;
      case '荷卸':
      case '積下ろし':
      case '積み下ろし':
      case '積み卸し':
        events.push({ type: 'unload_start', ts, address });
        if (endTs) events.push({ type: 'unload_end', ts: endTs, address });
        break;
      case '休憩':
        events.push({ type: 'break_start', ts, address });
        if (endTs) events.push({ type: 'break_end', ts: endTs, address });
        break;
      case 'フェリー':
      case '乗船':
      case 'フェリー乗船':
        events.push({ type: 'boarding', ts, address });
        if (endTs) events.push({ type: 'disembark', ts: endTs, address });
        break;
      case '下船':
      case 'フェリー下船':
        events.push({ type: 'disembark', ts, address });
        break;
      case '運行終了':
        events.push({ type: 'trip_end', ts, address });
        break;
      default:
        break;
    }
  }

  return events.sort((a, b) => a.ts.localeCompare(b.ts));
}

function buildOperationLogDayKmMap(raw: RawJson): Map<string, number> {
  const result = new Map<string, number>();
  const startOdo = Number(raw.summary?.odoStart);
  if (!Number.isFinite(startOdo)) {
    return result;
  }

  const checkpointsFromTimeline = (Array.isArray(raw.timeline) ? raw.timeline : [])
    .filter((item): item is NonNullable<RawJson['timeline']>[number] => !!item && typeof item.ts === 'string' && typeof item.title === 'string')
    .filter(item => Number.isFinite(Date.parse(item.ts!)) && (item.title === '休息' || item.title === '運行終了'))
    .sort((a, b) => a.ts!.localeCompare(b.ts!));

  const segments = (Array.isArray(raw.segments) ? raw.segments : [])
    .filter(segment => !!segment)
    .sort((a, b) => Number(a?.index ?? 0) - Number(b?.index ?? 0));

  let previousOdo = startOdo;
  let timelineIndex = 0;

  for (const segment of segments) {
    const toOdo = Number(segment?.toOdo);
    if (!Number.isFinite(toOdo)) continue;

    const explicitTs =
      typeof segment?.toTs === 'string' && Number.isFinite(Date.parse(segment.toTs))
        ? segment.toTs
        : undefined;
    const fallbackTs = checkpointsFromTimeline[timelineIndex]?.ts;
    const toTs = explicitTs ?? fallbackTs;
    if (!toTs || !Number.isFinite(Date.parse(toTs))) continue;

    const km = toOdo - previousOdo;
    const dateKey = jstDateKey(toTs);
    result.set(dateKey, (result.get(dateKey) ?? 0) + km);
    previousOdo = toOdo;
    if (!explicitTs) {
      timelineIndex += 1;
    }
  }

  return result;
}

function mapAppEventToRawEvent(event: AppEvent): RawEvent {
  const odoKm = Number((event as any).extras?.odoKm);
  const customer = typeof (event as any).customer === 'string' ? (event as any).customer : undefined;
  const memo = typeof (event as any).memo === 'string' ? (event as any).memo : undefined;
  const volume = Number((event as any).volume);
  return {
    type: event.type,
    ts: event.ts,
    address: event.address,
    customer,
    volume: Number.isFinite(volume) ? volume : undefined,
    memo,
    odoKm: Number.isFinite(odoKm) ? odoKm : undefined,
  };
}

export function buildImportableDayRunsFromAppEvents(
  events: AppEvent[],
  dayRuns: ReadonlyArray<Pick<SourceDayRun, 'dateKey' | 'km'>>,
): ImportableReportDayRun[] {
  const groupedEvents = new Map<string, RawEvent[]>();
  for (const event of [...events].sort((a, b) => a.ts.localeCompare(b.ts))) {
    const dateKey = jstDateKey(event.ts);
    const entry = groupedEvents.get(dateKey) ?? [];
    entry.push(mapAppEventToRawEvent(event));
    groupedEvents.set(dateKey, entry);
  }

  const kmByDate = new Map<string, number>();
  for (const day of dayRuns) {
    kmByDate.set(day.dateKey, day.km);
  }

  const dateKeys = Array.from(new Set([
    ...groupedEvents.keys(),
    ...dayRuns.map(day => day.dateKey),
  ])).sort();

  return dateKeys.map(dateKey => {
    const dayEvents = groupedEvents.get(dateKey) ?? [];
    const odoValues = dayEvents
      .map(event => Number(event.odoKm))
      .filter((value): value is number => Number.isFinite(value));
    const odoStart = odoValues.length > 0 ? Math.min(...odoValues) : undefined;
    const odoEnd = odoValues.length > 0 ? Math.max(...odoValues) : undefined;
    const km = kmByDate.get(dateKey);
    return {
      dateKey,
      events: dayEvents,
      ...(Number.isFinite(km) ? { km } : {}),
      ...(Number.isFinite(odoStart) ? { odoStart } : {}),
      ...(Number.isFinite(odoEnd) ? { odoEnd } : {}),
    };
  });
}

export function buildReportTripFromAppEvents(params: {
  tripId: string;
  events: AppEvent[];
  dayRuns: ReadonlyArray<Pick<SourceDayRun, 'dateKey' | 'km'>>;
  label?: string;
}): Trip {
  const raw = {
    recordType: 'app_trip_snapshot',
    sourceTripId: params.tripId,
    ...(params.label ? { label: params.label } : {}),
    dayRuns: buildImportableDayRunsFromAppEvents(params.events, params.dayRuns),
  };
  return parseJsonToTrip(JSON.stringify(raw), params.tripId);
}

export function parseJsonToTrip(jsonStr: string, tripId: string): Trip {
  const raw = parseJsonInput<RawJson>(jsonStr, 'JSON の解析に失敗しました');
  const jobs: JobInfo[] = (raw.jobs ?? []).map((j, i) => ({
    id: j.id ?? `job-${i}`,
    customer: j.customer ?? '',
    volume: j.volume ?? 0,
    loadAt: j.loadAt ?? '',
    loadTime: j.loadTime ?? '',
    dropAt: j.dropAt ?? '',
    dropDate: j.dropDate ?? '',
    isBranchDrop: j.isBranchDrop ?? false,
    completed: j.completed ?? false,
  }));

  let days: DayRecord[];

  if (hasImportableDayRuns(raw.dayRuns)) {
    days = raw.dayRuns.map((dr, idx) => {
      const events = dr.events.map(mapEvent).filter((e): e is TripEvent => e !== null);
      const tripStart = events.find(e => e.type === 'trip_start');
      const restStart = events.find(e => e.type === 'rest_start');
      const fallbackKm =
        Number.isFinite(dr.odoStart) && Number.isFinite(dr.odoEnd)
          ? (dr.odoEnd ?? 0) - (dr.odoStart ?? 0)
          : 0;
      return {
        dayIndex: idx + 1,
        dateKey: dr.dateKey,
        events,
        km: Number.isFinite(dr.km) ? dr.km ?? 0 : fallbackKm,
        odoStart: dr.odoStart ?? 0,
        odoEnd: dr.odoEnd ?? 0,
        isFirstDay: idx === 0,
        tripStartMin: tripStart ? minuteOfDayJst(tripStart.ts) : null,
        restStartMin: restStart ? minuteOfDayJst(restStart.ts) : null,
        restPlace: restStart?.address ?? '',
      };
    });
  } else if (raw.events && raw.events.length > 0) {
    days = splitEventsByDay(raw.events);
  } else if (looksLikeOperationLog(raw)) {
    const operationLogDayKm = buildOperationLogDayKmMap(raw);
    days = splitEventsByDay(buildEventsFromOperationLog(raw)).map(day => ({
      ...day,
      km: operationLogDayKm.get(day.dateKey) ?? day.km,
    }));
  } else {
    days = [];
  }

  if (days.length === 0) {
    throw new Error('日報に変換できる `events` / `dayRuns` / `operation_log` がありません');
  }

  return {
    id: tripId,
    createdAt: new Date().toISOString(),
    label: raw.label ?? '',
    days,
    jobs,
    rawJson: jsonStr,
  };
}

function splitEventsByDay(rawEvents: RawEvent[]): DayRecord[] {
  const validEvents = rawEvents.map(mapEvent).filter((e): e is TripEvent => e !== null);
  if (validEvents.length === 0) return [];

  const sorted = [...validEvents].sort((a, b) => a.ts.localeCompare(b.ts));
  const groups = new Map<string, TripEvent[]>();

  for (const ev of sorted) {
    const key = jstDateKey(ev.ts);
    const arr = groups.get(key) ?? [];
    arr.push(ev);
    groups.set(key, arr);
  }

  const dateKeys = [...groups.keys()].sort();
  return dateKeys.map((dk, idx) => {
    const events = groups.get(dk)!;
    const tripStart = events.find(e => e.type === 'trip_start');
    const restStart = events.find(e => e.type === 'rest_start');
    const odoEvents = rawEvents.filter(r => {
      const mapped = mapEvent(r);
      return mapped && jstDateKey(mapped.ts) === dk && r.odoKm != null;
    });
    const odos = odoEvents.map(e => e.odoKm!).filter(v => v > 0);
    const odoStart = odos.length > 0 ? Math.min(...odos) : 0;
    const odoEnd = odos.length > 0 ? Math.max(...odos) : 0;

    return {
      dayIndex: idx + 1,
      dateKey: dk,
      events,
      km: odoEnd - odoStart,
      odoStart,
      odoEnd,
      isFirstDay: idx === 0,
      tripStartMin: tripStart ? minuteOfDayJst(tripStart.ts) : null,
      restStartMin: restStart ? minuteOfDayJst(restStart.ts) : null,
      restPlace: restStart?.address ?? '',
    };
  });
}

// --- Metrics calculation ---
type DayCategory = 'drive' | 'work' | 'break' | 'rest' | 'wait' | 'load' | 'unload';

type RoundedInterval = {
  startMin: number;
  endMin: number;
  category: DayCategory;
};

type DayState = {
  category: DayCategory;
  tripActive: boolean;
};

function getReportWindow(
  day: DayRecord,
  events: TripEvent[],
  currentTs?: string,
): { startMin: number; endMin: number } {
  let startMin = 0;
  let endMin = DAY_TOTAL_MIN;

  if (day.isFirstDay) {
    const tripStart = events.find(event => event.type === 'trip_start');
    if (tripStart) {
      startMin = roundToQuarterMinutes(minuteOfDayExactJst(day.dateKey, tripStart.ts));
    }
  }

  const tripEnd = [...events].reverse().find(event => event.type === 'trip_end');
  if (tripEnd) {
    endMin = roundToQuarterMinutes(minuteOfDayExactJst(day.dateKey, tripEnd.ts));
  } else if (currentTs && jstDateKey(currentTs) === day.dateKey) {
    endMin = roundToQuarterMinutes(minuteOfDayExactJst(day.dateKey, currentTs));
  }

  if (endMin < startMin) {
    return { startMin, endMin: startMin };
  }
  return { startMin, endMin };
}

function inferInitialState(day: DayRecord, events: TripEvent[]): DayState {
  if (day.isFirstDay || events.length === 0) {
    return { category: 'rest', tripActive: false };
  }

  switch (events[0].type) {
    case 'trip_start':
      return { category: 'rest', tripActive: false };
    case 'rest_end':
    case 'disembark':
    case 'boarding':
      return { category: 'rest', tripActive: true };
    case 'rest_start':
      return { category: 'drive', tripActive: true };
    case 'break_end':
      return { category: 'break', tripActive: true };
    case 'load_end':
      return { category: 'load', tripActive: true };
    case 'unload_end':
      return { category: 'unload', tripActive: true };
    case 'wait_end':
      return { category: 'wait', tripActive: true };
    case 'work_end':
      return { category: 'work', tripActive: true };
    case 'drive_end':
    case 'trip_end':
    case 'break_start':
    case 'load_start':
    case 'unload_start':
    case 'wait_start':
    case 'work_start':
    case 'drive_start':
      return { category: 'drive', tripActive: true };
    default:
      return { category: 'rest', tripActive: false };
  }
}

function categoryAfterEvent(
  type: TripEventType,
  currentCategory: DayCategory,
  tripActive: boolean,
): { category: DayCategory; tripActive: boolean } {
  switch (type) {
    case 'trip_start':
      return { category: 'drive', tripActive: true };
    case 'trip_end':
      return { category: 'rest', tripActive: false };
    case 'rest_start':
      return { category: 'rest', tripActive: true };
    case 'rest_end':
      return { category: 'drive', tripActive: true };
    case 'boarding':
    case 'disembark':
      return { category: currentCategory, tripActive };
    case 'break_start':
      return { category: 'break', tripActive: true };
    case 'break_end':
      return { category: tripActive ? 'drive' : 'rest', tripActive };
    case 'load_start':
      return { category: 'load', tripActive: true };
    case 'load_end':
      return { category: tripActive ? 'drive' : 'rest', tripActive };
    case 'unload_start':
      return { category: 'unload', tripActive: true };
    case 'unload_end':
      return { category: tripActive ? 'drive' : 'rest', tripActive };
    case 'wait_start':
      return { category: 'wait', tripActive: true };
    case 'wait_end':
      return { category: tripActive ? 'drive' : 'rest', tripActive };
    case 'work_start':
      return { category: 'work', tripActive: true };
    case 'work_end':
      return { category: tripActive ? 'drive' : 'rest', tripActive };
    case 'drive_start':
      return { category: 'drive', tripActive: true };
    case 'drive_end':
      return { category: tripActive ? 'work' : 'rest', tripActive };
    default:
      return { category: currentCategory ?? (tripActive ? 'drive' : 'rest'), tripActive };
  }
}

function buildRoundedIntervals(day: DayRecord, currentTs?: string): RoundedInterval[] {
  const events = [...day.events].sort((a, b) => a.ts.localeCompare(b.ts));
  const { startMin: windowStart, endMin: windowEnd } = getReportWindow(day, events, currentTs);
  if (windowEnd <= windowStart) {
    return [];
  }

  if (events.length === 0) {
    return [{ startMin: windowStart, endMin: windowEnd, category: 'rest' }];
  }

  const scopedEvents = events.filter(event => {
    const boundary = roundToQuarterMinutes(minuteOfDayExactJst(day.dateKey, event.ts));
    return boundary >= windowStart && boundary <= windowEnd;
  });

  if (scopedEvents.length === 0) {
    return [{ startMin: windowStart, endMin: windowEnd, category: 'rest' }];
  }

  const intervals: RoundedInterval[] = [];
  let cursor = windowStart;
  const initialState = inferInitialState(day, scopedEvents);
  let tripActive = initialState.tripActive;
  let currentCategory = initialState.category;

  for (const event of scopedEvents) {
    const boundary = roundToQuarterMinutes(minuteOfDayExactJst(day.dateKey, event.ts));
    if (boundary > cursor) {
      intervals.push({ startMin: cursor, endMin: boundary, category: currentCategory });
    }
    const next = categoryAfterEvent(event.type, currentCategory, tripActive);
    currentCategory = next.category;
    tripActive = next.tripActive;
    cursor = boundary;
  }

  if (cursor < windowEnd) {
    intervals.push({ startMin: cursor, endMin: windowEnd, category: currentCategory });
  }

  const merged: RoundedInterval[] = [];
  for (const interval of intervals) {
    if (interval.endMin <= interval.startMin) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.category === interval.category && prev.endMin === interval.startMin) {
      prev.endMin = interval.endMin;
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function sumCategoryMinutes(intervals: RoundedInterval[], category: DayCategory): number {
  return intervals
    .filter(interval => interval.category === category)
    .reduce((sum, interval) => sum + Math.max(0, interval.endMin - interval.startMin), 0);
}

function buildRoundedPairDetails(
  day: DayRecord,
  startType: TripEventType,
  endType: TripEventType,
): Array<{ startTs: string; endTs: string; minutes: number; customer?: string; volume?: number; address?: string }> {
  const events = [...day.events].sort((a, b) => a.ts.localeCompare(b.ts));
  const starts = events.filter(event => event.type === startType);
  const ends = events.filter(event => event.type === endType);
  const details: Array<{ startTs: string; endTs: string; minutes: number; customer?: string; volume?: number; address?: string }> = [];

  for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
    const start = starts[i];
    const end = ends[i];
    const startMin = roundToQuarterMinutes(minuteOfDayExactJst(day.dateKey, start.ts));
    const endMin = roundToQuarterMinutes(minuteOfDayExactJst(day.dateKey, end.ts));
    const safeEnd = Math.max(startMin, endMin);
    details.push({
      startTs: utcFromJstMinute(day.dateKey, startMin),
      endTs: utcFromJstMinute(day.dateKey, safeEnd),
      minutes: safeEnd - startMin,
      customer: start.customer ?? end.customer,
      volume: start.volume ?? end.volume,
      address: start.address ?? end.address,
    });
  }

  return details;
}

function buildCategorySegments(
  day: DayRecord,
  intervals: RoundedInterval[],
  category: DayCategory,
): TimeSegmentDetail[] {
  const events = [...day.events].sort((a, b) => a.ts.localeCompare(b.ts));
  const startTypes =
    category === 'rest'
      ? ['rest_start']
      : ([`${category}_start`] as string[]);
  const endTypes =
    category === 'rest'
      ? ['rest_end']
      : ([`${category}_end`] as string[]);
  return intervals
    .filter(interval => interval.category === category && interval.endMin > interval.startMin)
    .map(interval => {
      const startsAtBoundary = events.some(event =>
        startTypes.includes(event.type)
        && roundToQuarterMinutes(minuteOfDayExactJst(day.dateKey, event.ts)) === interval.startMin,
      );
      const endsAtBoundary = events.some(event =>
        endTypes.includes(event.type)
        && roundToQuarterMinutes(minuteOfDayExactJst(day.dateKey, event.ts)) === interval.endMin,
      );
      return {
        startTs: utcFromJstMinute(day.dateKey, interval.startMin),
        endTs: utcFromJstMinute(day.dateKey, interval.endMin),
        durationMinutes: interval.endMin - interval.startMin,
        continuesFromPreviousDay: interval.startMin === 0 && !day.isFirstDay && !startsAtBoundary,
        continuesToNextDay: interval.endMin === DAY_TOTAL_MIN && !endsAtBoundary,
      };
    });
}

function mergeTimeSegments(segments: TimeSegmentDetail[]): TimeSegmentDetail[] {
  const merged: TimeSegmentDetail[] = [];
  for (const segment of segments) {
    if (segment.durationMinutes <= 0) continue;
    const prev = merged[merged.length - 1];
    if (
      prev
      && prev.endTs === segment.startTs
      && prev.continuesToNextDay !== true
      && segment.continuesFromPreviousDay !== true
    ) {
      prev.endTs = segment.endTs;
      prev.durationMinutes += segment.durationMinutes;
      prev.continuesToNextDay = segment.continuesToNextDay;
      continue;
    }
    merged.push({ ...segment });
  }
  return merged;
}

function subtractSegments(
  day: DayRecord,
  baseSegments: TimeSegmentDetail[],
  overlaySegments: TimeSegmentDetail[],
): TimeSegmentDetail[] {
  if (baseSegments.length === 0 || overlaySegments.length === 0) return baseSegments;

  const overlayRanges = overlaySegments
    .map(segment => ({
      startMin: roundToQuarterMinutes(minuteOfDayExactJst(day.dateKey, segment.startTs)),
      endMin: roundToQuarterMinutes(minuteOfDayExactJst(day.dateKey, segment.endTs)),
    }))
    .filter(range => range.endMin > range.startMin)
    .sort((a, b) => a.startMin - b.startMin);

  if (overlayRanges.length === 0) return baseSegments;

  const result: TimeSegmentDetail[] = [];
  for (const base of baseSegments) {
    const baseStartMin = roundToQuarterMinutes(minuteOfDayExactJst(day.dateKey, base.startTs));
    const baseEndMin = roundToQuarterMinutes(minuteOfDayExactJst(day.dateKey, base.endTs));
    if (baseEndMin <= baseStartMin) continue;

    const overlaps = overlayRanges.filter(
      range => range.endMin > baseStartMin && range.startMin < baseEndMin,
    );
    if (overlaps.length === 0) {
      result.push(base);
      continue;
    }

    let cursor = baseStartMin;
    for (const overlap of overlaps) {
      const overlapStart = Math.max(baseStartMin, overlap.startMin);
      const overlapEnd = Math.min(baseEndMin, overlap.endMin);
      if (overlapStart > cursor) {
        result.push({
          startTs: utcFromJstMinute(day.dateKey, cursor),
          endTs: utcFromJstMinute(day.dateKey, overlapStart),
          durationMinutes: overlapStart - cursor,
          continuesFromPreviousDay: cursor === baseStartMin ? base.continuesFromPreviousDay : false,
          continuesToNextDay: false,
        });
      }
      cursor = Math.max(cursor, overlapEnd);
      if (cursor >= baseEndMin) break;
    }

    if (cursor < baseEndMin) {
      result.push({
        startTs: utcFromJstMinute(day.dateKey, cursor),
        endTs: utcFromJstMinute(day.dateKey, baseEndMin),
        durationMinutes: baseEndMin - cursor,
        continuesFromPreviousDay: cursor === baseStartMin ? base.continuesFromPreviousDay : false,
        continuesToNextDay: base.continuesToNextDay,
      });
    }
  }

  return mergeTimeSegments(result);
}

type AbsoluteInterval = RoundedInterval & {
  dayIndex: number;
  dateKey: string;
  startTs: string;
  endTs: string;
};

type ContinuousDriveState = {
  longestContinuousDriveMinutes: number;
  continuousDriveExceeded: boolean;
  continuousDriveEmergencyExceeded: boolean;
};

function buildAbsoluteIntervals(day: DayRecord, currentTs?: string): AbsoluteInterval[] {
  return buildRoundedIntervals(day, currentTs).map(interval => ({
    ...interval,
    dayIndex: day.dayIndex,
    dateKey: day.dateKey,
    startTs: utcFromJstMinute(day.dateKey, interval.startMin),
    endTs: utcFromJstMinute(day.dateKey, interval.endMin),
  }));
}

function summarizeContinuousDrive(days: DayRecord[], currentTs?: string): Map<number, ContinuousDriveState> {
  const byDay = new Map<number, ContinuousDriveState>();
  const intervals = days
    .flatMap(day => buildAbsoluteIntervals(day, currentTs))
    .sort((a, b) => a.startTs.localeCompare(b.startTs));

  let driveSinceReset = 0;
  let qualifyingBreakMinutes = 0;

  const ensure = (dayIndex: number) => {
    const current = byDay.get(dayIndex);
    if (current) return current;
    const next: ContinuousDriveState = {
      longestContinuousDriveMinutes: 0,
      continuousDriveExceeded: false,
      continuousDriveEmergencyExceeded: false,
    };
    byDay.set(dayIndex, next);
    return next;
  };

  for (const interval of intervals) {
    const duration = Math.max(0, interval.endMin - interval.startMin);
    if (duration <= 0) continue;

    if (interval.category === 'drive') {
      if (qualifyingBreakMinutes < 30) {
        qualifyingBreakMinutes = 0;
      }
      driveSinceReset += duration;
      const state = ensure(interval.dayIndex);
      state.longestContinuousDriveMinutes = Math.max(state.longestContinuousDriveMinutes, driveSinceReset);
      if (driveSinceReset > CONTINUOUS_DRIVE_LIMIT_MIN) {
        state.continuousDriveExceeded = true;
      }
      if (driveSinceReset > CONTINUOUS_DRIVE_EMERGENCY_LIMIT_MIN) {
        state.continuousDriveEmergencyExceeded = true;
      }
      continue;
    }

    if (duration >= 10) {
      qualifyingBreakMinutes += duration;
      if (qualifyingBreakMinutes >= 30) {
        driveSinceReset = 0;
        qualifyingBreakMinutes = 0;
      }
      continue;
    }

    qualifyingBreakMinutes = 0;
  }

  return byDay;
}

function buildTripFerrySegmentsByDay(days: DayRecord[]): Map<number, TimeSegmentDetail[]> {
  const byDay = new Map<number, TimeSegmentDetail[]>();
  const events = days
    .flatMap(day => day.events.map(event => ({ ...event, dayIndex: day.dayIndex })))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const starts = events.filter(event => event.type === 'boarding');
  const ends = events.filter(event => event.type === 'disembark');

  for (let index = 0; index < Math.min(starts.length, ends.length); index++) {
    const start = starts[index];
    const end = ends[index];
    const startMs = new Date(start.ts).getTime();
    const endMs = Math.max(startMs, new Date(end.ts).getTime());
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;

    for (const day of days) {
      const dayStartMs = jstDayStartMs(day.dateKey);
      const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
      const overlapStartMs = Math.max(startMs, dayStartMs);
      const overlapEndMs = Math.min(endMs, dayEndMs);
      if (overlapEndMs <= overlapStartMs) continue;
      const roundedStartMin = roundToQuarterMinutes(
        minuteOfDayExactJst(day.dateKey, new Date(overlapStartMs).toISOString()),
      );
      const roundedEndMin = roundToQuarterMinutes(
        minuteOfDayExactJst(day.dateKey, new Date(overlapEndMs).toISOString()),
      );
      if (roundedEndMin <= roundedStartMin) continue;
      const entry = byDay.get(day.dayIndex) ?? [];
      entry.push({
        startTs: utcFromJstMinute(day.dateKey, roundedStartMin),
        endTs: utcFromJstMinute(day.dateKey, roundedEndMin),
        durationMinutes: roundedEndMin - roundedStartMin,
        continuesFromPreviousDay: overlapStartMs > startMs,
        continuesToNextDay: overlapEndMs < endMs,
      });
      byDay.set(day.dayIndex, entry);
    }
  }

  return byDay;
}

function getRollingDriveMinutes(days: DayRecord[], metricsList: DayMetrics[], index: number, spanDays: number): number {
  const currentStamp = jstDayStartMs(days[index].dateKey);
  const earliestStamp = currentStamp - (spanDays - 1) * 24 * 60 * 60 * 1000;
  let total = 0;
  for (let i = 0; i <= index; i++) {
    const stamp = jstDayStartMs(days[i].dateKey);
    if (stamp < earliestStamp || stamp > currentStamp) continue;
    total += metricsList[i].driveMinutes;
  }
  return total;
}

function hasOutsideRestCandidate(trip: Trip): boolean {
  const tripStartAddress = trip.days
    .flatMap(day => day.events)
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .find(event => event.type === 'trip_start')
    ?.address
    ?.trim();

  if (!tripStartAddress) return false;

  return trip.days.some(day => {
    const restAddress = [...day.events]
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .find(event => event.type === 'rest_start')
      ?.address
      ?.trim()
      || day.restPlace?.trim();
    return !!restAddress && restAddress !== tripStartAddress;
  });
}

function isLongDistanceCandidate(day: DayRecord, trip?: Trip): boolean {
  if (day.km >= LONG_DISTANCE_THRESHOLD_KM) return true;
  if (!trip) return false;
  const totalKm = trip.days.reduce((sum, tripDay) => sum + Math.max(0, tripDay.km), 0);
  const hasOvernight = trip.days.length > 1;
  return totalKm >= LONG_DISTANCE_THRESHOLD_KM && (hasOvernight || hasOutsideRestCandidate(trip));
}

function getRuleProfile(day: DayRecord, ferryMinutes: number, trip?: Trip): {
  mode: ComplianceRuleMode;
  label: string;
  reason: string;
  constraintLimitMinutes: number;
  restMinimumMinutes: number;
} {
  if (ferryMinutes > 0) {
    return {
      mode: 'ferry',
      label: 'フェリー特例',
      reason: `フェリー区間 ${formatMinutes(ferryMinutes)} を検出`,
      constraintLimitMinutes: SPECIAL_CONSTRAINT_MAX_MIN,
      restMinimumMinutes: SPECIAL_REST_MIN_MIN,
    };
  }
  if (isLongDistanceCandidate(day, trip)) {
    const totalKm = trip ? trip.days.reduce((sum, tripDay) => sum + Math.max(0, tripDay.km), 0) : day.km;
    return {
      mode: 'long_distance',
      label: '長距離特例候補',
      reason:
        day.km >= LONG_DISTANCE_THRESHOLD_KM
          ? `当日区間 ${day.km}km を検出`
          : `総距離 ${totalKm}km と複数日構成から長距離特例候補として自動判定`,
      constraintLimitMinutes: SPECIAL_CONSTRAINT_MAX_MIN,
      restMinimumMinutes: SPECIAL_REST_MIN_MIN,
    };
  }
  return {
    mode: 'general',
    label: '一般ルール',
    reason: 'フェリー区間と 450km 以上区間なし',
    constraintLimitMinutes: GENERAL_CONSTRAINT_MAX_MIN,
    restMinimumMinutes: GENERAL_REST_MIN_MIN,
  };
}

function computeEarliestRestart(day: DayRecord, restMinimumMinutes: number): string | null {
  const events = [...day.events].sort((a, b) => a.ts.localeCompare(b.ts));
  const restStart = [...events].reverse().find(e => e.type === 'rest_start');
  if (!restStart) return null;
  const exactRestartMin = minuteOfDayExactJst(day.dateKey, restStart.ts) + restMinimumMinutes;
  const restartMin = Math.max(0, Math.ceil(exactRestartMin / QUARTER_MIN) * QUARTER_MIN);
  return utcFromJstMinute(day.dateKey, restartMin, false);
}

export function computeDayMetrics(day: DayRecord, currentTs?: string): DayMetrics {
  const alerts: ReportAlert[] = [];
  const intervals = buildRoundedIntervals(day, currentTs);
  const coveredMin = intervals.reduce((sum, interval) => sum + Math.max(0, interval.endMin - interval.startMin), 0);
  const isPartialDay = coveredMin < DAY_TOTAL_MIN;
  const driveMin = sumCategoryMinutes(intervals, 'drive');
  const workMin = sumCategoryMinutes(intervals, 'work');
  const breakMin = sumCategoryMinutes(intervals, 'break');
  const baseRestMin = sumCategoryMinutes(intervals, 'rest');
  const waitMin = sumCategoryMinutes(intervals, 'wait');
  const loadMin = sumCategoryMinutes(intervals, 'load');
  const unloadMin = sumCategoryMinutes(intervals, 'unload');
  const ferrySegments = buildRoundedPairDetails(day, 'boarding', 'disembark').map(segment => ({
    startTs: segment.startTs,
    endTs: segment.endTs,
    durationMinutes: segment.minutes,
  }));
  const ferryMinutes = ferrySegments.reduce((sum, segment) => sum + segment.durationMinutes, 0);
  const restSegments = subtractSegments(
    day,
    buildCategorySegments(day, intervals, 'rest'),
    ferrySegments,
  );
  const restMin = restSegments.reduce((sum, segment) => sum + segment.durationMinutes, 0);
  const restEquivalentMin = restMin + Math.max(0, baseRestMin - restMin);
  const constraintMin = Math.max(0, coveredMin - restEquivalentMin);
  const ruleProfile = getRuleProfile(day, ferryMinutes);

  // Regulation checks
  const constraintOverLimit = constraintMin > ruleProfile.constraintLimitMinutes;
  const driveOverLimit = false;
  const restUnderLimit = !isPartialDay && restEquivalentMin > 0 && restEquivalentMin < ruleProfile.restMinimumMinutes;

  if (constraintMin > ruleProfile.constraintLimitMinutes) {
    alerts.push({ level: 'danger', message: `拘束時間 ${formatMinutes(constraintMin)} が ${formatMinutes(ruleProfile.constraintLimitMinutes)} を超過` });
  } else if (constraintMin > CONSTRAINT_WARNING_MIN) {
    alerts.push({ level: 'warning', message: `拘束時間 ${formatMinutes(constraintMin)} が原則13時間を超過` });
  }
  if (restUnderLimit) {
    alerts.push({ level: 'warning', message: `休息相当 ${formatMinutes(restEquivalentMin)} が最短 ${formatMinutes(ruleProfile.restMinimumMinutes)} 未満` });
  } else if (!isPartialDay && restEquivalentMin > 0 && restEquivalentMin < TARGET_REST_MIN && ruleProfile.mode === 'general') {
    alerts.push({ level: 'warning', message: `休息相当 ${formatMinutes(restEquivalentMin)} は下限内ですが、11時間確保が推奨です` });
  }

  // Rolling rules are populated by computeTripDayMetrics. Standalone defaults stay day-local.
  const nextDriveRemaining = Math.max(0, TWO_DAY_DRIVE_LIMIT_MIN - driveMin);
  const nextConstraintRemaining = Math.max(0, ruleProfile.constraintLimitMinutes - constraintMin);
  const earliestRestart = computeEarliestRestart(day, ruleProfile.restMinimumMinutes);

  const loads: LoadDetail[] = buildRoundedPairDetails(day, 'load_start', 'load_end').map(d => ({
    customer: d.customer ?? '',
    volume: d.volume ?? 0,
    startTs: d.startTs,
    endTs: d.endTs,
    durationMinutes: d.minutes,
    address: d.address,
  }));

  const unloads: LoadDetail[] = buildRoundedPairDetails(day, 'unload_start', 'unload_end').map(d => ({
    customer: d.customer ?? '',
    volume: d.volume ?? 0,
    startTs: d.startTs,
    endTs: d.endTs,
    durationMinutes: d.minutes,
    address: d.address,
  }));
  return {
    constraintMinutes: constraintMin,
    driveMinutes: driveMin,
    workMinutes: workMin,
    breakMinutes: breakMin,
    restMinutes: restMin,
    restEquivalentMinutes: restEquivalentMin,
    waitMinutes: waitMin,
    loadMinutes: loadMin,
    unloadMinutes: unloadMin,
    ruleMode: ruleProfile.mode,
    ruleModeLabel: ruleProfile.label,
    ruleModeReason: ruleProfile.reason,
    effectiveConstraintLimitMinutes: ruleProfile.constraintLimitMinutes,
    effectiveRestMinimumMinutes: ruleProfile.restMinimumMinutes,
    rollingTwoDayDriveMinutes: driveMin,
    rollingTwoWeekDriveMinutes: driveMin,
    rollingTwoWeekWeeklyAverageMinutes: Math.round(driveMin / 2),
    longestContinuousDriveMinutes: driveMin,
    continuousDriveExceeded: false,
    continuousDriveEmergencyExceeded: false,
    ferryMinutes,
    constraintOverLimit,
    driveOverLimit,
    restUnderLimit,
    nextDriveRemaining,
    nextConstraintRemaining,
    earliestRestart,
    restSegments,
    ferrySegments,
    loads,
    unloads,
    alerts,
  };
}

export function computeTripDayMetrics(
  trip: Trip,
  options?: { currentTs?: string },
): DayMetrics[] {
  const currentTs = options?.currentTs;
  const base = trip.days.map(day => computeDayMetrics(day, currentTs));
  const continuous = summarizeContinuousDrive(trip.days, currentTs);
  const ferryByDay = buildTripFerrySegmentsByDay(trip.days);

  return base.map((metrics, index) => {
    const day = trip.days[index];
    const ferrySegments = ferryByDay.get(day.dayIndex) ?? metrics.ferrySegments;
    const ferryMinutes = ferrySegments.reduce((sum, segment) => sum + segment.durationMinutes, 0);
    const ruleProfile = getRuleProfile(day, ferryMinutes, trip);
    const intervals = buildRoundedIntervals(day, currentTs);
    const coveredMin = intervals.reduce((sum, interval) => sum + Math.max(0, interval.endMin - interval.startMin), 0);
    const baseRestSegments = buildCategorySegments(day, intervals, 'rest');
    const baseRestMinutes = baseRestSegments.reduce((sum, segment) => sum + segment.durationMinutes, 0);
    const restSegments = subtractSegments(day, baseRestSegments, ferrySegments);
    const restMinutes = restSegments.reduce((sum, segment) => sum + segment.durationMinutes, 0);
    const restEquivalentMinutes = restMinutes + Math.max(0, baseRestMinutes - restMinutes);
    const constraintMinutes = Math.max(0, coveredMin - restEquivalentMinutes);
    const rollingTwoDayDriveMinutes = getRollingDriveMinutes(trip.days, base, index, 2);
    const rollingTwoWeekDriveMinutes = getRollingDriveMinutes(trip.days, base, index, 14);
    const rollingTwoWeekWeeklyAverageMinutes = Math.round(rollingTwoWeekDriveMinutes / 2);
    const nextDriveRemaining = Math.max(0, TWO_DAY_DRIVE_LIMIT_MIN - rollingTwoDayDriveMinutes);
    const nextConstraintRemaining = Math.max(0, ruleProfile.constraintLimitMinutes - constraintMinutes);
    const continuousState = continuous.get(day.dayIndex) ?? {
      longestContinuousDriveMinutes: 0,
      continuousDriveExceeded: false,
      continuousDriveEmergencyExceeded: false,
    };
    const alerts: ReportAlert[] = [];

    if (constraintMinutes > ruleProfile.constraintLimitMinutes) {
      alerts.push({ level: 'danger', message: `拘束時間 ${formatMinutes(constraintMinutes)} が ${formatMinutes(ruleProfile.constraintLimitMinutes)} を超過` });
    } else if (constraintMinutes > CONSTRAINT_WARNING_MIN) {
      alerts.push({ level: 'warning', message: `拘束時間 ${formatMinutes(constraintMinutes)} が原則13時間を超過` });
    }

    if (rollingTwoDayDriveMinutes > TWO_DAY_DRIVE_LIMIT_MIN) {
      alerts.push({ level: 'danger', message: `直近48時間の運転 ${formatMinutes(rollingTwoDayDriveMinutes)} が 18時間を超過` });
    }

    if (rollingTwoWeekDriveMinutes > TWO_WEEK_DRIVE_LIMIT_MIN) {
      alerts.push({ level: 'danger', message: `直近14日運転 ${formatMinutes(rollingTwoWeekDriveMinutes)} が 88時間を超過` });
    }

    if (continuousState.continuousDriveEmergencyExceeded) {
      alerts.push({ level: 'danger', message: `連続運転 ${formatMinutes(continuousState.longestContinuousDriveMinutes)} が 4時間30分を超過` });
    } else if (continuousState.continuousDriveExceeded) {
      alerts.push({ level: 'warning', message: `連続運転 ${formatMinutes(continuousState.longestContinuousDriveMinutes)} が 4時間を超過` });
    }

    const isPartialDay =
      metrics.driveMinutes
      + metrics.workMinutes
      + metrics.loadMinutes
      + metrics.unloadMinutes
      + metrics.waitMinutes
      + metrics.breakMinutes
      + restMinutes
      + ferryMinutes
      < DAY_TOTAL_MIN;

    if (!isPartialDay && restEquivalentMinutes > 0 && restEquivalentMinutes < ruleProfile.restMinimumMinutes) {
      alerts.push({ level: 'warning', message: `休息相当 ${formatMinutes(restEquivalentMinutes)} が最短 ${formatMinutes(ruleProfile.restMinimumMinutes)} 未満` });
    } else if (!isPartialDay && ruleProfile.mode === 'general' && restEquivalentMinutes > 0 && restEquivalentMinutes < TARGET_REST_MIN) {
      alerts.push({ level: 'warning', message: `休息相当 ${formatMinutes(restEquivalentMinutes)} は下限内ですが、11時間確保が推奨です` });
    }

    if (!isPartialDay && ruleProfile.mode !== 'general' && restEquivalentMinutes >= SPECIAL_REST_MIN_MIN && restEquivalentMinutes < GENERAL_REST_MIN_MIN) {
      alerts.push({ level: 'warning', message: `特例で 8時間台の休息です。次の運行終了後は 12時間以上の休息を確保してください` });
    }

    return {
      ...metrics,
      constraintMinutes,
      restMinutes,
      restEquivalentMinutes,
      ruleMode: ruleProfile.mode,
      ruleModeLabel: ruleProfile.label,
      ruleModeReason: ruleProfile.reason,
      effectiveConstraintLimitMinutes: ruleProfile.constraintLimitMinutes,
      effectiveRestMinimumMinutes: ruleProfile.restMinimumMinutes,
      rollingTwoDayDriveMinutes,
      rollingTwoWeekDriveMinutes,
      rollingTwoWeekWeeklyAverageMinutes,
      longestContinuousDriveMinutes: continuousState.longestContinuousDriveMinutes,
      continuousDriveExceeded: continuousState.continuousDriveExceeded,
      continuousDriveEmergencyExceeded: continuousState.continuousDriveEmergencyExceeded,
      ferryMinutes,
      constraintOverLimit: constraintMinutes > ruleProfile.constraintLimitMinutes,
      ferrySegments,
      driveOverLimit: rollingTwoDayDriveMinutes > TWO_DAY_DRIVE_LIMIT_MIN,
      nextDriveRemaining,
      nextConstraintRemaining,
      restUnderLimit: !isPartialDay && restEquivalentMinutes > 0 && restEquivalentMinutes < ruleProfile.restMinimumMinutes,
      restSegments,
      earliestRestart: computeEarliestRestart(day, ruleProfile.restMinimumMinutes),
      alerts,
    };
  });
}

export function computeMonthSummary(trips: Trip[], month: string): MonthSummary {
  const days: MonthSummary['days'] = [];
  let totalDrive = 0, totalWork = 0, totalBreak = 0, totalRest = 0, totalConstraint = 0, totalKm = 0;
  let overConstraint = 0, overDrive = 0, underRest = 0;

  for (const trip of trips) {
    const tripMetrics = computeTripDayMetrics(trip);
    for (let index = 0; index < trip.days.length; index++) {
      const day = trip.days[index];
      if (!day.dateKey.startsWith(month)) continue;
      const metrics = tripMetrics[index];
      days.push({
        dateKey: day.dateKey,
        tripId: trip.id,
        dayIndex: day.dayIndex,
        metrics,
      });
      totalDrive += metrics.driveMinutes;
      totalWork += metrics.workMinutes;
      totalBreak += metrics.breakMinutes;
      totalRest += metrics.restMinutes;
      totalConstraint += metrics.constraintMinutes;
      totalKm += day.km;
      if (metrics.constraintOverLimit) overConstraint++;
      if (metrics.driveOverLimit) overDrive++;
      if (metrics.restUnderLimit) underRest++;
    }
  }

  return {
    month,
    totalTrips: trips.length,
    totalDriveMinutes: totalDrive,
    totalWorkMinutes: totalWork,
    totalBreakMinutes: totalBreak,
    totalRestMinutes: totalRest,
    totalConstraintMinutes: totalConstraint,
    totalKm,
    overConstraintDays: overConstraint,
    overDriveDays: overDrive,
    underRestDays: underRest,
    days: days.sort((a, b) => a.dateKey.localeCompare(b.dateKey)),
  };
}

// --- Helpers ---
export function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}分`;
  if (m === 0) return `${h}時間`;
  return `${h}時間${m}分`;
}

export function formatMinutesShort(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export { formatJstTime, formatRoundedJstTime, diffMinutes, toJstDate, jstDateKey };
