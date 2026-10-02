import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { withRemoteSyncSignalsSuppressed } from '../app/remoteSyncSignal';
import { getEditableEventTypeOptions } from '../domain/eventTypeConversion';
import { computeLiveDriveStatus } from '../domain/liveDriveStatus';
import {
  buildReportTripFromAppEvents,
  computeTripDayMetrics,
  projectTripReportTimelines,
} from '../domain/reportLogic';
import {
  PERSISTED_BASIC_TOGGLE_DEFINITIONS,
  resolveTogglePairing,
} from '../domain/togglePairing';
import type { AppEvent } from '../domain/types';
import { buildTripDetailWorkTimelineForDay } from '../ui/screens/tripDetailTimeline';
import { db } from './db';
import {
  addBoarding,
  addPointMark,
  endTrip,
  endWork,
  getActiveTripId,
  getEventsByTripId,
  restoreSnapshotJson,
  startBreak,
  startLoad,
  startRest,
  startTrip,
  startUnload,
  startWork,
  updateEventType,
} from './repositories';

const T = {
  trip: '2026-10-02T00:00:00.000Z',
  work: '2026-10-02T01:00:00.000Z',
  workEnd: '2026-10-02T01:30:00.000Z',
  secondWork: '2026-10-02T02:00:00.000Z',
  secondWorkEnd: '2026-10-02T02:30:00.000Z',
  tripEnd: '2026-10-02T03:00:00.000Z',
} as const;

async function resetDatabase(): Promise<void> {
  await db.transaction('rw', [db.events, db.meta, db.routePoints], async () => {
    await Promise.all([db.events.clear(), db.meta.clear(), db.routePoints.clear()]);
  });
}

async function createTrip(occurredAt: string = T.trip): Promise<string> {
  return (await startTrip({ odoKm: 100, occurredAt })).tripId;
}

function eventsOfType(events: readonly AppEvent[], type: AppEvent['type']): AppEvent[] {
  return events.filter(event => event.type === type);
}

function pairing(events: readonly AppEvent[]) {
  return resolveTogglePairing(events, PERSISTED_BASIC_TOGGLE_DEFINITIONS);
}

function report(tripId: string, events: AppEvent[]) {
  return buildReportTripFromAppEvents({ tripId, events, dayRuns: [] });
}

function workRows(trip: ReturnType<typeof report>, dayIndex: number) {
  const timelines = projectTripReportTimelines(trip.days);
  return buildTripDetailWorkTimelineForDay(
    trip.days.map(day => ({ dayIndex: day.dayIndex, timeline: timelines.get(day.dayIndex)?.events ?? [] })),
    dayIndex,
  ).filter(row => row.label === '業務');
}

async function testStartEndRestartAndLegacyPoints(): Promise<void> {
  await resetDatabase();
  const tripId = await createTrip();
  await addPointMark({ tripId, label: '既存の地点メモ', occurredAt: '2026-10-02T00:30:00.000Z' });
  const point = eventsOfType(await getEventsByTripId(tripId), 'point_mark')[0];
  assert.ok(point);

  const first = await startWork({ tripId, address: '合成整備施設', occurredAt: T.work });
  let events = await getEventsByTripId(tripId);
  const start = eventsOfType(events, 'work_start')[0];
  assert.ok(start);
  assert.ok(first.workSessionId, 'other work has its own durable pairing identity');
  assert.equal(start.extras?.workSessionId, first.workSessionId);
  assert.equal(start.ts, T.work);
  assert.equal(start.address, '合成整備施設');
  assert.equal(start.syncStatus, 'pending');
  assert.deepEqual(pairing(events).openStarts.map(item => item.definition.channel), ['work']);

  const active = computeLiveDriveStatus(events, '2026-10-02T01:20:00.000Z');
  assert.equal(active.currentCategory, 'work', 'other work interrupts the driving category');
  assert.equal(active.currentCategoryStartedAt, T.work);
  assert.equal(active.currentNonDrivingMinutes, 20);
  assert.equal(active.driveSinceResetMinutes, 60, 'work time must not accumulate as driving');

  const beforeDuplicate = structuredClone(events);
  await assert.rejects(() => startWork({ tripId, occurredAt: T.workEnd }), /その他.*開始/);
  assert.deepEqual(await getEventsByTripId(tripId), beforeDuplicate, 'a duplicate start makes no partial write');

  await endWork({ tripId, occurredAt: T.workEnd });
  events = await getEventsByTripId(tripId);
  assert.equal(eventsOfType(events, 'work_end')[0]?.extras?.workSessionId, first.workSessionId);
  assert.deepEqual(pairing(events).openStarts, []);
  assert.equal(computeLiveDriveStatus(events, '2026-10-02T01:40:00.000Z').currentCategory, 'drive');
  const beforeDuplicateEnd = structuredClone(events);
  await assert.rejects(() => endWork({ tripId, occurredAt: T.secondWork }), /その他.*開始されていません/);
  assert.deepEqual(await getEventsByTripId(tripId), beforeDuplicateEnd);

  const second = await startWork({ tripId, occurredAt: T.secondWork });
  assert.notEqual(second.workSessionId, first.workSessionId, 'each work period gets a new session');
  events = await getEventsByTripId(tripId);
  assert.equal(pairing(events).openStarts[0]?.sessionId, second.workSessionId);
  assert.equal(computeLiveDriveStatus(events, '2026-10-02T02:10:00.000Z').currentCategory, 'work');
  await endWork({ tripId, occurredAt: T.secondWorkEnd });
  events = await getEventsByTripId(tripId);
  assert.equal(pairing(events).pairs.filter(pair => pair.definition.channel === 'work').length, 2);
  assert.deepEqual(events.find(event => event.id === point.id), point, 'existing location notes retain their original type and content');
  assert.equal(eventsOfType(events, 'point_mark').length, 1, 'other work records are distinct from point notes');
}

async function testOtherWorkExcludesOtherActivitiesAndFerry(): Promise<void> {
  const starts: Array<[string, (tripId: string) => Promise<unknown>]> = [
    ['休憩', tripId => startBreak({ tripId, occurredAt: T.workEnd })],
    ['積込', tripId => startLoad({ tripId, occurredAt: T.workEnd })],
    ['荷卸', tripId => startUnload({ tripId, occurredAt: T.workEnd })],
    ['休息', tripId => startRest({ tripId, odoKm: 100, occurredAt: T.workEnd })],
    ['フェリー', tripId => addBoarding({ tripId, occurredAt: T.workEnd })],
  ];

  await resetDatabase();
  const tripId = await createTrip();
  await startWork({ tripId, occurredAt: T.work });
  const original = await getEventsByTripId(tripId);
  for (const [label, start] of starts) {
    await assert.rejects(() => start(tripId), /その他|進行中/, `${label} cannot overlap an active other-work period`);
    assert.deepEqual(await getEventsByTripId(tripId), original, `${label} rejection is atomic`);
  }

  for (const [label, start] of starts) {
    await resetDatabase();
    const otherTripId = await createTrip();
    await start(otherTripId);
    const before = await getEventsByTripId(otherTripId);
    await assert.rejects(
      () => startWork({ tripId: otherTripId, occurredAt: T.secondWork }),
      /進行中/,
      `other work cannot overlap ${label}`,
    );
    assert.deepEqual(await getEventsByTripId(otherTripId), before, `${label} remains the active operation`);
  }
}

async function testTripEndClosesOtherWorkAtomically(): Promise<void> {
  await resetDatabase();
  const tripId = await createTrip();
  const work = await startWork({ tripId, occurredAt: T.work });
  const before = await getEventsByTripId(tripId);
  await assert.rejects(
    () => endTrip({ tripId, odoEndKm: 99, occurredAt: T.secondWork }),
    /運行終了メーター/,
  );
  assert.deepEqual(await getEventsByTripId(tripId), before, 'failed trip end keeps other work open without a synthetic end');
  assert.equal(await getActiveTripId(), tripId);

  await endTrip({ tripId, odoEndKm: 125, occurredAt: T.secondWork });
  const events = await getEventsByTripId(tripId);
  const closing = eventsOfType(events, 'work_end');
  assert.equal(closing.length, 1, 'trip completion creates one missing other-work end');
  assert.equal(closing[0]?.ts, T.secondWork);
  assert.equal(closing[0]?.extras?.workSessionId, work.workSessionId);
  assert.deepEqual(pairing(events).openStarts, []);
  assert.equal(await getActiveTripId(), null);
  assert.equal(computeLiveDriveStatus(events, T.tripEnd).currentCategory, 'idle');
  await assert.rejects(() => startWork({ tripId, occurredAt: T.tripEnd }), /終了済み/);

  const trip = report(tripId, events);
  const metrics = computeTripDayMetrics(trip)[0];
  assert.equal(metrics.workMinutes, 60);
  assert.equal(metrics.driveMinutes, 60);
  const rows = workRows(trip, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.endMinute, 11 * 60, 'completed work has a definite timeline end at trip completion');
}

async function testShortOtherWorkUsesBusinessReportCategory(): Promise<void> {
  await resetDatabase();
  const tripId = await createTrip();
  await startWork({ tripId, occurredAt: '2026-10-02T00:01:00.000Z' });
  await endWork({ tripId, occurredAt: '2026-10-02T00:02:00.000Z' });
  await endTrip({ tripId, odoEndKm: 100, occurredAt: '2026-10-02T00:03:00.000Z' });
  const events = await getEventsByTripId(tripId);
  assert.equal(eventsOfType(events, 'work_end').length, 1, 'an already closed operation is not closed again by trip end');
  const trip = report(tripId, events);
  const metrics = computeTripDayMetrics(trip)[0];
  assert.equal(metrics.workMinutes, 15, 'a short other-work period follows the existing minimum report interval');
  assert.equal(metrics.loadMinutes, 0);
  assert.equal(metrics.unloadMinutes, 0);
  assert.equal(metrics.breakMinutes, 0);
  const rows = workRows(trip, 1);
  assert.equal(rows.length, 1, 'the report time axis shows other work in the business category');
  assert.equal(rows[0]?.startMinute, 9 * 60);
  assert.equal(rows[0]?.endMinute, 9 * 60 + 15);
  assert.deepEqual(trip.days[0]?.events.filter(event => event.type.startsWith('work_')).map(event => event.type), ['work_start', 'work_end']);
}

async function testOtherWorkAcrossMidnight(): Promise<void> {
  await resetDatabase();
  const tripId = await createTrip('2026-10-02T14:30:00.000Z');
  await startWork({ tripId, occurredAt: '2026-10-02T14:45:00.000Z' });
  await endWork({ tripId, occurredAt: '2026-10-02T15:15:00.000Z' });
  await endTrip({ tripId, odoEndKm: 110, occurredAt: '2026-10-02T15:30:00.000Z' });
  const events = await getEventsByTripId(tripId);
  assert.equal(pairing(events).pairs.filter(pair => pair.definition.channel === 'work').length, 1);
  const trip = report(tripId, events);
  assert.deepEqual(trip.days.map(day => day.dateKey), ['2026-10-02', '2026-10-03']);
  assert.deepEqual(computeTripDayMetrics(trip).map(metrics => metrics.workMinutes), [15, 15], 'midnight splits one work period between the two report days');
  const first = workRows(trip, 1)[0];
  const second = workRows(trip, 2)[0];
  assert.equal(first?.startMinute, 23 * 60 + 45);
  assert.equal(first?.endMinute, 1440);
  assert.equal(first?.continuesToNextDay, true);
  assert.equal(second?.startMinute, 0);
  assert.equal(second?.endMinute, 15);
  assert.equal(second?.continuesFromPreviousDay, true);
}

async function testWorkTypeCorrectionPreservesPairIdentity(): Promise<void> {
  await resetDatabase();
  const tripId = await createTrip();
  const first = await startWork({ tripId, occurredAt: T.work });
  await endWork({ tripId, occurredAt: T.workEnd });
  const second = await startWork({ tripId, occurredAt: T.secondWork });
  await endWork({ tripId, occurredAt: T.secondWorkEnd });
  let events = await getEventsByTripId(tripId);
  const firstStart = events.find(event => event.type === 'work_start' && event.extras?.workSessionId === first.workSessionId)!;
  const firstEnd = events.find(event => event.type === 'work_end' && event.extras?.workSessionId === first.workSessionId)!;
  const untouched = events.filter(event => event.extras?.workSessionId === second.workSessionId);
  assert.ok(getEditableEventTypeOptions(events, firstStart.id).includes('load_start'));

  await updateEventType(firstStart.id, 'load_start');
  events = await getEventsByTripId(tripId);
  const changed = events.filter(event => event.id === firstStart.id || event.id === firstEnd.id);
  assert.deepEqual(changed.map(event => event.type), ['load_start', 'load_end'], 'correcting one end retypes its proven partner');
  for (const event of changed) {
    assert.equal(event.extras?.workSessionId, undefined, 'source work identity is removed after conversion');
    assert.equal(event.extras?.loadSessionId, first.workSessionId, 'the accepted pair keeps its identity under the target key');
    assert.equal(event.syncStatus, 'pending');
  }
  assert.deepEqual(events.filter(event => event.extras?.workSessionId === second.workSessionId), untouched, 'an unrelated work session is not rewritten');

  await updateEventType(firstEnd.id, 'work_end');
  events = await getEventsByTripId(tripId);
  const restored = events.filter(event => event.id === firstStart.id || event.id === firstEnd.id);
  assert.deepEqual(restored.map(event => event.type), ['work_start', 'work_end']);
  assert.ok(restored.every(event => event.extras?.workSessionId === first.workSessionId && event.extras?.loadSessionId === undefined));
  assert.equal(pairing(events).pairs.filter(pair => pair.definition.channel === 'work').length, 2);
  assert.deepEqual(events.filter(event => event.extras?.workSessionId === second.workSessionId), untouched);
}

async function testSnapshotRestoreRetainsOtherWork(): Promise<void> {
  await resetDatabase();
  const tripId = await createTrip();
  const closed = await startWork({ tripId, occurredAt: T.work });
  await endWork({ tripId, occurredAt: T.workEnd });
  const open = await startWork({ tripId, occurredAt: T.secondWork });
  await addPointMark({ tripId, label: '既存地点', occurredAt: '2026-10-02T02:05:00.000Z' });
  const original = await getEventsByTripId(tripId);
  const snapshot = JSON.stringify({ events: original });
  await resetDatabase();

  const result = await restoreSnapshotJson(snapshot);
  assert.equal(result.importedEvents, original.length, 'snapshot parsing recognizes both other-work event types');
  assert.equal(result.activeTripId, tripId);
  assert.equal(await getActiveTripId(), tripId);
  const restored = await getEventsByTripId(tripId);
  const resolved = pairing(restored);
  assert.equal(resolved.pairs.find(pair => pair.definition.channel === 'work')?.startSessionId, closed.workSessionId);
  assert.equal(resolved.openStarts.find(item => item.definition.channel === 'work')?.sessionId, open.workSessionId);
  assert.equal(computeLiveDriveStatus(restored, '2026-10-02T02:10:00.000Z').currentCategory, 'work');
  assert.equal(eventsOfType(restored, 'point_mark')[0]?.extras?.label, '既存地点');

  await endWork({ tripId, occurredAt: T.secondWorkEnd });
  const completed = await getEventsByTripId(tripId);
  assert.equal(pairing(completed).pairs.filter(pair => pair.definition.channel === 'work').length, 2, 'restored open other work can be completed normally');
  assert.equal(eventsOfType(completed, 'work_end').find(event => event.ts === T.secondWorkEnd)?.extras?.workSessionId, open.workSessionId);
}

const tests: Array<[string, () => Promise<void>]> = [
  ['start/end/restart and legacy point compatibility', testStartEndRestartAndLegacyPoints],
  ['bidirectional basic activity and ferry exclusivity', testOtherWorkExcludesOtherActivitiesAndFerry],
  ['atomic trip completion closes other work', testTripEndClosesOtherWorkAtomically],
  ['short work is counted as business time', testShortOtherWorkUsesBusinessReportCategory],
  ['other work crossing midnight', testOtherWorkAcrossMidnight],
  ['type correction preserves the intended pair only', testWorkTypeCorrectionPreservesPairIdentity],
  ['snapshot restore retains closed and active other work', testSnapshotRestoreRetainsOtherWork],
];

async function main(): Promise<void> {
  try {
    await withRemoteSyncSignalsSuppressed(async () => {
      for (const [name, test] of tests) {
        try {
          await test();
        } catch (error) {
          console.error(`otherWorkLifecycle: ${name}`);
          throw error;
        }
      }
    });
    console.log(`otherWorkLifecycle: ${tests.length} repository integration tests passed`);
  } finally {
    await db.delete();
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
