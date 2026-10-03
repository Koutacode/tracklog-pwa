import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { withRemoteSyncSignalsSuppressed } from '../app/remoteSyncSignal';
import { PERSISTED_BASIC_TOGGLE_DEFINITIONS, resolveTogglePairing } from '../domain/togglePairing';
import { db } from './db';
import {
  addPointMark,
  addRoutePoint,
  endWork,
  getActiveTripId,
  getEventsByTripId,
  startTrip,
  startWork,
} from './repositories';

// This process owns only fake-indexeddb's in-memory storage. No device/browser
// storage, credentials, production trip IDs, or remote sync services are used.
// This checks a same-schema restart, not Android installation or migration.
async function snapshot() {
  return Object.fromEntries(await Promise.all(db.tables.map(async table => [table.name, await table.toArray()])));
}

async function restartAndAssertUnchanged(): Promise<void> {
  const before = await snapshot();
  db.close();
  await db.open();
  assert.deepEqual(await snapshot(), before, 'reopening retains every row, revision and mutation identity');
}

async function exactlyOneSucceeded(operations: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(operations);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, operations.length - 1);
}

async function main(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let networkAttempts = 0;
  globalThis.fetch = async () => {
    networkAttempts += 1;
    throw new Error('Network is forbidden in the synthetic offline restart test');
  };
  try {
    await withRemoteSyncSignalsSuppressed(async () => {
      await db.open();
      assert.equal(await db.events.count(), 0, 'test starts with isolated memory storage');
      await exactlyOneSucceeded([
        startTrip({ odoKm: 1200, occurredAt: '2026-10-03T01:00:00.000Z' }),
        startTrip({ odoKm: 1200, occurredAt: '2026-10-03T01:00:00.000Z' }),
      ]);
      const tripId = await getActiveTripId();
      assert.ok(tripId);
      await addPointMark({ tripId, label: '合成テスト地点', occurredAt: '2026-10-03T01:10:00.000Z' });
      await addRoutePoint({
        id: 'synthetic-offline-route-point', tripId, ts: '2026-10-03T01:20:00.000Z',
        lat: 0, lng: 0, accuracy: 5, source: 'background',
      });
      await exactlyOneSucceeded([
        startWork({ tripId, occurredAt: '2026-10-03T01:30:00.000Z' }),
        startWork({ tripId, occurredAt: '2026-10-03T01:30:00.000Z' }),
      ]);
      const eventsBeforeRestart = await getEventsByTripId(tripId);
      assert.deepEqual(eventsBeforeRestart.map(event => event.type), ['trip_start', 'point_mark', 'work_start']);
      assert.ok(eventsBeforeRestart.every(event => event.syncStatus === 'pending' && event.syncMutationId && event.localRevision === 1));
      const routesBeforeRestart = await db.routePoints.toArray();
      assert.equal(routesBeforeRestart.length, 1);
      assert.equal(routesBeforeRestart[0].syncStatus, 'pending');
      assert.ok(routesBeforeRestart[0].syncMutationId);

      await restartAndAssertUnchanged();
      assert.equal(await getActiveTripId(), tripId, 'the active trip is recovered after restart');
      assert.deepEqual(await getEventsByTripId(tripId), eventsBeforeRestart);
      const open = resolveTogglePairing(await getEventsByTripId(tripId), PERSISTED_BASIC_TOGGLE_DEFINITIONS);
      assert.equal(open.openStarts.length, 1);
      assert.equal(open.openStarts[0].definition.channel, 'work');

      const beforeRejectedStart = await snapshot();
      await assert.rejects(startTrip({ odoKm: 1200 }), /進行中/);
      await assert.rejects(startWork({ tripId }), /すでに開始/);
      assert.deepEqual(await snapshot(), beforeRejectedStart, 'rejected starts leave all stored data intact');
      await exactlyOneSucceeded([
        endWork({ tripId, occurredAt: '2026-10-03T02:00:00.000Z' }),
        endWork({ tripId, occurredAt: '2026-10-03T02:00:00.000Z' }),
      ]);
      const eventsAfterEnd = await getEventsByTripId(tripId);
      assert.equal(eventsAfterEnd.filter(event => event.type === 'work_end').length, 1);
      assert.deepEqual(eventsAfterEnd.slice(0, 3), eventsBeforeRestart, 'ending resumed work preserves every existing event');
      assert.equal(eventsAfterEnd[3].extras?.workSessionId, eventsBeforeRestart[2].extras?.workSessionId);
      assert.ok(eventsAfterEnd.every(event => event.syncStatus === 'pending'));
      assert.deepEqual(await db.routePoints.toArray(), routesBeforeRestart);
      await restartAndAssertUnchanged();
      assert.equal(await getActiveTripId(), tripId, 'ending work does not end the trip');
      assert.equal(networkAttempts, 0, 'offline persistence requires no network requests');
    });
    console.log('activeTripRestart: synthetic offline restart, pending data retention and concurrent duplicate protections passed');
  } finally {
    globalThis.fetch = originalFetch;
    await db.delete(); // Deletes only this process-local fake IndexedDB.
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
