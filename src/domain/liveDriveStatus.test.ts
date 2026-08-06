import { computeLiveDriveStatus } from './liveDriveStatus';
import type { AppEvent, EventType } from './types';
import { buildTimeline, buildTripViewModel } from '../state/selectors';
import { buildBreakToRestTransition } from './metrics';

function makeEvent(
  id: string,
  type: EventType,
  ts: string,
  extras: Record<string, unknown> = {},
): AppEvent {
  return {
    id,
    tripId: 'trip-live-status',
    type,
    ts,
    syncStatus: 'synced',
    extras,
  } as AppEvent;
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function testLateStaleLoadEndDoesNotEndRest() {
  const restStartedAt = '2026-07-27T11:00:21.341Z';
  const events = [
    makeEvent('trip-start', 'trip_start', '2026-07-27T00:00:00.000Z', { odoKm: 1000 }),
    makeEvent('load-a-start', 'load_start', '2026-07-27T04:21:01.054Z', { loadSessionId: 'load-a' }),
    makeEvent('load-b-end', 'load_end', '2026-07-27T07:23:33.195Z', { loadSessionId: 'load-b' }),
    makeEvent('load-c-start', 'load_start', '2026-07-27T08:05:34.046Z', { loadSessionId: 'load-c' }),
    makeEvent('load-c-end', 'load_end', '2026-07-27T09:22:22.273Z', { loadSessionId: 'load-c' }),
    makeEvent('rest-start', 'rest_start', restStartedAt, { restSessionId: 'rest-1' }),
    makeEvent('stale-load-a-end', 'load_end', '2026-07-27T11:00:40.498Z', { loadSessionId: 'load-a' }),
  ];

  const status = computeLiveDriveStatus(events, '2026-07-27T12:00:00.000Z');

  assertEqual(status.currentCategory, 'rest', 'late stale load_end must not leave rest');
  assertEqual(status.currentCategoryStartedAt, restStartedAt, 'rest start timestamp must be retained');
  assertEqual(status.currentCategoryLabel, '休息', 'rest label');

  const timeline = buildTimeline(events);
  const loadItems = timeline.filter(item => item.title === '積込');
  const restItems = timeline.filter(item => item.title === '休息');
  assertEqual(loadItems.length, 2, 'timeline should show only two accepted load intervals');
  assertEqual(restItems.length, 1, 'timeline should show one open rest interval');
  assertEqual(restItems[0]?.ts, restStartedAt, 'timeline rest start timestamp');
  assertEqual(restItems[0]?.detail?.includes('進行中'), true, 'timeline should show rest as in progress');
  assertEqual(
    timeline.some(item => item.title === '積込終了'),
    false,
    'timeline must not show the stale load_end as a standalone event',
  );

  const viewModel = buildTripViewModel('trip-live-status', events);
  assertEqual(
    viewModel.timeline.filter(item => item.title === '積込').length,
    2,
    'trip view model should use the same resolved pairs',
  );
}

function testCrossMidnightStaleLoadEndDoesNotEndRest() {
  const restStartedAt = '2026-07-27T15:10:00.000Z';
  const events = [
    makeEvent('trip-start', 'trip_start', '2026-07-27T14:50:00.000Z', { odoKm: 2000 }),
    makeEvent('load-a-start', 'load_start', '2026-07-27T14:55:00.000Z', { loadSessionId: 'load-a' }),
    makeEvent('load-b-end', 'load_end', '2026-07-27T15:05:00.000Z', { loadSessionId: 'load-b' }),
    makeEvent('rest-start', 'rest_start', restStartedAt, { restSessionId: 'rest-1' }),
    makeEvent('stale-load-a-end', 'load_end', '2026-07-27T15:11:00.000Z', { loadSessionId: 'load-a' }),
  ];

  const status = computeLiveDriveStatus(events, '2026-07-27T16:00:00.000Z');

  assertEqual(status.currentCategory, 'rest', 'cross-midnight stale load_end must not leave rest');
  assertEqual(status.currentCategoryStartedAt, restStartedAt, 'cross-midnight rest start timestamp');
}

function testAutomaticBreakToRestIsIndependentOfEqualTimestampInputOrder() {
  const breakStartedAt = '2026-07-28T00:00:00.000Z';
  const transitionAt = '2026-07-28T03:00:00.000Z';
  const baseEvents = [
    makeEvent('trip-start-auto-rest', 'trip_start', '2026-07-27T23:00:00.000Z', { odoKm: 3000 }),
    makeEvent('break-start-auto-rest', 'break_start', breakStartedAt, {
      breakSessionId: 'break-auto-rest',
    }),
  ];
  const transition = buildBreakToRestTransition(baseEvents, transitionAt);
  if (!transition) throw new Error('automatic break-to-rest transition fixture was not created');

  const orderings: Array<[string, AppEvent[]]> = [
    ['break_end then rest_start', [transition.breakEnd, transition.restStart]],
    ['rest_start then break_end', [transition.restStart, transition.breakEnd]],
  ];

  for (const [ordering, transitionEvents] of orderings) {
    const status = computeLiveDriveStatus(
      [...baseEvents, ...transitionEvents],
      '2026-07-28T04:00:00.000Z',
    );
    assertEqual(status.currentCategory, 'rest', `${ordering}: automatic transition must finish in rest`);
    assertEqual(
      status.currentCategoryStartedAt,
      transitionAt,
      `${ordering}: automatic rest must start at the shared transition timestamp`,
    );
  }
}

const tests: Array<[string, () => void]> = [
  ['late stale load_end keeps rest active', testLateStaleLoadEndDoesNotEndRest],
  ['cross-midnight stale load_end keeps rest active', testCrossMidnightStaleLoadEndDoesNotEndRest],
  ['automatic break-to-rest equal timestamp order', testAutomaticBreakToRestIsIndependentOfEqualTimestampInputOrder],
];

export function runLiveDriveStatusTests() {
  for (const [, test] of tests) test();
  console.log(`liveDriveStatus: ${tests.length} tests passed`);
}

runLiveDriveStatusTests();
