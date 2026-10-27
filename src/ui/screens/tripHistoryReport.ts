import type { AppEvent } from '../../domain/types';
import { DAY_MS, getJstDateInfo } from '../../domain/jst';
import { ALL_TOGGLE_DEFINITIONS, resolveTogglePairing } from '../../domain/togglePairing';

export type HistoryCategory = 'drive' | 'work' | 'break' | 'ferry' | 'rest';

export type HistorySegment = {
  startMinute: number;
  endMinute: number;
  category: HistoryCategory | null;
};

export type HistoryDay = {
  dayIndex: number;
  dateKey: string;
  startMinute: number;
  endMinute: number;
  segments: HistorySegment[];
  totals: Record<HistoryCategory, number>;
  unknownMinutes: number;
  events: AppEvent[];
  effectiveMinutes: Record<string, number>;
  effectiveTimestamps: Record<string, string>;
  ongoing: boolean;
};

export type HistoryProjectedEvent = { event: AppEvent; effectiveTs: string };

type Interval = { start: number; end: number; category: HistoryCategory | null };
const MINUTE_MS = 60_000;
const QUARTER_MS = 15 * MINUTE_MS;
const CATEGORIES: HistoryCategory[] = ['drive', 'work', 'break', 'ferry', 'rest'];
const HISTORY_PAIRS = ALL_TOGGLE_DEFINITIONS.filter(definition => (
  ['load', 'unload', 'work', 'wait', 'break', 'rest', 'ferry'].includes(definition.channel)
));
const NON_DRIVING_TYPES = new Set<string>(
  HISTORY_PAIRS.flatMap(definition => [definition.start, definition.end]),
);

function roundBoundary(timestamp: number): number {
  return Math.floor((timestamp + QUARTER_MS / 2) / QUARTER_MS) * QUARTER_MS;
}

function categoryForChannel(channel: string): HistoryCategory {
  return channel === 'load' || channel === 'unload' || channel === 'work' || channel === 'wait'
    ? 'work'
    : channel as 'break' | 'rest' | 'ferry';
}

function minimumDurationMs(event: AppEvent): number {
  const requested = Number(event.extras?.reportMinDurationMinutes);
  const minutes = Number.isFinite(requested) && requested > 0 ? requested : 15;
  return Math.min(1440, Math.max(15, Math.ceil(minutes / 15) * 15)) * MINUTE_MS;
}

function projectBoundaries(events: readonly AppEvent[]) {
  const originals = new Map(events.map(event => [event.id, event] as const));
  const normalized = events.filter(event => Number.isFinite(Date.parse(event.ts)))
    .map(event => ({ ...event, ts: new Date(Date.parse(event.ts)).toISOString() }));
  const pairing = resolveTogglePairing(normalized, HISTORY_PAIRS);
  const startsByEnd = new Map(pairing.pairs.map(pair => [pair.end, pair.start] as const));
  const effectiveByEvent = new Map<AppEvent, number>();
  const projected: HistoryProjectedEvent[] = [];
  let cursor = Number.NEGATIVE_INFINITY;
  // The trip anchor must precede an activity recorded at the same instant.
  // Its end must follow that activity's minimum-duration display correction.
  // Stable sorting preserves the pairing resolver's causal order otherwise.
  const anchorPhase = (event: AppEvent) => event.type === 'trip_start' ? -1 : event.type === 'trip_end' ? 1 : 0;
  const ordered = [...pairing.rawEvents].sort((a, b) => (
    Date.parse(a.ts) - Date.parse(b.ts) || anchorPhase(a) - anchorPhase(b)
  ));
  // A ferry and its concurrent rest can both be recorded as zero-length
  // pairs. Project their starts before either end so the minimum is shared,
  // rather than turning the same instant into consecutive rest and ferry.
  // Only these accepted zero-length pairs move; other channel order and each
  // channel's own start/end order remain the resolver's causal order.
  const zeroFerryRest = new Map<string, typeof pairing.pairs>();
  for (const pair of pairing.pairs) {
    if ((pair.definition.channel !== 'ferry' && pair.definition.channel !== 'rest') || pair.start.ts !== pair.end.ts) continue;
    const group = zeroFerryRest.get(pair.start.ts) ?? [];
    group.push(pair);
    zeroFerryRest.set(pair.start.ts, group);
  }
  for (const group of zeroFerryRest.values()) {
    if (new Set(group.map(pair => pair.definition.channel)).size !== 2) continue;
    const starts = new Set(group.map(pair => pair.start));
    const members = new Set(group.flatMap(pair => [pair.start, pair.end]));
    const indexes = ordered.flatMap((event, index) => members.has(event) ? [index] : []);
    const sharedOrder = indexes.map(index => ordered[index])
      .sort((a, b) => Number(starts.has(b)) - Number(starts.has(a)));
    indexes.forEach((index, position) => { ordered[index] = sharedOrder[position]; });
  }
  for (const event of ordered) {
    let boundary = Math.max(roundBoundary(Date.parse(event.ts)), cursor);
    const start = startsByEnd.get(event);
    if (start) {
      const startBoundary = effectiveByEvent.get(start);
      if (startBoundary != null) boundary = Math.max(boundary, startBoundary + minimumDurationMs(start));
    }
    effectiveByEvent.set(event, boundary);
    projected.push({ event: originals.get(event.id) ?? event, effectiveTs: new Date(boundary).toISOString() });
    cursor = boundary;
  }
  return { pairing, effectiveByEvent, projected };
}

/** The same absolute boundary projection used by both history rows and graphs. */
export function projectTripHistoryEvents(events: readonly AppEvent[]): HistoryProjectedEvent[] {
  return projectBoundaries(events).projected;
}

function pushInterval(intervals: Interval[], start: number, end: number, category: HistoryCategory | null) {
  if (end <= start) return;
  const previous = intervals[intervals.length - 1];
  if (previous?.end === start && previous.category === category) previous.end = end;
  else intervals.push({ start, end, category });
}

/**
 * Read-only history display. Raw timestamps and the report/sync projections are
 * deliberately untouched. Only this view applies the owner's five categories
 * and shared quarter-hour boundaries. Paired activity lasts at least 15 display
 * minutes; subsequent boundaries move together without rewriting actual time.
 */
export function buildTripHistoryDays(
  events: readonly AppEvent[],
  currentTs?: string,
  tripId?: string,
): HistoryDay[] {
  const identities = new Set(events.map(event => event.tripId));
  const selectedTripId = tripId ?? (identities.size === 1 ? events[0]?.tripId : undefined);
  if (selectedTripId == null) return [];
  const source = events.filter(event => event.tripId === selectedTripId);
  const starts = source.filter(event => event.type === 'trip_start');
  const ends = source.filter(event => event.type === 'trip_end');
  const startTimes = new Set(starts.map(event => Date.parse(event.ts)));
  const endTimes = new Set(ends.map(event => Date.parse(event.ts)));
  // Identical timestamp duplicates do not change the boundary. Contradictory
  // or malformed boundaries cannot establish a completed/active trip window.
  if (startTimes.size !== 1 || [...startTimes].some(value => !Number.isFinite(value))) return [];
  if (endTimes.size > 1 || [...endTimes].some(value => !Number.isFinite(value))) return [];
  const tripStart = [...startTimes][0];
  const validEvents = source.filter(event => Number.isFinite(Date.parse(event.ts)))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.id.localeCompare(b.id));
  const ongoing = ends.length === 0;
  const current = currentTs == null ? Number.NaN : Date.parse(currentTs);
  const latestRecorded = validEvents.reduce((latest, event) => Math.max(latest, Date.parse(event.ts)), tripStart);
  const tripEnd = ongoing
    ? (currentTs == null ? latestRecorded : current)
    : [...endTimes][0];
  if (!Number.isFinite(tripEnd) || tripEnd < tripStart) return [];

  // Pairing copies are normalized; all returned event objects retain raw ts.
  const calculationEvents = validEvents.filter(event => Date.parse(event.ts) >= tripStart && Date.parse(event.ts) <= tripEnd);
  const { pairing, effectiveByEvent, projected } = projectBoundaries(calculationEvents);
  const displayStarts = projected.filter(item => item.event.type === 'trip_start').map(item => Date.parse(item.effectiveTs));
  const displayEnds = projected.filter(item => item.event.type === 'trip_end').map(item => Date.parse(item.effectiveTs));
  const roundedStart = Math.min(...displayStarts);
  const roundedEnd = ongoing
    ? Math.max(roundBoundary(tripEnd), ...projected.map(item => Date.parse(item.effectiveTs)))
    : Math.max(...displayEnds);
  const known: Interval[] = [];
  const unknown: Interval[] = [];
  const clip = (start: number, end: number, category: HistoryCategory | null, destination: Interval[]) => {
    const from = Math.max(roundedStart, start), to = Math.min(roundedEnd, end);
    if (to > from) destination.push({ start: from, end: to, category });
  };
  for (const pair of pairing.pairs) {
    clip(effectiveByEvent.get(pair.start)!, effectiveByEvent.get(pair.end)!, categoryForChannel(pair.definition.channel), known);
  }
  for (const open of pairing.openStarts) {
    clip(Math.min(Date.parse(open.start.ts), effectiveByEvent.get(open.start)!), roundedEnd, null, unknown);
  }
  for (const excluded of pairing.excludedEnds) {
    if (excluded.reason === 'orphan_end') clip(roundedStart, Math.max(Date.parse(excluded.end.ts), effectiveByEvent.get(excluded.end)!), null, unknown);
  }
  // A malformed duration record cannot safely be reclassified as driving.
  if (source.some(event => NON_DRIVING_TYPES.has(event.type) && !Number.isFinite(Date.parse(event.ts)))) {
    clip(roundedStart, roundedEnd, null, unknown);
  }

  const boundaries = [...new Set([
    roundedStart, roundedEnd,
    ...known.flatMap(interval => [interval.start, interval.end]),
    ...unknown.flatMap(interval => [interval.start, interval.end]),
  ])].sort((a, b) => a - b);
  const rawSegments: Interval[] = [];
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const start = boundaries[index], end = boundaries[index + 1];
    if (unknown.some(interval => interval.start < end && interval.end > start)) {
      pushInterval(rawSegments, start, end, null);
      continue;
    }
    const active = new Set(known.filter(interval => interval.start <= start && interval.end >= end)
      .map(interval => interval.category));
    if (active.has('ferry')) active.delete('rest');
    // Same-category overlap is a union; conflicting non-driving categories
    // remain unknown. Ferry overrides only rest, not another kind of work.
    const category = active.size > 1 ? null : active.size === 1 ? [...active][0] : 'drive';
    pushInterval(rawSegments, start, end, category);
  }

  const rounded = rawSegments.filter(interval => interval.category !== null).map(interval => ({
    ...interval,
    start: roundBoundary(interval.start),
    end: roundBoundary(interval.end),
  }));
  // Never round uncertainty out of existence: reserve every touched slot.
  const uncertain = rawSegments.filter(interval => interval.category === null).map(interval => ({
    start: Math.floor(interval.start / QUARTER_MS) * QUARTER_MS,
    end: Math.ceil(interval.end / QUARTER_MS) * QUARTER_MS,
  }));
  const firstDay = getJstDateInfo(new Date(tripStart).toISOString());
  const lastDay = getJstDateInfo(new Date(Math.max(tripEnd, roundedEnd)).toISOString());
  const result: HistoryDay[] = [];
  for (let stamp = firstDay.dayStamp; stamp <= lastDay.dayStamp; stamp += DAY_MS) {
    const dateKey = new Date(stamp).toISOString().slice(0, 10);
    const dayStart = Date.parse(`${dateKey}T00:00:00+09:00`);
    const windowStart = Math.min(1440, Math.max(0, (roundedStart - dayStart) / MINUTE_MS));
    const windowEnd = Math.min(1440, Math.max(windowStart, (roundedEnd - dayStart) / MINUTE_MS));
    const totals = Object.fromEntries(CATEGORIES.map(category => [category, 0])) as Record<HistoryCategory, number>;
    const segments: HistorySegment[] = [];
    let unknownMinutes = 0;
    for (let slot = 0; slot < 96; slot += 1) {
      const start = dayStart + slot * QUARTER_MS, end = start + QUARTER_MS;
      const inTrip = start >= roundedStart && end <= roundedEnd;
      const isUnknown = uncertain.some(interval => interval.start < end && interval.end > start);
      const active = inTrip && !isUnknown
        ? rounded.filter(interval => interval.start <= start && interval.end >= end)
        : [];
      const category = active.length === 1 ? active[0].category : null;
      if (category) totals[category] += 15;
      else if (inTrip) unknownMinutes += 15;
      const previous = segments[segments.length - 1];
      if (previous?.category === category) previous.endMinute = (slot + 1) * 15;
      else segments.push({ startMinute: slot * 15, endMinute: (slot + 1) * 15, category });
    }
    const projectedDay = projected.filter(item => getJstDateInfo(item.effectiveTs).dateKey === dateKey);
    result.push({
      dayIndex: result.length + 1,
      dateKey,
      startMinute: windowStart,
      endMinute: windowEnd,
      segments,
      totals,
      unknownMinutes,
      events: projectedDay.map(item => item.event),
      effectiveMinutes: Object.fromEntries(projectedDay.map(item => [item.event.id, (Date.parse(item.effectiveTs) - dayStart) / MINUTE_MS])),
      effectiveTimestamps: Object.fromEntries(projectedDay.map(item => [item.event.id, item.effectiveTs])),
      ongoing,
    });
  }
  return result;
}
