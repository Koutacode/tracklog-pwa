import type {
  TripEvent,
  TripEventType,
  DayRecord,
  DayMetrics,
  LoadDetail,
  ReportAlert,
  Trip,
  JobInfo,
  MonthSummary,
} from './reportTypes';

// --- Regulation constants (令和6年4月改正) ---
const CONSTRAINT_LIMIT_MIN = 13 * 60;   // 拘束上限 13h
const CONSTRAINT_EXTEND_MIN = 16 * 60;  // 延長時 16h
const DRIVE_LIMIT_MIN = 9 * 60;         // 運転上限 9h/日
const REST_MIN_MIN = 8 * 60;            // 最短休息 8h

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
};

const VALID_EVENT_TYPES: Set<string> = new Set([
  'trip_start', 'trip_end',
  'load_start', 'load_end',
  'unload_start', 'unload_end',
  'break_start', 'break_end',
  'rest_start', 'rest_end',
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

export function parseJsonToTrip(jsonStr: string, tripId: string): Trip {
  const raw: RawJson = JSON.parse(jsonStr);
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

  if (raw.dayRuns && raw.dayRuns.length > 0) {
    days = raw.dayRuns.map((dr, idx) => {
      const events = dr.events.map(mapEvent).filter((e): e is TripEvent => e !== null);
      const tripStart = events.find(e => e.type === 'trip_start');
      const restStart = events.find(e => e.type === 'rest_start');
      return {
        dayIndex: idx + 1,
        dateKey: dr.dateKey,
        events,
        km: dr.km ?? 0,
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
  } else {
    days = [];
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
function computePairedDuration(
  events: TripEvent[],
  startType: TripEventType,
  endType: TripEventType
): { totalMinutes: number; details: Array<{ startTs: string; endTs: string; minutes: number; customer?: string; volume?: number; address?: string }> } {
  const starts: TripEvent[] = [];
  const ends: TripEvent[] = [];
  for (const e of events) {
    if (e.type === startType) starts.push(e);
    if (e.type === endType) ends.push(e);
  }

  const details: Array<{ startTs: string; endTs: string; minutes: number; customer?: string; volume?: number; address?: string }> = [];
  let totalMinutes = 0;

  for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
    const mins = diffMinutes(starts[i].ts, ends[i].ts);
    totalMinutes += mins;
    details.push({
      startTs: starts[i].ts,
      endTs: ends[i].ts,
      minutes: mins,
      customer: starts[i].customer ?? ends[i].customer,
      volume: starts[i].volume ?? ends[i].volume,
      address: starts[i].address ?? ends[i].address,
    });
  }

  return { totalMinutes, details };
}

export function computeDayMetrics(day: DayRecord, prevDayRestStart?: string): DayMetrics {
  const events = [...day.events].sort((a, b) => a.ts.localeCompare(b.ts));
  const alerts: ReportAlert[] = [];

  // Day1: only count from trip_start onward
  let effectiveStart: string | null = null;
  let effectiveEnd: string | null = null;

  if (day.isFirstDay) {
    const tripStart = events.find(e => e.type === 'trip_start');
    effectiveStart = tripStart?.ts ?? (events.length > 0 ? events[0].ts : null);
  } else {
    effectiveStart = events.length > 0 ? events[0].ts : null;
  }

  const tripEnd = events.find(e => e.type === 'trip_end');
  const restStart = [...events].reverse().find(e => e.type === 'rest_start');
  effectiveEnd = tripEnd?.ts ?? restStart?.ts ?? (events.length > 0 ? events[events.length - 1].ts : null);

  // Filter events for Day1 (ignore events before trip_start)
  let activeEvents = events;
  if (day.isFirstDay && effectiveStart) {
    activeEvents = events.filter(e => e.ts >= effectiveStart!);
  }

  // Paired durations
  const drive = computePairedDuration(activeEvents, 'drive_start', 'drive_end');
  const work = computePairedDuration(activeEvents, 'work_start', 'work_end');
  const breakResult = computePairedDuration(activeEvents, 'break_start', 'break_end');
  const rest = computePairedDuration(activeEvents, 'rest_start', 'rest_end');
  const wait = computePairedDuration(activeEvents, 'wait_start', 'wait_end');
  const load = computePairedDuration(activeEvents, 'load_start', 'load_end');
  const unload = computePairedDuration(activeEvents, 'unload_start', 'unload_end');

  // If no explicit drive/work events, estimate from load/unload/break/rest/wait
  let driveMin = drive.totalMinutes;
  let workMin = work.totalMinutes;
  const breakMin = breakResult.totalMinutes;
  const restMin = rest.totalMinutes;
  const waitMin = wait.totalMinutes;
  const loadMin = load.totalMinutes;
  const unloadMin = unload.totalMinutes;

  // Constraint time = effectiveEnd - effectiveStart (minus rest)
  let constraintMin = 0;
  if (effectiveStart && effectiveEnd) {
    constraintMin = diffMinutes(effectiveStart, effectiveEnd) - restMin;
  }

  // If workMin is 0 but we have load/unload, count them as work
  if (workMin === 0) {
    workMin = loadMin + unloadMin + waitMin;
  }

  // If driveMin is 0, estimate: constraint - work - break
  if (driveMin === 0 && constraintMin > 0) {
    driveMin = Math.max(0, constraintMin - workMin - breakMin);
  }

  // Regulation checks
  const constraintOverLimit = constraintMin > CONSTRAINT_LIMIT_MIN;
  const driveOverLimit = driveMin > DRIVE_LIMIT_MIN;
  const restUnderLimit = restMin > 0 && restMin < REST_MIN_MIN;

  if (constraintOverLimit) {
    if (constraintMin > CONSTRAINT_EXTEND_MIN) {
      alerts.push({ level: 'danger', message: `拘束時間 ${formatMinutes(constraintMin)} が延長上限16時間を超過` });
    } else {
      alerts.push({ level: 'warning', message: `拘束時間 ${formatMinutes(constraintMin)} が上限13時間を超過` });
    }
  }
  if (driveOverLimit) {
    alerts.push({ level: 'danger', message: `運転時間 ${formatMinutes(driveMin)} が上限9時間を超過` });
  }
  if (restUnderLimit) {
    alerts.push({ level: 'warning', message: `休息時間 ${formatMinutes(restMin)} が最短8時間未満` });
  }

  // Next day outlook
  const nextDriveRemaining = Math.max(0, DRIVE_LIMIT_MIN - driveMin);
  const nextConstraintRemaining = Math.max(0, CONSTRAINT_LIMIT_MIN - constraintMin);

  let earliestRestart: string | null = null;
  if (restStart) {
    earliestRestart = new Date(new Date(restStart.ts).getTime() + REST_MIN_MIN * 60000).toISOString();
  }

  const loads: LoadDetail[] = load.details.map(d => ({
    customer: d.customer ?? '',
    volume: d.volume ?? 0,
    startTs: d.startTs,
    endTs: d.endTs,
    durationMinutes: d.minutes,
    address: d.address,
  }));

  const unloads: LoadDetail[] = unload.details.map(d => ({
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
    waitMinutes: waitMin,
    loadMinutes: loadMin,
    unloadMinutes: unloadMin,
    constraintOverLimit,
    driveOverLimit,
    restUnderLimit,
    nextDriveRemaining,
    nextConstraintRemaining,
    earliestRestart,
    loads,
    unloads,
    alerts,
  };
}

export function computeMonthSummary(trips: Trip[], month: string): MonthSummary {
  const days: MonthSummary['days'] = [];
  let totalDrive = 0, totalWork = 0, totalBreak = 0, totalRest = 0, totalConstraint = 0, totalKm = 0;
  let overConstraint = 0, overDrive = 0, underRest = 0;

  for (const trip of trips) {
    for (const day of trip.days) {
      if (!day.dateKey.startsWith(month)) continue;
      const metrics = computeDayMetrics(day);
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

export { formatJstTime, diffMinutes, toJstDate, jstDateKey };
