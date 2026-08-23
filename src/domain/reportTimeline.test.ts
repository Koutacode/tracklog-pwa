import {
  buildImportableDayRunsFromAppEvents,
  buildReportTripFromAppEvents,
  computeDayMetrics,
  computeTripDayMetrics,
  formatReportMinute,
  formatRoundedJstTime,
  projectReportTimeline,
  projectReportTripForView,
  projectTripReportTimelines,
} from './reportLogic';
import { computeContinuousDriveTimeline } from './regulationTimeline';
import type { AppEvent, EventType } from './types';
import type { DayRecord, Trip, TripEvent, TripEventType } from './reportTypes';
import { getExpresswaySessions } from '../ui/screens/ReportDashboard';

type EventInput = {
  type: TripEventType;
  time: string;
  address?: string;
  extras?: Record<string, unknown>;
};

function timestamp(dateKey: string, time: string): string {
  return new Date(`${dateKey}T${time}:00+09:00`).toISOString();
}

function makeDay(dateKey: string, inputs: EventInput[]): DayRecord {
  const events: TripEvent[] = inputs.map(input => ({
    type: input.type,
    ts: timestamp(dateKey, input.time),
    address: input.address,
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
    time: '13:00',
    extras: {
      breakSessionId: 'auto-break',
      autoReason: 'break_3h_threshold',
      generatedFrom: 'break-start',
    },
  };
  const restStart: EventInput = {
    type: 'rest_start',
    time: '13:00',
    extras: {
      restSessionId: 'auto-rest',
      autoReason: 'break_3h_threshold',
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
    const projectedTypes = projection.map(item => item.event.type).join(',');
    const metrics = computeDayMetrics(day, timestamp(dateKey, '14:00'));

    assertEqual(projectedTypes, 'trip_start,rest_start', `${order}: converted break evidence is hidden`);
    assertEqual(
      projection[1]?.effectiveMinute,
      10 * 60,
      `${order}: rest is projected from the original break start`,
    );
    assertEqual(metrics.breakMinutes, 0, `${order}: no 15-minute minimum break remains`);
    assertEqual(metrics.restMinutes, 240, `${order}: the full four-hour interval is rest`);
  }
}

function testAutomaticBreakToRestMovesAcrossMidnightWithoutMutatingSnapshot() {
  const generatedFrom = 'break-start-cross-midnight';
  const firstDay = makeDay('2026-08-16', [
    { type: 'trip_start', time: '20:00' },
    {
      type: 'break_start',
      time: '22:00',
      address: '神奈川県横浜市 休憩地点',
      extras: {
        breakSessionId: 'break-cross-midnight',
        reportMinDurationMinutes: 15,
      },
    },
  ]);
  const secondDay = makeDay('2026-08-17', [
    {
      type: 'break_end',
      time: '01:00',
      extras: {
        breakSessionId: 'break-cross-midnight',
        autoReason: 'break_3h_threshold',
        generatedFrom,
      },
    },
    {
      type: 'rest_start',
      time: '01:00',
      extras: {
        restSessionId: 'rest-cross-midnight',
        autoReason: 'break_3h_threshold',
        generatedFrom,
      },
    },
    { type: 'trip_end', time: '02:00' },
  ]);
  secondDay.dayIndex = 2;
  secondDay.isFirstDay = false;
  const trip: Trip = {
    id: 'trip-auto-rest-cross-midnight',
    createdAt: firstDay.events[0].ts,
    label: 'cross-midnight automatic rest',
    days: [firstDay, secondDay],
    jobs: [],
    rawJson: '{}',
  };
  const snapshot = JSON.stringify(trip);

  const projectedTrip = projectReportTripForView(trip);
  assertEqual(
    projectedTrip.days[0].events.map(event => event.type).join(','),
    'trip_start,rest_start',
    'the generated rest is moved to the break-start day',
  );
  assertEqual(
    projectedTrip.days[1].events.map(event => event.type).join(','),
    'trip_end',
    'the threshold-day break transition is removed',
  );
  assertEqual(
    projectedTrip.days[0].events[1]?.ts,
    timestamp('2026-08-16', '22:00'),
    'cross-midnight rest starts at the original break timestamp',
  );
  assertEqual(
    projectedTrip.days[0].events[1]?.address,
    '神奈川県横浜市 休憩地点',
    'projected rest inherits the original break location',
  );
  assertEqual(
    projectedTrip.days[0].restPlace,
    '神奈川県横浜市 休憩地点',
    'daily rest place uses the original break location',
  );
  assertEqual(JSON.stringify(trip), snapshot, 'saved report snapshot remains unchanged');

  const timeline = computeContinuousDriveTimeline(projectedTrip.days, timestamp('2026-08-17', '02:00'));
  const restInterval = timeline.intervals.find(interval => interval.category === 'rest');
  assertEqual(restInterval?.durationMinutes, 240, 'rest spans 22:00 through 02:00 across midnight');
}

function testAutomaticBreakProjectionRequiresMatchingSessionEvidence() {
  const dateKey = '2026-08-18';
  const day = makeDay(dateKey, [
    { type: 'trip_start', time: '08:00' },
    {
      type: 'break_start',
      time: '10:00',
      extras: { breakSessionId: 'unrelated-break', reportMinDurationMinutes: 15 },
    },
    {
      type: 'break_end',
      time: '13:00',
      extras: {
        breakSessionId: 'missing-break',
        autoReason: 'break_3h_threshold',
        generatedFrom: 'missing-break-start-id',
      },
    },
    {
      type: 'rest_start',
      time: '13:00',
      extras: {
        restSessionId: 'generated-rest',
        autoReason: 'break_3h_threshold',
        generatedFrom: 'missing-break-start-id',
      },
    },
  ]);
  const trip: Trip = {
    id: 'trip-mismatched-break-evidence',
    createdAt: day.events[0].ts,
    label: 'mismatched break evidence',
    days: [day],
    jobs: [],
    rawJson: '{}',
  };

  const projected = projectReportTripForView(trip);
  assertEqual(
    projected.days[0].events.map(event => event.type).join(','),
    'trip_start,break_start,break_end,rest_start',
    'an unrelated ID-less break must not be reclassified',
  );
  assertEqual(
    projected.days[0].events.find(event => event.type === 'rest_start')?.ts,
    timestamp(dateKey, '13:00'),
    'unverified generated rest keeps its persisted threshold timestamp',
  );
}

function testDerivedDayRunsUseTheProjectedAutomaticRest() {
  const dateKey = '2026-08-18';
  const breakStartId = 'break-start-derived-day-run';
  const breakSessionId = 'break-session-derived-day-run';
  const breakStart = {
    ...makeAppEvent(
      breakStartId,
      'break_start',
      timestamp(dateKey, '10:00'),
      { breakSessionId, reportMinDurationMinutes: 15 },
    ),
    address: '東京都港区 休憩地点',
  };
  const events: AppEvent[] = [
    makeAppEvent('trip-start-derived-day-run', 'trip_start', timestamp(dateKey, '08:00')),
    breakStart,
    makeAppEvent(
      'break-end-derived-day-run',
      'break_end',
      timestamp(dateKey, '13:00'),
      {
        breakSessionId,
        autoReason: 'break_3h_threshold',
        generatedFrom: breakStartId,
      },
    ),
    {
      ...makeAppEvent(
        'rest-start-derived-day-run',
        'rest_start',
        timestamp(dateKey, '13:00'),
        {
          restSessionId: 'rest-session-derived-day-run',
          autoReason: 'break_3h_threshold',
          generatedFrom: breakStartId,
        },
      ),
      address: '',
    },
  ];
  const snapshot = JSON.stringify(events);

  const dayRuns = buildImportableDayRunsFromAppEvents(events, [{ dateKey, km: 0 }]);
  assertEqual(
    dayRuns[0].events.map(event => event.type).join(','),
    'trip_start,rest_start',
    'new report and AI snapshots use the corrected product view',
  );
  assertEqual(
    dayRuns[0].events[1]?.ts,
    timestamp(dateKey, '10:00'),
    'derived rest begins at the original break start',
  );
  assertEqual(
    dayRuns[0].events[1]?.address,
    '東京都港区 休憩地点',
    'derived rest keeps the original break place',
  );
  assertEqual(JSON.stringify(events), snapshot, 'derived snapshots do not mutate canonical events');
}

function testReportProjectionPreservesExactDayMembership() {
  const sameDateKey = '2026-08-19';
  const firstRecord = makeDay(sameDateKey, [{ type: 'trip_start', time: '08:00' }]);
  const secondRecord = makeDay(sameDateKey, [{ type: 'trip_end', time: '09:00' }]);
  secondRecord.dayIndex = 2;
  secondRecord.isFirstDay = false;
  const sameDateTrip: Trip = {
    id: 'trip-two-records-same-date',
    createdAt: firstRecord.events[0].ts,
    label: 'two records on same date',
    days: [firstRecord, secondRecord],
    jobs: [],
    rawJson: '{}',
  };

  const sameDateProjection = projectReportTripForView(sameDateTrip);
  assertEqual(
    sameDateProjection.days[0].events.map(event => event.type).join(','),
    'trip_start',
    'first same-date record keeps only its own events',
  );
  assertEqual(
    sameDateProjection.days[1].events.map(event => event.type).join(','),
    'trip_end',
    'second same-date record keeps only its own events',
  );

  const firstComplianceRecord = makeDay(sameDateKey, [
    { type: 'trip_start', time: '08:00' },
    {
      type: 'rest_start',
      time: '12:00',
      extras: { restSessionId: 'same-date-rest' },
    },
  ]);
  const secondComplianceRecord = makeDay(sameDateKey, [
    {
      type: 'rest_end',
      time: '13:00',
      extras: { restSessionId: 'same-date-rest' },
    },
    { type: 'trip_end', time: '15:00' },
  ]);
  secondComplianceRecord.dayIndex = 2;
  secondComplianceRecord.isFirstDay = false;
  const sameDateCompliance = computeContinuousDriveTimeline([
    firstComplianceRecord,
    secondComplianceRecord,
  ]);
  assertEqual(
    sameDateCompliance.byDay.get(1)?.longestContinuousDriveMinutes,
    240,
    'same-date first record keeps its four-hour continuous-drive value',
  );
  assertEqual(
    sameDateCompliance.byDay.get(2)?.longestContinuousDriveMinutes,
    120,
    'same-date second record keeps its own post-rest drive value',
  );

  const overnightRecord = makeDay('2026-08-20', [
    { type: 'trip_start', time: '22:00' },
    { type: 'trip_end', time: '23:00' },
  ]);
  overnightRecord.events[1].ts = timestamp('2026-08-21', '02:00');
  const overnightTrip: Trip = {
    id: 'trip-single-overnight-record',
    createdAt: overnightRecord.events[0].ts,
    label: 'single overnight record',
    days: [overnightRecord],
    jobs: [],
    rawJson: '{}',
  };

  const overnightProjection = projectReportTripForView(overnightTrip);
  assertEqual(
    overnightProjection.days[0].events.map(event => event.type).join(','),
    'trip_start,trip_end',
    'an event remains in its source record even when no timestamp-date record exists',
  );
  assertEqual(
    overnightProjection.days[0].events[1]?.ts,
    timestamp('2026-08-21', '02:00'),
    'overnight event timestamp is preserved',
  );
  assertEqual(
    computeContinuousDriveTimeline(overnightProjection.days)
      .byDay.get(overnightRecord.dayIndex)?.longestContinuousDriveMinutes,
    240,
    'a single source record keeps its full cross-midnight compliance interval',
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

function testFerryUsesQuarterHourGridInDailyTotals() {
  const dateKey = '2026-08-06';
  const ferrySessionId = '55e00995-24a4-4545-bfb5-6bed66bb6cd1';
  const day = makeDay(dateKey, [
    { type: 'rest_end', time: '00:00' },
    {
      type: 'rest_start',
      time: '13:23',
      extras: { restSessionId: 'rest-before-ferry', reportMinDurationMinutes: 15 },
    },
    {
      type: 'boarding',
      time: '14:11',
      extras: { ferrySessionId, reportMinDurationMinutes: 15 },
    },
    { type: 'rest_end', time: '18:06', extras: { restSessionId: 'rest-before-ferry' } },
    { type: 'disembark', time: '18:06', extras: { ferrySessionId } },
    {
      type: 'rest_start',
      time: '22:49',
      extras: { restSessionId: 'rest-after-ferry', reportMinDurationMinutes: 15 },
    },
  ]);
  day.isFirstDay = false;
  const trip: Trip = {
    id: 'trip-2026-08-06-ferry-rounding',
    createdAt: day.events[0].ts,
    label: 'ferry rounding regression',
    days: [day],
    jobs: [],
    rawJson: '{}',
  };

  const metrics = computeTripDayMetrics(trip)[0];
  const totalMinutes = metrics.driveMinutes
    + metrics.workMinutes
    + metrics.loadMinutes
    + metrics.unloadMinutes
    + metrics.waitMinutes
    + metrics.breakMinutes
    + metrics.ferryMinutes
    + metrics.restMinutes;

  assertEqual(metrics.ferryMinutes, 225, '14:11-18:06 ferry rounds to 14:15-18:00');
  assertEqual(formatRoundedJstTime(metrics.ferrySegments[0]?.startTs ?? ''), '14:15', 'rounded ferry start');
  assertEqual(formatRoundedJstTime(metrics.ferrySegments[0]?.endTs ?? ''), '18:00', 'rounded ferry end');
  assertEqual(totalMinutes, 24 * 60, 'full-day report remains exactly 24 hours');
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
  ['cross-midnight automatic break-to-rest projection', testAutomaticBreakToRestMovesAcrossMidnightWithoutMutatingSnapshot],
  ['automatic break-to-rest evidence matching', testAutomaticBreakProjectionRequiresMatchingSessionEvidence],
  ['derived day-run automatic rest projection', testDerivedDayRunsUseTheProjectedAutomaticRest],
  ['report source-day membership', testReportProjectionPreservesExactDayMembership],
  ['cross-midnight minimum', testShortLoadAcrossMidnightKeepsMinimum],
  ['accepted unload and ferry pair details', testAcceptedPairsDriveUnloadAndFerryDetails],
  ['quarter-hour ferry totals', testFerryUsesQuarterHourGridInDailyTotals],
  ['Notion stale load end regression', testNotionLateLoadEndIsExcludedFromReports],
  ['cross-day expressway sessions', testExpresswaySessionsReconnectAcrossDays],
];

for (const [, test] of tests) test();
console.log(`reportTimeline: ${tests.length} tests passed`);
