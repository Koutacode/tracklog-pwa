import { computeDayMetrics, computeTripDayMetrics } from './reportLogic';
import {
  buildRegulationTimeline,
  computeContinuousDriveTimeline,
  type ContinuousDriveTimelineResult,
} from './regulationTimeline';
import type { DayRecord, DayMetrics, Trip, TripEvent, TripEventType } from './reportTypes';

type EventInput = {
  type: TripEventType;
  time: string;
  extras?: Record<string, unknown>;
};

function timestamp(dateKey: string, time: string): string {
  return new Date(`${dateKey}T${time}:00+09:00`).toISOString();
}

function makeDay(
  dateKey: string,
  inputs: EventInput[],
  options?: { dayIndex?: number; isFirstDay?: boolean },
): DayRecord {
  const events: TripEvent[] = inputs.map(input => ({
    type: input.type,
    ts: timestamp(dateKey, input.time),
    extras: input.extras,
  }));
  return {
    dayIndex: options?.dayIndex ?? 1,
    dateKey,
    events,
    km: 0,
    odoStart: 0,
    odoEnd: 0,
    isFirstDay: options?.isFirstDay ?? true,
    tripStartMin: null,
    restStartMin: null,
    restPlace: '',
  };
}

function makeTrip(day: DayRecord): Trip {
  return {
    id: `test-${day.dateKey}`,
    createdAt: day.events[0]?.ts ?? timestamp(day.dateKey, '00:00'),
    label: 'regulation timeline fixture',
    days: [day],
    jobs: [],
    rawJson: '{}',
  };
}

function reportTotal(metrics: DayMetrics): number {
  return metrics.driveMinutes
    + metrics.workMinutes
    + metrics.breakMinutes
    + metrics.restMinutes
    + metrics.waitMinutes
    + metrics.loadMinutes
    + metrics.unloadMinutes
    + metrics.ferryMinutes;
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function assertTrue(actual: boolean, message: string) {
  assertEqual(actual, true, message);
}

function calculate(dateKey: string, inputs: EventInput[]): ContinuousDriveTimelineResult {
  return computeContinuousDriveTimeline([makeDay(dateKey, inputs)]);
}

function testTenPlusTenPlusTenResets() {
  const dateKey = '2026-07-01';
  const result = calculate(dateKey, [
    { type: 'trip_start', time: '00:00' },
    { type: 'break_start', time: '01:00' },
    { type: 'break_end', time: '01:10' },
    { type: 'rest_start', time: '01:15' },
    { type: 'rest_end', time: '01:25' },
    { type: 'load_start', time: '01:30' },
    { type: 'load_end', time: '01:40' },
    { type: 'trip_end', time: '01:50' },
  ]);

  assertEqual(result.resetTimestamps.length, 1, '10+10+10 should reset once');
  assertEqual(result.resetTimestamps[0], timestamp(dateKey, '01:40'), '10+10+10 reset timestamp');
  assertEqual(result.qualifyingInterruptionMinutes, 0, 'reset should clear qualifying minutes');
  assertEqual(result.driveSinceResetMinutes, 10, 'driving after 10+10+10 reset');
}

function testFourteenPlusSixteenResets() {
  const dateKey = '2026-07-02';
  const result = calculate(dateKey, [
    { type: 'trip_start', time: '00:00' },
    { type: 'unload_start', time: '00:30' },
    { type: 'unload_end', time: '00:44' },
    { type: 'work_start', time: '00:50' },
    { type: 'work_end', time: '01:06' },
    { type: 'trip_end', time: '01:11' },
  ]);

  assertEqual(result.resetTimestamps.length, 1, '14+16 should reset once');
  assertEqual(result.resetTimestamps[0], timestamp(dateKey, '01:06'), '14+16 reset timestamp');
  assertEqual(result.driveSinceResetMinutes, 5, 'driving after 14+16 reset');
}

function testNineMinuteSegmentIsExcluded() {
  const dateKey = '2026-07-03';
  const result = calculate(dateKey, [
    { type: 'trip_start', time: '00:00' },
    { type: 'break_start', time: '00:30' },
    { type: 'break_end', time: '00:40' },
    { type: 'rest_start', time: '00:45' },
    { type: 'rest_end', time: '00:54' },
    { type: 'load_start', time: '01:00' },
    { type: 'load_end', time: '01:10' },
    { type: 'trip_end', time: '01:15' },
  ]);

  assertEqual(result.resetTimestamps.length, 0, '9-minute segment must not complete reset');
  assertEqual(result.qualifyingInterruptionMinutes, 20, 'only two 10-minute segments should count');
}

function testOneMinuteMarkerAffectsOnlyReport() {
  const dateKey = '2026-07-04';
  const marker = { reportMinDurationMinutes: 15, breakSessionId: 'new-break' };
  const markedDay = makeDay(dateKey, [
    { type: 'trip_start', time: '08:00' },
    { type: 'break_start', time: '08:01', extras: marker },
    { type: 'break_end', time: '08:02', extras: { breakSessionId: 'new-break' } },
    { type: 'trip_end', time: '08:03' },
  ]);
  const legacyDay = makeDay(dateKey, [
    { type: 'trip_start', time: '08:00' },
    { type: 'break_start', time: '08:01', extras: { breakSessionId: 'legacy-break' } },
    { type: 'break_end', time: '08:02', extras: { breakSessionId: 'legacy-break' } },
    { type: 'trip_end', time: '08:03' },
  ]);

  const markedReport = computeDayMetrics(markedDay);
  const legacyReport = computeDayMetrics(legacyDay);
  const regulation = computeContinuousDriveTimeline([markedDay]);
  const rawBreak = regulation.intervals.find(interval => interval.category === 'break');

  assertEqual(markedReport.breakMinutes, 15, 'marker should make the daily report show 15 minutes');
  assertEqual(legacyReport.breakMinutes, 0, 'legacy event without marker must not be forced to 15 minutes');
  assertEqual(rawBreak?.durationMinutes, 1, 'regulation timeline must retain the raw one-minute interval');
  assertEqual(regulation.qualifyingInterruptionMinutes, 0, 'one-minute operation contributes zero reset minutes');
}

function testContinuousDriveUsesRawTimestamps() {
  const dateKey = '2026-07-05';
  const day = makeDay(dateKey, [
    { type: 'trip_start', time: '08:07' },
    {
      type: 'break_start',
      time: '12:08',
      extras: { reportMinDurationMinutes: 15, breakSessionId: 'raw-break' },
    },
    { type: 'break_end', time: '12:09', extras: { breakSessionId: 'raw-break' } },
    { type: 'trip_end', time: '12:09' },
  ]);
  const metrics = computeTripDayMetrics(makeTrip(day))[0];

  assertEqual(metrics.driveMinutes, 255, 'daily report should use quarter-hour boundaries');
  assertEqual(metrics.longestContinuousDriveMinutes, 241, 'continuous drive should use raw timestamps');
  assertTrue(metrics.continuousDriveExceeded, '241 raw minutes should exceed four hours');
}

function testFinalizedAndInProgressDayTotals() {
  const dateKey = '2026-07-06';
  const day = makeDay(
    dateKey,
    [
      { type: 'rest_end', time: '06:00' },
      { type: 'rest_start', time: '18:00' },
    ],
    { dayIndex: 2, isFirstDay: false },
  );
  const finalized = computeDayMetrics(day);
  const inProgress = computeDayMetrics(day, timestamp(dateKey, '12:07'));

  assertEqual(reportTotal(finalized), 24 * 60, 'finalized ordinary day should total 24 hours');
  assertEqual(reportTotal(inProgress), 12 * 60, 'in-progress day should remain provisional through currentTs');
}

function testLateStaleLoadEndDoesNotEndRest() {
  const restStartedAt = '2026-07-27T11:00:21.341Z';
  const day: DayRecord = {
    ...makeDay('2026-07-27', []),
    events: [
      { type: 'trip_start', ts: '2026-07-27T00:00:00.000Z' },
      { type: 'load_start', ts: '2026-07-27T04:21:01.054Z', extras: { loadSessionId: 'load-a' } },
      { type: 'load_end', ts: '2026-07-27T07:23:33.195Z', extras: { loadSessionId: 'load-b' } },
      { type: 'load_start', ts: '2026-07-27T08:05:34.046Z', extras: { loadSessionId: 'load-c' } },
      { type: 'load_end', ts: '2026-07-27T09:22:22.273Z', extras: { loadSessionId: 'load-c' } },
      { type: 'rest_start', ts: restStartedAt, extras: { restSessionId: 'rest-1' } },
      { type: 'load_end', ts: '2026-07-27T11:00:40.498Z', extras: { loadSessionId: 'load-a' } },
    ],
  };

  const intervals = buildRegulationTimeline([day], '2026-07-27T12:00:00.000Z');
  const finalInterval = intervals[intervals.length - 1];
  const loadIntervals = intervals.filter(interval => interval.category === 'load');

  assertEqual(loadIntervals.length, 2, 'only the two accepted load pairs should create intervals');
  assertEqual(finalInterval?.category, 'rest', 'late stale load_end must not switch rest to drive');
  assertEqual(finalInterval?.startTs, restStartedAt, 'rest interval must keep its real start timestamp');
  assertEqual(finalInterval?.endTs, '2026-07-27T12:00:00.000Z', 'rest should continue through currentTs');
}

function testCrossMidnightPairingKeepsRestActive() {
  const firstDay: DayRecord = {
    ...makeDay('2026-07-27', [], { dayIndex: 1, isFirstDay: true }),
    events: [
      { type: 'trip_start', ts: '2026-07-27T14:50:00.000Z' },
      { type: 'load_start', ts: '2026-07-27T14:55:00.000Z', extras: { loadSessionId: 'load-a' } },
    ],
  };
  const secondDay: DayRecord = {
    ...makeDay('2026-07-28', [], { dayIndex: 2, isFirstDay: false }),
    events: [
      { type: 'load_end', ts: '2026-07-27T15:05:00.000Z', extras: { loadSessionId: 'load-b' } },
      { type: 'rest_start', ts: '2026-07-27T15:10:00.000Z', extras: { restSessionId: 'rest-1' } },
      { type: 'load_end', ts: '2026-07-27T15:11:00.000Z', extras: { loadSessionId: 'load-a' } },
    ],
  };

  const intervals = buildRegulationTimeline(
    [firstDay, secondDay],
    '2026-07-27T16:00:00.000Z',
  );
  const loadInterval = intervals.find(interval => interval.category === 'load');
  const finalInterval = intervals[intervals.length - 1];

  assertEqual(loadInterval?.startTs, '2026-07-27T14:55:00.000Z', 'cross-midnight load start');
  assertEqual(loadInterval?.endTs, '2026-07-27T15:05:00.000Z', 'cross-midnight load end');
  assertEqual(finalInterval?.category, 'rest', 'cross-midnight stale end must not end rest');
  assertEqual(finalInterval?.startTs, '2026-07-27T15:10:00.000Z', 'cross-midnight rest start');
}

const tests: Array<[string, () => void]> = [
  ['10+10+10 reset', testTenPlusTenPlusTenResets],
  ['14+16 reset', testFourteenPlusSixteenResets],
  ['9-minute exclusion', testNineMinuteSegmentIsExcluded],
  ['one-minute report marker isolation', testOneMinuteMarkerAffectsOnlyReport],
  ['raw continuous drive timestamps', testContinuousDriveUsesRawTimestamps],
  ['finalized and provisional day totals', testFinalizedAndInProgressDayTotals],
  ['late stale load_end keeps regulation rest active', testLateStaleLoadEndDoesNotEndRest],
  ['cross-midnight pairing keeps regulation rest active', testCrossMidnightPairingKeepsRestActive],
];

export function runRegulationTimelineTests() {
  for (const [, test] of tests) test();
  console.log(`regulationTimeline: ${tests.length} tests passed`);
}

runRegulationTimelineTests();
