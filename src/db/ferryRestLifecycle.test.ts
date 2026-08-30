import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { withRemoteSyncSignalsSuppressed } from '../app/remoteSyncSignal';
import { buildReportTripFromAppEvents, computeTripDayMetrics } from '../domain/reportLogic';
import {
  PERSISTED_BASIC_TOGGLE_DEFINITIONS,
  resolveTogglePairing,
} from '../domain/togglePairing';
import type { AppEvent } from '../domain/types';
import { db } from './db';
import {
  addBoarding,
  addDisembark,
  endRest,
  getEventsByTripId,
  startBreak,
  startLoad,
  startRest,
  startTrip,
  startUnload,
} from './repositories';

const T = {
  trip: '2026-08-30T00:00:00.000Z',
  rest: '2026-08-30T01:00:00.000Z',
  boarding: '2026-08-30T02:00:00.000Z',
  disembark: '2026-08-30T03:00:00.000Z',
  restEnd: '2026-08-30T04:00:00.000Z',
} as const;

async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.events,
      db.meta,
      db.routePoints,
      db.reportTrips,
      db.deletedEventTombstones,
      db.deletedTripTombstones,
      db.deletedReportTombstones,
    ],
    async () => {
      await Promise.all([
        db.events.clear(),
        db.meta.clear(),
        db.routePoints.clear(),
        db.reportTrips.clear(),
        db.deletedEventTombstones.clear(),
        db.deletedTripTombstones.clear(),
        db.deletedReportTombstones.clear(),
      ]);
    },
  );
}

function eventsOfType(events: readonly AppEvent[], type: AppEvent['type']): AppEvent[] {
  return events.filter(event => event.type === type);
}

function openChannels(events: readonly AppEvent[]): string[] {
  return resolveTogglePairing(events, PERSISTED_BASIC_TOGGLE_DEFINITIONS)
    .openStarts
    .map(item => item.definition.channel);
}

async function createTrip(): Promise<string> {
  return (await startTrip({ odoKm: 100, occurredAt: T.trip })).tripId;
}

async function testExistingRestSurvivesFerryLifecycle(): Promise<void> {
  await resetDatabase();
  const tripId = await createTrip();
  const existingRest = await startRest({ tripId, odoKm: 100, occurredAt: T.rest });

  const boarding = await addBoarding({ tripId, occurredAt: T.boarding });
  assert.equal(boarding.autoRestStarted, false, 'boarding during an existing rest must not create another rest');

  await addDisembark({ tripId, occurredAt: T.disembark });
  const events = await getEventsByTripId(tripId);
  const restStarts = eventsOfType(events, 'rest_start');

  assert.equal(restStarts.length, 1, 'the original rest remains the only rest start');
  assert.equal(restStarts[0]?.extras?.restSessionId, existingRest.restSessionId);
  assert.equal(eventsOfType(events, 'rest_end').length, 0, 'disembarking must not close a pre-existing rest');
  assert.deepEqual(openChannels(events), ['rest'], 'ferry closes while the original rest stays open');
}

async function testBoardingCreatesAndDisembarkClosesOnlyAutomaticRest(): Promise<void> {
  await resetDatabase();
  const tripId = await createTrip();
  const boardingResult = await addBoarding({ tripId, occurredAt: T.boarding });
  assert.equal(boardingResult.autoRestStarted, true);

  let events = await getEventsByTripId(tripId);
  const boarding = eventsOfType(events, 'boarding')[0];
  const restStart = eventsOfType(events, 'rest_start')[0];
  assert.ok(boarding && restStart, 'boarding without rest persists both start events');
  assert.equal(restStart.ts, boarding.ts, 'automatic rest starts at the boarding timestamp');
  assert.equal(restStart.extras?.autoReason, 'ferry_boarding');
  assert.equal(restStart.extras?.generatedFrom, boarding.id);
  assert.equal(boarding.extras?.autoRestSessionId, restStart.extras?.restSessionId);

  await addDisembark({ tripId, occurredAt: T.disembark });
  events = await getEventsByTripId(tripId);
  const restEnd = eventsOfType(events, 'rest_end')[0];
  const disembark = eventsOfType(events, 'disembark')[0];

  assert.ok(disembark && restEnd, 'disembarking persists both automatic closing events');
  assert.equal(restEnd.ts, disembark.ts, 'automatic rest ends at the disembark timestamp');
  assert.equal(restEnd.extras?.restSessionId, restStart.extras?.restSessionId);
  assert.equal(restEnd.extras?.autoReason, 'ferry_disembark');
  assert.equal(restEnd.extras?.generatedFrom, disembark.id);
  assert.deepEqual(openChannels(events), [], 'automatic rest and ferry are both closed');
}

async function testEndingRestWhileBoardedAutomaticallyDisembarks(): Promise<void> {
  await resetDatabase();
  const tripId = await createTrip();
  const boardingResult = await addBoarding({ tripId, occurredAt: T.boarding });
  const beforeEnd = await getEventsByTripId(tripId);
  const restStart = eventsOfType(beforeEnd, 'rest_start')[0];
  assert.ok(restStart);

  await endRest({
    tripId,
    restSessionId: String(restStart.extras?.restSessionId),
    dayClose: false,
    occurredAt: T.disembark,
  });
  const events = await getEventsByTripId(tripId);

  assert.equal(boardingResult.autoRestStarted, true);
  assert.equal(eventsOfType(events, 'rest_end').length, 1);
  assert.equal(eventsOfType(events, 'disembark').length, 1, 'ending rest during ferry auto-disembarks once');
  assert.equal(eventsOfType(events, 'rest_end')[0]?.ts, T.disembark);
  assert.equal(eventsOfType(events, 'disembark')[0]?.ts, T.disembark);
  assert.deepEqual(openChannels(events), []);
}

async function testBasicActivityExclusivityIsUnchanged(): Promise<void> {
  await resetDatabase();
  const tripId = await createTrip();
  await startRest({ tripId, odoKm: 100, occurredAt: T.rest });

  await assert.rejects(
    () => startBreak({ tripId, occurredAt: T.boarding }),
    /休息が進行中/,
  );
  await assert.rejects(
    () => startLoad({ tripId, occurredAt: T.boarding }),
    /休息が進行中/,
  );
  await assert.rejects(
    () => startUnload({ tripId, occurredAt: T.boarding }),
    /休息が進行中/,
  );

  const boarding = await addBoarding({ tripId, occurredAt: T.boarding });
  assert.equal(boarding.autoRestStarted, false, 'rest plus ferry remains the one intentional coexistence');

  await resetDatabase();
  const breakTripId = await createTrip();
  await startBreak({ tripId: breakTripId, occurredAt: T.rest });
  await assert.rejects(
    () => addBoarding({ tripId: breakTripId, occurredAt: T.boarding }),
    /休憩・積込・荷卸を終了してから/,
    'boarding does not bypass basic activity exclusivity',
  );
}

async function testReportDoesNotDoubleCountFerryInsideRest(): Promise<void> {
  await resetDatabase();
  const tripId = await createTrip();
  const rest = await startRest({ tripId, odoKm: 100, occurredAt: T.rest });
  await addBoarding({ tripId, occurredAt: T.boarding });
  await addDisembark({ tripId, occurredAt: T.disembark });
  await endRest({
    tripId,
    restSessionId: rest.restSessionId,
    dayClose: false,
    occurredAt: T.restEnd,
  });

  const events = await getEventsByTripId(tripId);
  const trip = buildReportTripFromAppEvents({
    tripId,
    events,
    dayRuns: [{ dateKey: '2026-08-30', km: 0 }],
  });
  const metrics = computeTripDayMetrics(trip)[0];

  assert.ok(metrics);
  assert.equal(metrics.restMinutes, 120, 'rest display excludes the one-hour ferry overlap');
  assert.equal(metrics.ferryMinutes, 60, 'ferry retains its own one-hour report category');
  assert.equal(metrics.restEquivalentMinutes, 180, 'rest-equivalent keeps the full three-hour rest window');
  assert.equal(
    metrics.restMinutes + metrics.ferryMinutes,
    metrics.restEquivalentMinutes,
    'the overlapping ferry hour is represented exactly once in category totals',
  );
}

const tests: Array<[string, () => Promise<void>]> = [
  ['existing rest survives ferry lifecycle', testExistingRestSurvivesFerryLifecycle],
  ['automatic ferry rest lifecycle', testBoardingCreatesAndDisembarkClosesOnlyAutomaticRest],
  ['rest end automatically disembarks', testEndingRestWhileBoardedAutomaticallyDisembarks],
  ['basic activity exclusivity', testBasicActivityExclusivityIsUnchanged],
  ['report ferry/rest overlap', testReportDoesNotDoubleCountFerryInsideRest],
];

async function main(): Promise<void> {
  try {
    await withRemoteSyncSignalsSuppressed(async () => {
      for (const [, test] of tests) await test();
    });
    console.log(`ferryRestLifecycle: ${tests.length} repository integration tests passed`);
  } finally {
    await db.delete();
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
