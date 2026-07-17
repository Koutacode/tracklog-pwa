import {
  computeDayMetrics,
  computeTripDayMetrics,
  formatReportMinute,
  formatRoundedJstTime,
  projectReportTimeline,
  projectTripReportTimelines,
} from './reportLogic';
import { computeContinuousDriveTimeline } from './regulationTimeline';
import type { DayRecord, Trip, TripEvent, TripEventType } from './reportTypes';

type EventInput = {
  type: TripEventType;
  time: string;
  extras?: Record<string, unknown>;
};

function timestamp(dateKey: string, time: string): string {
  return new Date(`${dateKey}T${time}:00+09:00`).toISOString();
}

function makeDay(dateKey: string, inputs: EventInput[]): DayRecord {
  const events: TripEvent[] = inputs.map(input => ({
    type: input.type,
    ts: timestamp(dateKey, input.time),
    extras: input.extras,
  }));
  return {
    dayIndex: 1,
    dateKey,
    events,
    km: 0,
    odoStart: 0,
    odoEnd: 0,
    isFirstDay: true,
    tripStartMin: null,
    restStartMin: null,
    restPlace: '',
  };
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function projectedTimes(day: DayRecord): string[] {
  return projectReportTimeline(day).map(item => formatRoundedJstTime(item.effectiveTs));
}

function testShortLoadUsesReportMinimum() {
  const dateKey = '2026-07-10';
  const sessionId = 'short-load';
  const day = makeDay(dateKey, [
    { type: 'trip_start', time: '08:00' },
    {
      type: 'load_start',
      time: '08:01',
      extras: { reportMinDurationMinutes: 15, loadSessionId: sessionId },
    },
    { type: 'load_end', time: '08:02', extras: { loadSessionId: sessionId } },
    { type: 'trip_end', time: '08:03' },
  ]);

  assertEqual(projectedTimes(day).join(','), '08:00,08:00,08:15,08:15', 'timeline boundaries');
  assertEqual(computeDayMetrics(day).loadMinutes, 15, 'daily report load duration');
}

function testConsecutiveShortWorkRemainsMonotonic() {
  const dateKey = '2026-07-11';
  const day = makeDay(dateKey, [
    { type: 'trip_start', time: '08:00' },
    {
      type: 'load_start',
      time: '08:01',
      extras: { reportMinDurationMinutes: 15, loadSessionId: 'load-a' },
    },
    { type: 'load_end', time: '08:02', extras: { loadSessionId: 'load-a' } },
    {
      type: 'unload_start',
      time: '08:03',
      extras: { reportMinDurationMinutes: 15, unloadSessionId: 'unload-b' },
    },
    { type: 'unload_end', time: '08:04', extras: { unloadSessionId: 'unload-b' } },
    { type: 'trip_end', time: '08:05' },
  ]);
  const projection = projectReportTimeline(day);

  assertEqual(projectedTimes(day).join(','), '08:00,08:00,08:15,08:15,08:30,08:30', 'consecutive boundaries');
  assertEqual(computeDayMetrics(day).loadMinutes, 15, 'first short operation duration');
  assertEqual(computeDayMetrics(day).unloadMinutes, 15, 'second short operation duration');
  assertEqual(
    projection.every((item, index) => index === 0 || item.effectiveMinute >= projection[index - 1].effectiveMinute),
    true,
    'projected boundaries must be monotonic',
  );
}

function testLegacyEventsKeepQuarterHourProjection() {
  const dateKey = '2026-07-12';
  const day = makeDay(dateKey, [
    { type: 'trip_start', time: '08:00' },
    { type: 'load_start', time: '08:01' },
    { type: 'load_end', time: '08:02' },
    { type: 'trip_end', time: '08:03' },
  ]);

  assertEqual(projectedTimes(day).join(','), '08:00,08:00,08:00,08:00', 'legacy boundaries');
  assertEqual(computeDayMetrics(day).loadMinutes, 0, 'legacy duration must not gain a minimum marker');
}

function testRegulationTimelineKeepsRawTimestamps() {
  const dateKey = '2026-07-13';
  const day = makeDay(dateKey, [
    { type: 'trip_start', time: '08:00' },
    {
      type: 'break_start',
      time: '08:01',
      extras: { reportMinDurationMinutes: 15, breakSessionId: 'raw-break' },
    },
    { type: 'break_end', time: '08:02', extras: { breakSessionId: 'raw-break' } },
    { type: 'trip_end', time: '08:03' },
  ]);
  const rawTimestamps = day.events.map(event => event.ts).join(',');
  const regulation = computeContinuousDriveTimeline([day]);

  projectReportTimeline(day);
  assertEqual(day.events.map(event => event.ts).join(','), rawTimestamps, 'projection must not mutate raw timestamps');
  assertEqual(
    regulation.intervals.find(interval => interval.category === 'break')?.durationMinutes,
    1,
    'regulation interval must remain raw',
  );
}

function testShortLoadAcrossMidnightKeepsMinimum() {
  const sessionId = 'midnight-load';
  const firstDay = makeDay('2026-07-14', [
    { type: 'trip_start', time: '23:45' },
    {
      type: 'load_start',
      time: '23:58',
      extras: { reportMinDurationMinutes: 15, loadSessionId: sessionId },
    },
  ]);
  const secondDay = makeDay('2026-07-15', [
    { type: 'load_end', time: '00:01', extras: { loadSessionId: sessionId } },
    { type: 'trip_end', time: '00:02' },
  ]);
  secondDay.dayIndex = 2;
  secondDay.isFirstDay = false;
  const trip: Trip = {
    id: 'trip-midnight',
    createdAt: firstDay.events[0].ts,
    label: 'midnight',
    days: [firstDay, secondDay],
    jobs: [],
    rawJson: '{}',
  };

  const projections = projectTripReportTimelines(trip.days);
  const firstProjection = projections.get(1)?.events ?? [];
  const secondProjection = projections.get(2)?.events ?? [];
  const loadStart = firstProjection.find(item => item.event.type === 'load_start');
  const loadEnd = secondProjection.find(item => item.event.type === 'load_end');
  assertEqual(formatReportMinute(loadStart?.effectiveMinute ?? -1), '24:00', 'first-day boundary');
  assertEqual(formatReportMinute(loadEnd?.effectiveMinute ?? -1), '00:15', 'next-day minimum end');

  const metrics = computeTripDayMetrics(trip);
  assertEqual(metrics[0].loadMinutes, 0, 'first day ends at the 24:00 boundary');
  assertEqual(metrics[1].loadMinutes, 15, 'minimum duration continues after midnight');
  assertEqual(metrics[1].loads[0]?.durationMinutes, 15, 'next-day detail matches the daily total');
  assertEqual(
    metrics.reduce((sum, day) => sum + day.loadMinutes, 0),
    15,
    'cross-midnight minimum is counted exactly once',
  );
}

const tests: Array<[string, () => void]> = [
  ['short load report minimum', testShortLoadUsesReportMinimum],
  ['consecutive short work monotonicity', testConsecutiveShortWorkRemainsMonotonic],
  ['legacy marker-free events', testLegacyEventsKeepQuarterHourProjection],
  ['raw regulation timestamps', testRegulationTimelineKeepsRawTimestamps],
  ['cross-midnight minimum', testShortLoadAcrossMidnightKeepsMinimum],
];

for (const [, test] of tests) test();
console.log(`reportTimeline: ${tests.length} tests passed`);
