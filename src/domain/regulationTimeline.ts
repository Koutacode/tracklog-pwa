import type { DayRecord, TripEventType } from './reportTypes';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const JST_OFFSET_MS = 9 * 60 * MINUTE_MS;
const MIN_QUALIFYING_SEGMENT_MS = 10 * MINUTE_MS;
const REQUIRED_RESET_MS = 30 * MINUTE_MS;
const CONTINUOUS_DRIVE_LIMIT_MS = 4 * 60 * MINUTE_MS;
const CONTINUOUS_DRIVE_EMERGENCY_LIMIT_MS = (4 * 60 + 30) * MINUTE_MS;

export type RegulationTimelineCategory =
  | 'drive'
  | 'work'
  | 'break'
  | 'rest'
  | 'wait'
  | 'load'
  | 'unload';

export type RegulationTimelineInterval = {
  category: RegulationTimelineCategory;
  startTs: string;
  endTs: string;
  durationMinutes: number;
};

export type ContinuousDriveDayState = {
  longestContinuousDriveMinutes: number;
  continuousDriveExceeded: boolean;
  continuousDriveEmergencyExceeded: boolean;
};

export type ContinuousDriveTimelineResult = {
  intervals: RegulationTimelineInterval[];
  byDay: Map<number, ContinuousDriveDayState>;
  driveSinceResetMinutes: number;
  qualifyingInterruptionMinutes: number;
  resetTimestamps: string[];
};

type TimelineState = {
  category: RegulationTimelineCategory;
  tripActive: boolean;
};

type InternalInterval = {
  category: RegulationTimelineCategory;
  startMs: number;
  endMs: number;
};

const QUALIFYING_RESET_CATEGORIES: ReadonlySet<RegulationTimelineCategory> = new Set([
  'break',
  'rest',
  'load',
  'unload',
  'work',
]);

function stateAfterEvent(
  type: TripEventType,
  current: TimelineState,
): TimelineState {
  switch (type) {
    case 'trip_start':
      return { category: 'drive', tripActive: true };
    case 'trip_end':
      return { category: 'rest', tripActive: false };
    case 'rest_start':
      return { category: 'rest', tripActive: true };
    case 'rest_end':
      return { category: 'drive', tripActive: true };
    case 'break_start':
      return { category: 'break', tripActive: true };
    case 'break_end':
      return { category: current.tripActive ? 'drive' : 'rest', tripActive: current.tripActive };
    case 'load_start':
      return { category: 'load', tripActive: true };
    case 'load_end':
      return { category: current.tripActive ? 'drive' : 'rest', tripActive: current.tripActive };
    case 'unload_start':
      return { category: 'unload', tripActive: true };
    case 'unload_end':
      return { category: current.tripActive ? 'drive' : 'rest', tripActive: current.tripActive };
    case 'wait_start':
      return { category: 'wait', tripActive: true };
    case 'wait_end':
      return { category: current.tripActive ? 'drive' : 'rest', tripActive: current.tripActive };
    case 'work_start':
      return { category: 'work', tripActive: true };
    case 'work_end':
      return { category: current.tripActive ? 'drive' : 'rest', tripActive: current.tripActive };
    case 'drive_start':
      return { category: 'drive', tripActive: true };
    case 'drive_end':
      return { category: current.tripActive ? 'work' : 'rest', tripActive: current.tripActive };
    default:
      return current;
  }
}

function appendInterval(
  intervals: InternalInterval[],
  category: RegulationTimelineCategory,
  startMs: number,
  endMs: number,
) {
  if (endMs <= startMs) return;
  const previous = intervals[intervals.length - 1];
  if (previous && previous.category === category && previous.endMs === startMs) {
    previous.endMs = endMs;
    return;
  }
  intervals.push({ category, startMs, endMs });
}

function toWholeMinutes(milliseconds: number): number {
  return Math.max(0, Math.floor(milliseconds / MINUTE_MS));
}

function jstDateKeyFromMs(timestampMs: number): string {
  const date = new Date(timestampMs + JST_OFFSET_MS);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function jstDayEndMs(timestampMs: number): number {
  const dateKey = jstDateKeyFromMs(timestampMs);
  return new Date(`${dateKey}T00:00:00+09:00`).getTime() + DAY_MS;
}

export function buildRegulationTimeline(
  days: ReadonlyArray<Pick<DayRecord, 'events'>>,
  currentTs?: string,
): RegulationTimelineInterval[] {
  const currentMs = currentTs == null ? null : Date.parse(currentTs);
  const hasValidCurrentTs = currentMs != null && Number.isFinite(currentMs);
  let eventOrder = 0;
  const events = days
    .flatMap(day => day.events.map(event => ({
      event,
      timestampMs: Date.parse(event.ts),
      order: eventOrder++,
    })))
    .filter(item => Number.isFinite(item.timestampMs))
    .filter(item => !hasValidCurrentTs || item.timestampMs <= currentMs)
    .sort((a, b) => a.timestampMs - b.timestampMs || a.order - b.order);

  if (events.length === 0) return [];

  const intervals: InternalInterval[] = [];
  let state: TimelineState = { category: 'rest', tripActive: false };
  let cursorMs = events[0].timestampMs;

  for (const { event, timestampMs } of events) {
    if (state.tripActive) {
      appendInterval(intervals, state.category, cursorMs, timestampMs);
    }
    state = stateAfterEvent(event.type, state);
    cursorMs = timestampMs;
  }

  if (hasValidCurrentTs && state.tripActive && currentMs > cursorMs) {
    appendInterval(intervals, state.category, cursorMs, currentMs);
  }

  return intervals.map(interval => ({
    category: interval.category,
    startTs: new Date(interval.startMs).toISOString(),
    endTs: new Date(interval.endMs).toISOString(),
    durationMinutes: (interval.endMs - interval.startMs) / MINUTE_MS,
  }));
}

export function computeContinuousDriveTimeline(
  days: ReadonlyArray<Pick<DayRecord, 'dayIndex' | 'dateKey' | 'events'>>,
  currentTs?: string,
): ContinuousDriveTimelineResult {
  const intervals = buildRegulationTimeline(days, currentTs);
  const dayIndexByDateKey = new Map(days.map(day => [day.dateKey, day.dayIndex]));
  const byDay = new Map<number, ContinuousDriveDayState>(
    days.map(day => [day.dayIndex, {
      longestContinuousDriveMinutes: 0,
      continuousDriveExceeded: false,
      continuousDriveEmergencyExceeded: false,
    }]),
  );
  const resetTimestamps: string[] = [];
  let driveSinceResetMs = 0;
  let qualifyingInterruptionMs = 0;

  for (const interval of intervals) {
    const startMs = Date.parse(interval.startTs);
    const endMs = Date.parse(interval.endTs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;

    if (interval.category === 'drive') {
      let cursorMs = startMs;
      while (cursorMs < endMs) {
        const chunkEndMs = Math.min(endMs, jstDayEndMs(cursorMs));
        driveSinceResetMs += chunkEndMs - cursorMs;
        const dayIndex = dayIndexByDateKey.get(jstDateKeyFromMs(cursorMs));
        const dayState = dayIndex == null ? undefined : byDay.get(dayIndex);
        if (dayState) {
          dayState.longestContinuousDriveMinutes = Math.max(
            dayState.longestContinuousDriveMinutes,
            toWholeMinutes(driveSinceResetMs),
          );
          dayState.continuousDriveExceeded ||= driveSinceResetMs > CONTINUOUS_DRIVE_LIMIT_MS;
          dayState.continuousDriveEmergencyExceeded ||=
            driveSinceResetMs > CONTINUOUS_DRIVE_EMERGENCY_LIMIT_MS;
        }
        cursorMs = chunkEndMs;
      }
      continue;
    }

    if (!QUALIFYING_RESET_CATEGORIES.has(interval.category)) continue;
    const durationMs = endMs - startMs;
    if (durationMs < MIN_QUALIFYING_SEGMENT_MS) continue;

    const remainingResetMs = REQUIRED_RESET_MS - qualifyingInterruptionMs;
    if (durationMs >= remainingResetMs) {
      resetTimestamps.push(new Date(startMs + remainingResetMs).toISOString());
      driveSinceResetMs = 0;
      qualifyingInterruptionMs = 0;
      continue;
    }

    qualifyingInterruptionMs += durationMs;
  }

  return {
    intervals,
    byDay,
    driveSinceResetMinutes: toWholeMinutes(driveSinceResetMs),
    qualifyingInterruptionMinutes: toWholeMinutes(qualifyingInterruptionMs),
    resetTimestamps,
  };
}
