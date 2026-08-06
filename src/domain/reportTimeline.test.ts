import {
  buildImportableDayRunsFromAppEvents,
  buildReportTripFromAppEvents,
  computeDayMetrics,
  computeTripDayMetrics,
  formatReportMinute,
  formatRoundedJstTime,
  projectReportTimeline,
  projectTripReportTimelines,
} from './reportLogic';
import { computeContinuousDriveTimeline } from './regulationTimeline';
import type { AppEvent, EventType } from './types';
import type { DayRecord, Trip, TripEvent, TripEventType } from './reportTypes';
import { getExpresswaySessions } from '../ui/screens/ReportDashboard';

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

function makeAppEvent(
  id: string,
  type: EventType,
  ts: string,
  extras?: Record<string, unknown>,
): AppEvent {
  return {
    id,
    tripId: 'trip-notion-regression',
    type,
    ts,
    syncStatus: 'synced',
    extras,
  } as AppEvent;
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

function testSimultaneousAutoBreakToRestIsOrderIndependent() {
  const dateKey = '2026-07-13';
  const breakEnd: EventInput = {
    type: 'break_end',
    time: '11:00',
    extras: { breakSessionId: 'auto-break' },
  };
  const restStart: EventInput = {
    type: 'rest_start',
    time: '11:00',
    extras: {
      restSessionId: 'auto-rest',
      autoReason: 'break_threshold_180m',
      generatedFrom: 'break-start',
    },
  };
  const transitionOrders: Array<[string, EventInput[]]> = [
    ['end-first', [breakEnd, restStart]],
    ['start-first', [restStart, breakEnd]],
  ];

  for (const [order, transition] of transitionOrders) {
    const day = makeDay(dateKey, [
      { type: 'trip_start', time: '08:00' },
      {
        type: 'break_start',
        time: '10:00',
        extras: {
          breakSessionId: 'auto-break',
          reportMinDurationMinutes: 15,
        },
      },
      ...transition,
    ]);
    const projection = projectReportTimeline(day);
    const finalTypes = projection.slice(-2).map(item => item.event.type).join(',');
    const metrics = computeDayMetrics(day, timestamp(dateKey, '12:00'));

    assertEqual(finalTypes, 'break_end,rest_start', `${order}: projected transition order`);
    assertEqual(metrics.breakMinutes, 60, `${order}: break ends at the shared timestamp`);
    assertEqual(metrics.restMinutes, 60, `${order}: final report state remains rest`);
  }
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
    { type: 'load_end', time: '00:01', extras: { loadSessionId: `${sessionId}-reconnected` } },
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

function testAcceptedPairsDriveUnloadAndFerryDetails() {
  const firstDay = makeDay('2026-07-16', [
    { type: 'trip_start', time: '20:00' },
    { type: 'unload_start', time: '21:00', extras: { unloadSessionId: 'unload-start' } },
    { type: 'unload_end', time: '22:00', extras: { unloadSessionId: 'unload-reconnected' } },
    { type: 'boarding', time: '23:30', extras: { ferrySessionId: 'ferry-start' } },
  ]);
  const secondDay = makeDay('2026-07-17', [
    { type: 'disembark', time: '00:30', extras: { ferrySessionId: 'ferry-reconnected' } },
    { type: 'trip_end', time: '01:00' },
  ]);
  secondDay.dayIndex = 2;
  secondDay.isFirstDay = false;
  const trip: Trip = {
    id: 'trip-reconnected-details',
    createdAt: firstDay.events[0].ts,
    label: 'reconnected details',
    days: [firstDay, secondDay],
    jobs: [],
    rawJson: '{}',
  };

  const metrics = computeTripDayMetrics(trip);
  assertEqual(metrics[0].unloads[0]?.durationMinutes, 60, 'same-day unload detail uses accepted pair');
  assertEqual(metrics[0].ferrySegments[0]?.durationMinutes, 30, 'cross-day ferry starts on first day');
  assertEqual(metrics[1].ferrySegments[0]?.durationMinutes, 30, 'cross-day ferry ends on second day');
}

function testNotionLateLoadEndIsExcludedFromReports() {
  const loadA = '3ba22f48-load-a';
  const loadB = 'bcb3886a-load-b';
  const loadC = 'e87d2f6d-load-c';
  const events: AppEvent[] = [
    makeAppEvent('trip-start', 'trip_start', '2026-07-27T04:00:00.000Z', { odoKm: 0 }),
    makeAppEvent('load-start-a', 'load_start', '2026-07-27T04:21:01.054Z', {
      loadSessionId: loadA,
      reportMinDurationMinutes: 15,
    }),
    makeAppEvent('load-end-b', 'load_end', '2026-07-27T07:23:33.195Z', {
      loadSessionId: loadB,
    }),
    makeAppEvent('load-start-c', 'load_start', '2026-07-27T08:05:34.046Z', {
      loadSessionId: loadC,
      reportMinDurationMinutes: 15,
    }),
    makeAppEvent('load-end-c', 'load_end', '2026-07-27T09:22:22.273Z', {
      loadSessionId: loadC,
    }),
    makeAppEvent('rest-start', 'rest_start', '2026-07-27T11:00:21.341Z', {
      restSessionId: 'rest-active',
      reportMinDurationMinutes: 15,
    }),
    makeAppEvent('late-load-end-a', 'load_end', '2026-07-27T11:00:40.498Z', {
      loadSessionId: loadA,
    }),
  ];
  const rawEventIds = events.map(event => event.id).join(',');
  const sourceDays = [{ dateKey: '2026-07-27', km: 0 }];
  const dayRuns = buildImportableDayRunsFromAppEvents(events, sourceDays);
  const reportEvents = dayRuns[0]?.events ?? [];

  assertEqual(events.map(event => event.id).join(','), rawEventIds, 'raw DB events must remain untouched');
  assertEqual(events.filter(event => event.type === 'load_end').length, 3, 'raw DB keeps all load ends');
  assertEqual(reportEvents.filter(event => event.type === 'load_end').length, 2, 'AI/report snapshot excludes late load end');
  assertEqual(
    reportEvents.some(event => event.ts === '2026-07-27T11:00:40.498Z'),
    false,
    'late stale end must not be importable',
  );

  const trip = buildReportTripFromAppEvents({
    tripId: 'trip-notion-regression',
    events,
    dayRuns: sourceDays,
  });
  const day = trip.days[0];
  const metrics = computeTripDayMetrics(trip, { currentTs: '2026-07-27T12:00:00.000Z' })[0];

  assertEqual(day.events.filter(event => event.type === 'load_end').length, 2, 'parsed report keeps accepted ends only');
  const projected = projectReportTimeline(day);
  assertEqual(projected[projected.length - 1]?.event.type, 'rest_start', 'rest remains the active final state');
  assertEqual(metrics.loadMinutes, 270, 'quarter-hour report load total');
  assertEqual(metrics.loads.length, 2, 'only accepted load pairs produce details');
  assertEqual(metrics.loads[0]?.durationMinutes, 182, 'reconnected A/B pair keeps raw detail minutes');
  assertEqual(metrics.loads[1]?.durationMinutes, 76, 'matching C pair keeps raw detail minutes');
  assertEqual(metrics.restMinutes, 60, 'rest continues after the excluded late end');
}

function testExpresswaySessionsReconnectAcrossDays() {
  const firstDay = makeDay('2026-07-18', [
    {
      type: 'expressway_start',
      time: '23:50',
      extras: {
        expresswaySessionId: 'expressway-a',
        icName: '横浜町田IC',
        icDistanceM: 120,
      },
    },
  ]);
  const secondDay = makeDay('2026-07-19', [
    {
      type: 'expressway_end',
      time: '00:10',
      extras: {
        expresswaySessionId: 'expressway-b',
        icName: '海老名JCT',
        icDistanceM: 240,
      },
    },
    { type: 'expressway_end', time: '00:11', extras: { expresswaySessionId: 'expressway-a', icName: '古い終了IC' } },
    { type: 'expressway_end', time: '00:12', extras: { expresswaySessionId: 'expressway-orphan', icName: '孤立終了IC' } },
    { type: 'expressway', time: '00:20', extras: { icName: '従来形式IC' } },
    {
      type: 'expressway_start',
      time: '01:00',
      extras: { expresswaySessionId: 'expressway-open', icName: '厚木IC' },
    },
  ]);
  secondDay.dayIndex = 2;
  secondDay.isFirstDay = false;

  const sessions = getExpresswaySessions([firstDay, secondDay]);
  const firstDaySessions = sessions.get(1) ?? [];
  const secondDaySessions = sessions.get(2) ?? [];

  assertEqual(firstDaySessions.length, 1, 'cross-day session belongs to its start day');
  assertEqual(firstDaySessions[0]?.startIcName, '横浜町田IC', 'cross-day start IC');
  assertEqual(firstDaySessions[0]?.endIcName, '海老名JCT', 'reconnected cross-day end IC');
  assertEqual(firstDaySessions[0]?.endTs, timestamp('2026-07-19', '00:10'), 'cross-day end timestamp');
  assertEqual(secondDaySessions.length, 2, 'stale and orphan ends do not create sessions');
  assertEqual(secondDaySessions[0]?.legacy, true, 'legacy event remains on its event day');
  assertEqual(secondDaySessions[1]?.startIcName, '厚木IC', 'true open start remains visible');
  assertEqual(secondDaySessions[1]?.endTs, undefined, 'only a truly open start lacks an end');
}

const tests: Array<[string, () => void]> = [
  ['short load report minimum', testShortLoadUsesReportMinimum],
  ['consecutive short work monotonicity', testConsecutiveShortWorkRemainsMonotonic],
  ['legacy marker-free events', testLegacyEventsKeepQuarterHourProjection],
  ['raw regulation timestamps', testRegulationTimelineKeepsRawTimestamps],
  ['simultaneous automatic break-to-rest ordering', testSimultaneousAutoBreakToRestIsOrderIndependent],
  ['cross-midnight minimum', testShortLoadAcrossMidnightKeepsMinimum],
  ['accepted unload and ferry pair details', testAcceptedPairsDriveUnloadAndFerryDetails],
  ['Notion stale load end regression', testNotionLateLoadEndIsExcludedFromReports],
  ['cross-day expressway sessions', testExpresswaySessionsReconnectAcrossDays],
];

for (const [, test] of tests) test();
console.log(`reportTimeline: ${tests.length} tests passed`);
