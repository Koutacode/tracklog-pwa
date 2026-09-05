import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { withRemoteSyncSignalsSuppressed } from '../app/remoteSyncSignal';
import type { Trip } from '../domain/reportTypes';
import type { AppEvent } from '../domain/types';
import {
  buildTripDetailReportSnapshot,
  createTripDetailReportSnapshotPersistence,
  type TripDetailReportSnapshotSource,
} from '../ui/screens/tripDetailReportSnapshot';
import { db } from './db';
import { deleteReportTrip, getReportTrip, saveReportTrip, saveReportTripSnapshot } from './reportRepository';

const tripId = 'synthetic-report-snapshot';
const currentTs = '2026-09-05T02:00:00.000Z';
const source: TripDetailReportSnapshotSource = {
  tripId,
  events: [
    { id: 'synthetic-start', tripId, type: 'trip_start', ts: '2026-09-05T00:00:00.000Z', extras: { odoKm: 100 } },
    { id: 'synthetic-end', tripId, type: 'trip_end', ts: '2026-09-05T01:00:00.000Z', extras: { odoKm: 120 } },
  ] as AppEvent[],
  dayRuns: [{ dayIndex: 1, dateKey: '2026-09-05', dateLabel: '2026-09-05', km: 20, status: 'confirmed' }],
  fallbackLabel: 'Synthetic report',
};

function snapshot(label = source.fallbackLabel): Trip {
  return buildTripDetailReportSnapshot(source, label, currentTs);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function resetDatabase(): Promise<void> {
  await db.transaction('rw', db.events, db.reportTrips, db.deletedReportTombstones, async () => {
    await Promise.all([db.events.clear(), db.reportTrips.clear(), db.deletedReportTombstones.clear()]);
    await db.events.bulkPut(source.events);
  });
}

async function testNewSnapshotAndNormalUpdate(): Promise<void> {
  await resetDatabase();
  await saveReportTripSnapshot(snapshot());
  const created = await db.reportTrips.get(tripId);
  assert.equal(created?.label, source.fallbackLabel, 'automatic save creates a report for a trip with no deletion');
  assert.equal(created?.syncStatus, 'pending');
  assert.equal(created?.localRevision, 1);

  const updatedSnapshot = snapshot('Updated report');
  updatedSnapshot.days[0].km = 25;
  await saveReportTripSnapshot(updatedSnapshot);
  const updated = await db.reportTrips.get(tripId);
  assert.equal(updated?.label, 'Updated report');
  assert.equal(updated?.days[0].km, 25, 'normal automatic updates continue to refresh report data');
  assert.equal(updated?.syncStatus, 'pending');
  assert.equal(updated?.localRevision, 2);
  assert.notEqual(updated?.syncMutationId, created?.syncMutationId);
  assert.equal(await db.deletedReportTombstones.get(tripId), undefined);
}

async function testLocalDeletionIsPreserved(): Promise<void> {
  await resetDatabase();
  await saveReportTrip(snapshot());
  await deleteReportTrip(tripId);
  const tombstone = await db.deletedReportTombstones.get(tripId);
  assert.ok(tombstone, 'report deletion creates a tombstone');

  await saveReportTripSnapshot(snapshot('Should not return'));
  assert.equal(await getReportTrip(tripId), undefined, 'automatic save must not recreate a deleted report');
  assert.deepEqual(await db.deletedReportTombstones.get(tripId), tombstone, 'deletion and pending sync metadata remain unchanged');
  assert.equal(await db.events.where('tripId').equals(tripId).count(), 2, 'report-only deletion keeps the source trip');
}

async function testRemoteDeletionAndExplicitRestore(): Promise<void> {
  await resetDatabase();
  await db.deletedReportTombstones.put({
    tripId,
    deletedAt: currentTs,
    syncedAt: currentTs,
    remoteRevision: 4,
    remoteChangeSeq: 25,
    reason: 'user_deleted',
    __remoteSyncApply: true,
  });
  const tombstone = await db.deletedReportTombstones.get(tripId);

  await saveReportTripSnapshot(snapshot());
  assert.equal(await getReportTrip(tripId), undefined, 'a remotely synced deletion also blocks automatic recreation');
  assert.deepEqual(await db.deletedReportTombstones.get(tripId), tombstone);

  await saveReportTrip(snapshot('Explicitly restored'));
  const restored = await db.reportTrips.get(tripId);
  assert.equal(restored?.label, 'Explicitly restored');
  assert.equal(restored?.restoreFromChangeSeq, 25, 'explicit restore preserves the remote conflict-resolution sequence');
  assert.equal(restored?.syncStatus, 'pending');
  assert.equal(await db.deletedReportTombstones.get(tripId), undefined, 'explicit restore consumes the tombstone');
}

async function testSnapshotWaitsForConcurrentDeletion(): Promise<void> {
  await resetDatabase();
  await saveReportTrip(snapshot());
  await Promise.all([
    deleteReportTrip(tripId),
    saveReportTripSnapshot(snapshot('Queued during deletion')),
  ]);

  assert.equal(await getReportTrip(tripId), undefined, 'a snapshot queued during deletion sees the committed tombstone');
  assert.ok(await db.deletedReportTombstones.get(tripId));
}

async function testDeletionAfterConcurrentSnapshotWins(): Promise<void> {
  await resetDatabase();
  await Promise.all([
    saveReportTripSnapshot(snapshot()),
    deleteReportTrip(tripId),
  ]);

  assert.equal(await getReportTrip(tripId), undefined, 'a deletion queued during a snapshot takes effect after that snapshot');
  assert.ok(await db.deletedReportTombstones.get(tripId));
}

async function testDetailViewDoesNotRestoreDeletionAfterLabelRead(): Promise<void> {
  await resetDatabase();
  await saveReportTrip(snapshot('Existing label'));
  const labelRead = deferred<void>();
  const releaseLabel = deferred<void>();
  const snapshotFinished = deferred<void>();
  let retries = 0;
  let failures = 0;
  const persistence = createTripDetailReportSnapshotPersistence({
    loadExistingLabel: async id => {
      const label = (await getReportTrip(id))?.label;
      labelRead.resolve();
      await releaseLabel.promise;
      return label;
    },
    saveSnapshot: async trip => {
      await saveReportTripSnapshot(trip);
      snapshotFinished.resolve();
    },
    now: () => currentTs,
    scheduleRetry: () => { retries += 1; snapshotFinished.resolve(); return null; },
    cancelRetry: () => undefined,
    onPermanentFailure: () => { failures += 1; snapshotFinished.resolve(); },
  });
  try {
    persistence.enqueue(source);
    await labelRead.promise;
    await deleteReportTrip(tripId);
    const tombstone = await db.deletedReportTombstones.get(tripId);
    releaseLabel.resolve();
    await snapshotFinished.promise;
    assert.equal(await getReportTrip(tripId), undefined, 'an already loaded detail view cannot restore a subsequently deleted report');
    assert.deepEqual(await db.deletedReportTombstones.get(tripId), tombstone);
    assert.equal(retries, 0, 'intentional deletion does not schedule a failed-save retry');
    assert.equal(failures, 0, 'intentional deletion does not produce a save failure warning');
  } finally {
    persistence.dispose();
  }
}

const tests = [
  testNewSnapshotAndNormalUpdate,
  testLocalDeletionIsPreserved,
  testRemoteDeletionAndExplicitRestore,
  testSnapshotWaitsForConcurrentDeletion,
  testDeletionAfterConcurrentSnapshotWins,
  testDetailViewDoesNotRestoreDeletionAfterLabelRead,
];

async function main(): Promise<void> {
  try {
    await withRemoteSyncSignalsSuppressed(async () => {
      for (const test of tests) {
        await test();
        console.log(`PASS ${test.name}`);
      }
    });
    console.log(`reportRepository: ${tests.length} repository integration tests passed`);
  } finally {
    await db.delete();
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
