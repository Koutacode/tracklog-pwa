import assert from 'node:assert/strict';
import type { AppEvent, EventType } from '../../domain/types';
import { buildTripHistoryDays, projectTripHistoryEvents, type HistoryDay } from './tripHistoryReport';

let sequence = 0;
function event(type: EventType, local: string, extras?: Record<string, unknown>, tripId = 'fixture-trip'): AppEvent {
  return { id: `event-${++sequence}`, tripId, type, ts: local, syncStatus: 'synced', ...(extras ? { extras } : {}) };
}
const ts = (time: string, date = '2026-11-03') => `${date}T${time}+09:00`;
function total(day: HistoryDay) {
  return Object.values(day.totals).reduce((sum, minutes) => sum + minutes, 0);
}
function assertDay(day: HistoryDay) {
  assert.equal(day.segments[0]?.startMinute, 0);
  assert.equal(day.segments[day.segments.length - 1]?.endMinute, 1440);
  assert.equal(day.segments.reduce((sum, segment) => sum + segment.endMinute - segment.startMinute, 0), 1440);
  for (const [index, segment] of day.segments.entries()) {
    assert.equal(segment.startMinute % 15, 0);
    assert.equal(segment.endMinute % 15, 0);
    assert.ok(segment.endMinute > segment.startMinute);
    if (index > 0) assert.equal(day.segments[index - 1].endMinute, segment.startMinute);
  }
  assert.equal(total(day) + day.unknownMinutes, day.endMinute - day.startMinute);
}

const exact = [
  event('trip_start', ts('08:07:30.000')),
  event('load_start', ts('09:07:29.999')),
  event('load_end', ts('10:07:30.000')),
  event('trip_end', ts('12:07:29.999')),
];
const snapshot = JSON.stringify(exact);
for (const item of exact) Object.freeze(item);
Object.freeze(exact);
const exactDay = buildTripHistoryDays(exact)[0];
assertDay(exactDay);
assert.equal(exactDay.startMinute, 8 * 60 + 15, 'half-quarter boundary rounds up');
assert.equal(exactDay.endMinute, 12 * 60, 'less than half-quarter rounds down');
assert.equal(exactDay.totals.work, 75, 'duration comes from shared boundaries');
assert.equal(exactDay.totals.drive, 150);
assert.equal(exactDay.events[0].ts, ts('08:07:30.000'), 'raw records retain seconds and offset');
assert.equal(JSON.stringify(exact), snapshot, 'input order and events are immutable');

const multi = [
  event('trip_start', ts('23:50:00', '2026-11-03')),
  event('rest_start', ts('23:55:00', '2026-11-03'), { restSessionId: 'night' }),
  event('rest_end', ts('01:10:00', '2026-11-06'), { restSessionId: 'night' }),
  event('trip_end', ts('02:05:00', '2026-11-06')),
];
const days = buildTripHistoryDays([...multi].reverse());
assert.equal(days.length, 4, 'all JST calendar days, including event-free days, are present');
days.forEach(assertDay);
assert.equal(days[0].startMinute, 1425);
assert.equal(days[1].totals.rest, 1440);
assert.equal(days[2].totals.rest, 1440);
assert.equal(days[3].endMinute, 120);
assert.equal(total(days[3]), 120, 'last day does not invent post-trip rest');
assert.equal(days[0].events[0].type, 'trip_start', 'event sorting does not depend on input order');

const simultaneous = [
  event('trip_start', ts('00:00:00')),
  event('rest_start', ts('02:00:00'), { restSessionId: 'rest' }),
  event('boarding', ts('03:00:00'), { ferrySessionId: 'ferry' }),
  event('disembark', ts('05:00:00'), { ferrySessionId: 'ferry' }),
  event('rest_end', ts('06:00:00'), { restSessionId: 'rest' }),
  event('load_start', ts('07:00:00'), { loadSessionId: 'load' }),
  event('work_start', ts('07:30:00'), { workSessionId: 'work' }),
  event('load_end', ts('08:00:00'), { loadSessionId: 'load' }),
  event('work_end', ts('08:30:00'), { workSessionId: 'work' }),
  event('trip_end', ts('00:00:00', '2026-11-04')),
];
const categoryDay = buildTripHistoryDays(simultaneous)[0];
assertDay(categoryDay);
assert.equal(categoryDay.totals.ferry, 120, 'ferry takes display priority over rest');
assert.equal(categoryDay.totals.rest, 120, 'ferry/rest is counted once');
assert.equal(categoryDay.totals.work, 90, 'same-category overlap is a union');
assert.equal(total(categoryDay), 1440);

const conflict = [
  event('trip_start', ts('08:00:00')),
  event('load_start', ts('09:01:00'), { loadSessionId: 'conflict' }),
  event('break_start', ts('09:02:00'), { breakSessionId: 'conflict' }),
  event('break_end', ts('09:03:00'), { breakSessionId: 'conflict' }),
  event('load_end', ts('10:00:00'), { loadSessionId: 'conflict' }),
  event('trip_end', ts('11:00:00')),
];
const conflictDay = buildTripHistoryDays(conflict)[0];
assertDay(conflictDay);
assert.equal(conflictDay.unknownMinutes, 15, 'a short raw conflict cannot disappear through rounding');
assert.equal(conflictDay.totals.work, 45);
assert.equal(conflictDay.totals.drive, 120);

const unclosed = [event('trip_start', ts('08:00:00')), event('break_start', ts('09:03:00')), event('trip_end', ts('12:00:00'))];
const openDay = buildTripHistoryDays(unclosed)[0];
assertDay(openDay);
assert.equal(openDay.totals.drive, 60);
assert.equal(openDay.unknownMinutes, 180, 'unfinished non-driving session is not filled as driving');

const tiny = [event('trip_start', ts('08:00:00')), event('load_start', ts('09:01:00')), event('load_end', ts('09:02:00')), event('trip_end', ts('10:00:00'))];
const tinyDay = buildTripHistoryDays(tiny)[0];
assertDay(tinyDay);
assert.equal(tinyDay.totals.work, 15, 'legacy short work receives the owner-requested 15 display minutes');
assert.equal(tinyDay.totals.drive, 105, 'later driving absorbs the minimum-duration correction');
assert.equal(tinyDay.events.length, 4, 'short events remain available at actual times');

const midnight = [
  event('trip_start', ts('23:45:00')),
  event('load_start', ts('23:58:00'), { reportMinDurationMinutes: 15 }),
  event('load_end', ts('00:01:00', '2026-11-04')),
  event('trip_end', ts('00:02:00', '2026-11-04')),
];
const midnightDays = buildTripHistoryDays(midnight);
midnightDays.forEach(assertDay);
assert.equal(midnightDays.length, 2);
assert.equal(midnightDays[0].totals.drive, 15);
assert.equal(midnightDays[1].totals.work, 15);
assert.equal(midnightDays[1].endMinute, 15);
assert.equal(midnightDays[1].effectiveMinutes[midnight[1].id], 0, 'rounded start row moves into the projected JST day');
assert.equal(midnightDays[1].effectiveMinutes[midnight[2].id], 15, 'row and graph use the same extended end');
assert.equal(midnightDays[1].effectiveMinutes[midnight[3].id], 15, 'trip display end follows the same cursor');
assert.equal(midnightDays[1].events[midnightDays[1].events.length - 1]?.ts, ts('00:02:00', '2026-11-04'), 'actual trip_end is never overwritten');
const sharedProjection = projectTripHistoryEvents(midnight);
for (const projected of sharedProjection) {
  const day = midnightDays.find(candidate => projected.event.id in candidate.effectiveTimestamps)!;
  assert.equal(day.effectiveTimestamps[projected.event.id], projected.effectiveTs, 'standalone export matches history projection');
  assert.ok(midnight.includes(projected.event), 'projection returns original record objects');
}

const anchored = [
  event('trip_end', ts('08:00:00')),
  event('load_end', ts('08:00:00')),
  event('trip_start', ts('08:00:00')),
  event('load_start', ts('08:00:00')),
];
const anchorDay = buildTripHistoryDays(anchored)[0];
assertDay(anchorDay);
assert.equal(anchorDay.startMinute, 480, 'simultaneous trip_start remains the initial anchor');
assert.equal(anchorDay.endMinute, 495, 'simultaneous trip_end receives the paired minimum');
assert.equal(anchorDay.totals.work, 15, 'work at the trip boundary cannot be clipped away');

const dual = [
  event('trip_start', ts('08:00:00')),
  event('rest_start', ts('09:01:00')),
  event('boarding', ts('09:01:00')),
  event('rest_end', ts('09:02:00')),
  event('disembark', ts('09:02:00')),
  event('trip_end', ts('09:03:00')),
];
const dualDay = buildTripHistoryDays(dual)[0];
assertDay(dualDay);
assert.equal(dualDay.totals.ferry, 15, 'simultaneous ferry and rest share one extended boundary');
assert.equal(dualDay.totals.rest, 0);
assert.equal(dualDay.endMinute, 555, 'the same 15-minute correction is not counted twice');

const zeroFerryRest = [
  event('trip_start', ts('08:00:00')),
  event('rest_start', ts('09:00:00')),
  event('boarding', ts('09:00:00')),
  event('rest_end', ts('09:00:00')),
  event('disembark', ts('09:00:00')),
  event('trip_end', ts('09:00:00')),
];
const zeroFerryRestDay = buildTripHistoryDays(zeroFerryRest)[0];
assertDay(zeroFerryRestDay);
assert.equal(zeroFerryRestDay.totals.ferry, 15, 'zero-length ferry/rest share one minimum-duration display interval');
assert.equal(zeroFerryRestDay.totals.rest, 0);
assert.equal(zeroFerryRestDay.endMinute, 555, 'simultaneous zero-length pairs do not extend the trip twice');
assert.equal(zeroFerryRestDay.effectiveMinutes[zeroFerryRest[1].id], 540);
assert.equal(zeroFerryRestDay.effectiveMinutes[zeroFerryRest[2].id], 540);
assert.equal(zeroFerryRestDay.effectiveMinutes[zeroFerryRest[3].id], 555);
assert.equal(zeroFerryRestDay.effectiveMinutes[zeroFerryRest[4].id], 555);
assert.deepEqual(buildTripHistoryDays([...zeroFerryRest].reverse()), [zeroFerryRestDay], 'DB input order does not change concurrent zero-pair projection');

const otherZeroPairs = [
  event('trip_start', ts('08:00:00')),
  event('rest_start', ts('09:00:00')),
  event('load_start', ts('09:00:00')),
  event('rest_end', ts('09:00:00')),
  event('load_end', ts('09:00:00')),
  event('trip_end', ts('09:00:00')),
];
const otherZeroDay = buildTripHistoryDays(otherZeroPairs)[0];
assertDay(otherZeroDay);
assert.equal(otherZeroDay.totals.rest, 15);
assert.equal(otherZeroDay.totals.work, 15);
assert.equal(otherZeroDay.endMinute, 570, 'other zero-length channels retain the existing causal block order');

const chain = [
  event('trip_start', ts('08:00:00')),
  event('work_start', ts('09:01:00'), { reportMinDurationMinutes: 20 }),
  event('work_end', ts('09:02:00')),
  event('refuel', ts('09:03:00')),
  event('unload_start', ts('09:04:00')),
  event('unload_end', ts('09:05:00')),
  event('trip_end', ts('09:06:00')),
];
const chainDay = buildTripHistoryDays(chain)[0];
assertDay(chainDay);
assert.equal(chainDay.totals.work, 45, 'a positive duration marker rounds up to a quarter, then the next pair receives its minimum');
assert.equal(chainDay.endMinute, 585);
assert.equal(chainDay.effectiveMinutes[chain[3].id], 570, 'instant refuel follows the cursor without adding a duration');

const activeOpen = [event('trip_start', ts('08:00:00')), event('work_start', ts('09:01:00'), { reportMinDurationMinutes: 120 })];
const activeOpenDay = buildTripHistoryDays(activeOpen, ts('09:03:00'))[0];
assertDay(activeOpenDay);
assert.equal(activeOpenDay.endMinute, 540, 'an unclosed start never extends the observed end');
assert.equal(activeOpenDay.totals.work, 0, 'an unclosed activity is never manufactured into a closed duration');
assert.equal(activeOpenDay.events.length, 2);

const automatic = [
  event('trip_start', ts('01:00:00')),
  { ...event('break_start', ts('02:00:00'), { breakSessionId: 'auto' }), id: 'source-break' },
  event('break_end', ts('05:00:00'), { breakSessionId: 'auto', autoReason: 'break_3h_threshold', generatedFrom: 'source-break' }),
  event('rest_start', ts('05:00:00'), { restSessionId: 'auto-rest', autoReason: 'break_3h_threshold', generatedFrom: 'source-break' }),
  event('rest_end', ts('06:00:00'), { restSessionId: 'auto-rest' }),
  event('trip_end', ts('07:00:00')),
];
const automaticDay = buildTripHistoryDays(automatic)[0];
assertDay(automaticDay);
assert.equal(automaticDay.totals.break, 180, 'history respects the raw three-hour break');
assert.equal(automaticDay.totals.rest, 60, 'history does not project the rest backwards');

const mixed = [...tiny, event('trip_start', ts('01:00:00'), undefined, 'other-trip'), event('trip_end', ts('23:00:00'), undefined, 'other-trip')];
assert.deepEqual(buildTripHistoryDays(mixed), [], 'mixed trips need an explicit identity');
assert.equal(buildTripHistoryDays(mixed, undefined, 'fixture-trip')[0].events.length, 4);
assert.deepEqual(buildTripHistoryDays(mixed, undefined, 'missing-trip'), []);
assert.deepEqual(buildTripHistoryDays([event('trip_end', ts('12:00:00'))]), [], 'missing start never invents a day');
assert.deepEqual(buildTripHistoryDays([...tiny, event('trip_start', ts('07:00:00'))]), [], 'conflicting starts cannot establish a window');
assert.deepEqual(buildTripHistoryDays([...tiny, event('trip_end', ts('11:00:00'))]), [], 'conflicting ends are not silently resolved');

const ongoing = buildTripHistoryDays([event('trip_start', ts('08:00:00'))], ts('10:06:00'))[0];
assertDay(ongoing);
assert.equal(ongoing.ongoing, true);
assert.equal(ongoing.endMinute, 600);
assert.equal(ongoing.totals.drive, 120, 'ongoing view stops at the supplied observation boundary');
assert.equal(ongoing.events.length, 1, 'ongoing view creates no trip_end event');
assert.deepEqual(buildTripHistoryDays([event('trip_start', ts('08:00:00'))], 'invalid'), []);
assert.equal(buildTripHistoryDays(tiny, ts('23:00:00'))[0].endMinute, 600, 'current clock never extends a completed trip');

const offsetInputs = [event('trip_start', '2026-11-02T23:00:00Z'), event('load_start', ts('09:00:00')), event('load_end', '2026-11-03T01:00:00Z'), event('trip_end', ts('11:00:00'))];
const offsetDay = buildTripHistoryDays(offsetInputs)[0];
assertDay(offsetDay);
assert.equal(offsetDay.dateKey, '2026-11-03', 'day grouping is explicitly JST');
assert.equal(offsetDay.totals.work, 60, 'UTC and +09:00 event spellings pair in chronological order');
assert.equal(offsetDay.events[0].ts, '2026-11-02T23:00:00Z');

const broken = [event('trip_start', ts('08:00:00')), event('work_start', 'not-a-date'), event('trip_end', ts('10:00:00'))];
assert.equal(buildTripHistoryDays(broken)[0].unknownMinutes, 120, 'invalid work timestamps never become inferred driving');

console.log('tripHistoryReport: quarter-hour history, raw records, boundaries and uncertainty passed');
