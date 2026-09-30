import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { liveQuery } from 'dexie';
import { withRemoteSyncSignalsSuppressed } from '../app/remoteSyncSignal';
import type { Trip } from '../domain/reportTypes';
import type { AppEvent } from '../domain/types';
import {
  buildTripDetailReportSnapshot,
  createTripDetailReportSnapshotPersistence,
  type TripDetailReportSnapshotSource,
} from '../ui/screens/tripDetailReportSnapshot';
import { db } from './db';
import { endTrip, listTrips, startTrip, updateEventTimestamp, updateEventType } from './repositories';
import { deleteReportTrip, getReportTrip, listReportTrips, saveReportTrip, saveReportTripSnapshot } from './reportRepository';

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
  await db.transaction('rw', db.events, db.reportTrips, db.deletedReportTombstones, db.deletedEventTombstones, async () => {
    await Promise.all([db.events.clear(), db.reportTrips.clear(), db.deletedReportTombstones.clear(), db.deletedEventTombstones.clear()]);
    await db.events.bulkPut(source.events);
  });
}

function recordedEnd(trip: Trip | undefined) {
  return trip?.days.flatMap(day => day.events).find(event => event.type === 'trip_end')?.ts;
}

async function testTripEndPersistenceAndHistoryWithoutLocation(): Promise<void> {
  await resetDatabase();
  await db.events.clear();
  const started = await startTrip({ odoKm: 100, occurredAt: source.events[0].ts });
  const ended = await endTrip({ tripId: started.tripId, odoEndKm: 120, occurredAt: source.events[1].ts });
  const storedEnd = await db.events.get(ended.event.id);
  assert.equal(storedEnd?.ts, source.events[1].ts, 'trip end persists the actual occurrence time without requesting location');
  assert.equal(storedEnd?.geo, undefined);
  assert.equal(storedEnd?.address, undefined);
  assert.equal(storedEnd?.syncStatus, 'pending', 'the exact end timestamp is queued for synchronization');
  const history = (await listTrips())[0];
  assert.equal(history.status, 'closed');
  assert.equal(history.endTs, storedEnd?.ts, 'history reads the recorded trip end even without an address');
}

async function testCompletedTripReadRefreshesStaleSnapshotWithoutWriting(): Promise<void> {
  await resetDatabase();
  const inProgress = buildTripDetailReportSnapshot({ ...source, events: [source.events[0]] }, 'Keep my label', currentTs);
  inProgress.jobs = [{ id: 'saved-job', customer: 'Synthetic customer', volume: 1, loadAt: '', loadTime: '', dropAt: '', dropDate: '', isBranchDrop: false, completed: false }];
  await saveReportTrip(inProgress);
  const storedBefore = await db.reportTrips.get(tripId);
  const eventsBefore = await db.events.toArray();
  assert.equal(recordedEnd(storedBefore), undefined, 'the saved snapshot predates the recorded trip end');

  const detail = await getReportTrip(tripId);
  const listed = (await listReportTrips())[0];
  assert.equal(recordedEnd(detail), source.events[1].ts, 'the report opens with the existing canonical end');
  assert.equal(recordedEnd(listed), source.events[1].ts, 'the report list also reads the existing end');
  assert.equal(detail?.label, inProgress.label);
  assert.deepEqual(detail?.jobs, inProgress.jobs);
  assert.equal(detail?.syncMutationId, storedBefore?.syncMutationId);
  assert.deepEqual(await db.reportTrips.get(tripId), storedBefore, 'read projection does not rewrite stored report data or sync state');
  assert.deepEqual(await db.events.toArray(), eventsBefore, 'read projection does not create events');
}

async function testPartialDownloadKeepsSavedEndAndMissingEndStaysUnknown(): Promise<void> {
  await resetDatabase();
  await saveReportTrip(snapshot());
  await db.events.delete(source.events[1].id);
  assert.equal(recordedEnd(await getReportTrip(tripId)), source.events[1].ts, 'a partial event download cannot erase a saved trip end');
  assert.equal(recordedEnd((await listReportTrips())[0]), source.events[1].ts);

  await saveReportTrip(buildTripDetailReportSnapshot({ ...source, events: [source.events[0]] }, 'Unfinished', currentTs));
  assert.equal(recordedEnd(await getReportTrip(tripId)), undefined, 'no timestamp is invented when neither source records an end');
  assert.equal(await db.events.where('type').equals('trip_end').count(), 0);
}

async function testExplicitEndDeletionDoesNotReturnFromSnapshot(): Promise<void> {
  await resetDatabase();
  await saveReportTrip(snapshot());
  await db.transaction('rw', db.events, db.deletedEventTombstones, async () => {
    await db.events.delete(source.events[1].id);
    await db.deletedEventTombstones.put({
      eventId: source.events[1].id, tripId, eventType: 'trip_end', eventTs: source.events[1].ts, deletedAt: currentTs,
    });
  });
  assert.equal(recordedEnd(await getReportTrip(tripId)), undefined, 'an explicitly deleted end is not restored from an older snapshot');
  assert.equal(recordedEnd((await listReportTrips())[0]), undefined);
  assert.equal(recordedEnd(await db.reportTrips.get(tripId)), source.events[1].ts, 'the stored snapshot is preserved for recovery');
}

async function testTimestampFreeDeletionCannotEraseDifferentSavedEnd(): Promise<void> {
  await resetDatabase();
  await saveReportTrip(snapshot());
  await db.events.delete(source.events[1].id);
  await db.deletedEventTombstones.put({
    eventId: 'older-deleted-end', tripId, eventType: 'trip_end', deletedAt: currentTs,
  });
  assert.equal(recordedEnd(await getReportTrip(tripId)), source.events[1].ts, 'a tombstone without timestamp evidence cannot identify a saved snapshot end');
  assert.equal(recordedEnd((await listReportTrips())[0]), source.events[1].ts);
}

async function testRecordedEndOnNewJstDayAndLocalTimeEdit(): Promise<void> {
  await resetDatabase();
  const inProgress = buildTripDetailReportSnapshot({ ...source, events: [source.events[0]] }, source.fallbackLabel, currentTs);
  await saveReportTrip(inProgress);
  const nextDayTs = '2026-09-05T15:37:00.000Z';
  await db.events.update(source.events[1].id, { ts: nextDayTs });
  const refreshed = await getReportTrip(tripId);
  assert.equal(refreshed?.days.find(day => day.dateKey === '2026-09-06')?.events.find(event => event.type === 'trip_end')?.ts, nextDayTs);
  assert.deepEqual(refreshed?.days.map(day => day.dayIndex), [1, 2], 'the recorded end day gets a consistent day index');

  await saveReportTrip(snapshot());
  const earlierTs = '2026-09-05T00:45:00.000Z';
  await db.events.update(source.events[1].id, { ts: earlierTs });
  assert.equal(recordedEnd(await getReportTrip(tripId)), earlierTs, 'a pending local timestamp correction can move an end earlier');
}

async function testOlderSyncedBoundaryCannotOverwriteSavedEnd(): Promise<void> {
  await resetDatabase();
  const report = { ...snapshot(), ownerUserId: 'synthetic-owner', remoteChangeSeq: 20, syncStatus: 'synced' as const, __remoteSyncApply: true };
  await db.reportTrips.put(report);
  await db.events.put({ ...source.events[1], ownerUserId: report.ownerUserId, ts: '2026-09-05T00:45:00.000Z', syncStatus: 'synced', remoteChangeSeq: 10, __remoteSyncApply: true });
  assert.equal(recordedEnd(await getReportTrip(tripId)), source.events[1].ts, 'an older synchronized event does not overwrite newer saved evidence');
  await db.events.put({ ...source.events[1], ownerUserId: report.ownerUserId, ts: '2026-09-05T00:50:00.000Z', syncStatus: 'synced', remoteChangeSeq: 21, __remoteSyncApply: true });
  assert.equal(recordedEnd(await getReportTrip(tripId)), '2026-09-05T00:50:00.000Z', 'a proven newer remote edit is reflected after sync');
}

async function testImportedReportIsNotRewrittenFromAppEvents(): Promise<void> {
  await resetDatabase();
  const imported = snapshot();
  imported.rawJson = JSON.stringify({ recordType: 'operation_log' });
  await saveReportTrip(imported);
  await db.events.update(source.events[1].id, { ts: '2026-09-05T00:45:00.000Z' });
  assert.equal(recordedEnd(await getReportTrip(tripId)), source.events[1].ts, 'an imported report retains its own recorded boundaries');
}

async function testLiveReportQueryReflectsSyncedEndWithoutManualNotification(): Promise<void> {
  await resetDatabase();
  await db.events.delete(source.events[1].id);
  await saveReportTrip(buildTripDetailReportSnapshot({ ...source, events: [source.events[0]] }, source.fallbackLabel, currentTs));
  const loaded = deferred<void>();
  const reflected = deferred<void>();
  let observedEnd: string | undefined;
  const subscription = liveQuery(listReportTrips).subscribe({
    next: trips => {
      observedEnd = recordedEnd(trips[0]);
      if (observedEnd) reflected.resolve();
      else loaded.resolve();
    },
  });
  const timeout = setTimeout(() => reflected.resolve(), 2000);
  try {
    await loaded.promise;
    await db.events.put({ ...source.events[1], syncStatus: 'synced', __remoteSyncApply: true });
    await reflected.promise;
    assert.equal(observedEnd, source.events[1].ts, 'the live query emits the synchronized end without a UI refresh signal');
    assert.equal(recordedEnd((await listReportTrips())[0]), source.events[1].ts);
  } finally {
    clearTimeout(timeout);
    subscription.unsubscribe();
  }
}

async function testAutomaticSnapshotCannotEraseCompletedReportDuringPartialSync(): Promise<void> {
  await resetDatabase();
  const complete = snapshot('Preserved company report');
  complete.jobs = [{ id: 'kept-job', customer: 'Synthetic customer', volume: 2, loadAt: '', loadTime: '', dropAt: '', dropDate: '', isBranchDrop: false, completed: true }];
  complete.ownerUserId = 'synthetic-owner';
  complete.originDeviceId = 'synthetic-device';
  complete.remoteRevision = 4;
  complete.remoteChangeSeq = 20;
  await saveReportTrip(complete);
  const stored = await db.reportTrips.get(tripId);
  await db.events.delete(source.events[1].id);
  const partial = buildTripDetailReportSnapshot({ ...source, events: [source.events[0]] }, 'Stale label', currentTs);
  await saveReportTripSnapshot(partial);
  assert.deepEqual(await db.reportTrips.get(tripId), stored, 'an automatic detail snapshot cannot erase a completed report when its end has not downloaded');
  assert.equal(recordedEnd(await getReportTrip(tripId)), source.events[1].ts);
}

async function testAutomaticOlderSnapshotCannotRegressEndAndNormalRefreshKeepsMetadata(): Promise<void> {
  await resetDatabase();
  const complete = { ...snapshot('Custom label'), ownerUserId: 'synthetic-owner', originDeviceId: 'synthetic-device', remoteRevision: 4, remoteChangeSeq: 20 };
  complete.jobs = [{ id: 'kept-job', customer: 'Synthetic customer', volume: 2, loadAt: '', loadTime: '', dropAt: '', dropDate: '', isBranchDrop: false, completed: true }];
  await saveReportTrip(complete);
  const stored = await db.reportTrips.get(tripId);
  const oldTs = '2026-09-05T00:45:00.000Z';
  await db.events.put({ ...source.events[1], ownerUserId: complete.ownerUserId, ts: oldTs, syncStatus: 'synced', remoteChangeSeq: 10, __remoteSyncApply: true });
  const olderSnapshot = buildTripDetailReportSnapshot({ ...source, events: await db.events.toArray() }, 'Old label', currentTs);
  await saveReportTripSnapshot(olderSnapshot);
  assert.deepEqual(await db.reportTrips.get(tripId), stored, 'an older synchronized boundary cannot regress the saved end through automatic snapshot persistence');

  const localTs = '2026-09-05T00:50:00.000Z';
  await db.events.update(source.events[1].id, { ts: localTs });
  await saveReportTripSnapshot(buildTripDetailReportSnapshot({ ...source, events: await db.events.toArray() }, 'Old label', currentTs));
  const updated = await db.reportTrips.get(tripId);
  assert.equal(recordedEnd(updated), localTs, 'a current local timestamp correction is still saved automatically');
  assert.equal(updated?.label, complete.label);
  assert.deepEqual(updated?.jobs, complete.jobs);
  assert.equal(updated?.createdAt, stored?.createdAt);
  assert.equal(updated?.ownerUserId, complete.ownerUserId);
  assert.equal(updated?.originDeviceId, complete.originDeviceId);
  assert.equal(updated?.remoteRevision, complete.remoteRevision);
  assert.equal(updated?.remoteChangeSeq, complete.remoteChangeSeq);
}

async function testExplicitEndDeletionAllowsAutomaticSnapshotRefresh(): Promise<void> {
  await resetDatabase();
  await saveReportTrip(snapshot());
  await db.events.delete(source.events[1].id);
  await db.deletedEventTombstones.put({ eventId: source.events[1].id, tripId, eventType: 'trip_end', eventTs: source.events[1].ts, deletedAt: currentTs });
  await saveReportTripSnapshot(buildTripDetailReportSnapshot({ ...source, events: [source.events[0]] }, source.fallbackLabel, currentTs));
  assert.equal(recordedEnd(await db.reportTrips.get(tripId)), undefined, 'an explicit timestamp-matching end deletion can refresh the saved snapshot');
}

async function testIcReadRefreshesWithoutReopeningTripDetail(): Promise<void> {
  await resetDatabase();
  const highway: AppEvent[] = [
    { id: 'synthetic-highway-start', tripId, type: 'expressway_start', ts: '2026-09-05T00:10:00.000Z', syncStatus: 'pending', extras: { expresswaySessionId: 'synthetic-session', icResolveStatus: 'pending' } },
    { id: 'synthetic-highway-end', tripId, type: 'expressway_end', ts: '2026-09-05T00:40:00.000Z', syncStatus: 'pending', extras: { expresswaySessionId: 'synthetic-session', icResolveStatus: 'pending' } },
  ];
  await db.events.bulkPut(highway);
  await saveReportTripSnapshot(buildTripDetailReportSnapshot({ ...source, events: [...source.events, ...highway] }, source.fallbackLabel, currentTs));
  const stored = await db.reportTrips.get(tripId);
  await db.events.update(highway[0].id, { extras: { ...highway[0].extras, icName: '合成開始IC', icResolveStatus: 'resolved' } });
  const getIcName = (report: Trip | undefined) => report?.days.flatMap(day => day.events).find(event => event.type === 'expressway_start')?.extras?.icName;
  assert.equal(getIcName(await getReportTrip(tripId)), '合成開始IC', 'the report opens with the resolved IC even when the trip detail was never reopened');
  assert.equal(getIcName((await listReportTrips())[0]), '合成開始IC');
  assert.deepEqual(await db.reportTrips.get(tripId), stored, 'IC read projection also preserves saved report data');
}

function highwayEvents(): AppEvent[] {
  return [
    { id: 'saved-highway-start', tripId, type: 'expressway_start', ts: '2026-09-05T00:10:00.000Z', syncStatus: 'pending', extras: { expresswaySessionId: 'saved-session', icResolveStatus: 'resolved', icName: '合成開始IC' } },
    { id: 'saved-highway-end', tripId, type: 'expressway_end', ts: '2026-09-05T00:40:00.000Z', syncStatus: 'pending', extras: { expresswaySessionId: 'saved-session', icResolveStatus: 'resolved', icName: '合成終了IC' } },
  ];
}

async function testHeaderOnlyAutomaticSnapshotPreservesNamedIcAndSourceEvents(): Promise<void> {
  await resetDatabase();
  const highway = highwayEvents();
  const fuel: AppEvent = { id: 'saved-fuel', tripId, type: 'refuel', ts: '2026-09-05T00:15:00.000Z', syncStatus: 'pending', extras: { liters: 40 } };
  await db.events.bulkPut([...highway, fuel]);
  await saveReportTripSnapshot(buildTripDetailReportSnapshot({ ...source, events: [...source.events, ...highway, fuel] }, source.fallbackLabel, currentTs));
  const stored = await db.reportTrips.get(tripId);
  await db.events.bulkDelete([...highway.map(event => event.id), fuel.id]);
  await saveReportTripSnapshot(snapshot());
  assert.deepEqual(await db.reportTrips.get(tripId), stored, 'header-only partial download cannot erase saved IC rows, names, or other source records');
}

async function testAutomaticSnapshotAllowsIcTimeEditAndExplicitDeletion(): Promise<void> {
  await resetDatabase();
  const highway = highwayEvents();
  await db.events.bulkPut(highway);
  await saveReportTripSnapshot(buildTripDetailReportSnapshot({ ...source, events: [...source.events, ...highway] }, source.fallbackLabel, currentTs));
  await updateEventTimestamp(highway[0].id, '2026-09-05T00:12:00.000Z');
  await saveReportTripSnapshot(buildTripDetailReportSnapshot({ ...source, events: await db.events.toArray() }, source.fallbackLabel, currentTs));
  const refreshed = await db.reportTrips.get(tripId);
  assert.equal(refreshed?.days.flatMap(day => day.events).find(event => event.type === 'expressway_start')?.ts, '2026-09-05T00:12:00.000Z', 'an IC session time edit still refreshes its snapshot');
  await db.events.delete(highway[0].id);
  await db.deletedEventTombstones.put({ eventId: highway[0].id, tripId, eventType: highway[0].type, eventTs: '2026-09-05T00:12:00.000Z', deletedAt: currentTs });
  await saveReportTripSnapshot(buildTripDetailReportSnapshot({ ...source, events: await db.events.toArray() }, source.fallbackLabel, currentTs));
  assert.equal((await db.reportTrips.get(tripId))?.days.flatMap(day => day.events).some(event => event.type === 'expressway_start'), false, 'explicit matching IC deletion can refresh the snapshot');
}

async function testAutomaticSnapshotAllowsPendingRefuelTimeAndOperationalTypeEdits(): Promise<void> {
  await resetDatabase();
  const work: AppEvent[] = [
    { id: 'fuel-edit', tripId, type: 'refuel', ts: '2026-09-05T00:10:00.000Z', syncStatus: 'pending', extras: { liters: 40 } },
    { id: 'load-edit-start', tripId, type: 'load_start', ts: '2026-09-05T00:20:00.000Z', syncStatus: 'pending', extras: { loadSessionId: 'synthetic-load' } },
    { id: 'load-edit-end', tripId, type: 'load_end', ts: '2026-09-05T00:30:00.000Z', syncStatus: 'pending', extras: { loadSessionId: 'synthetic-load' } },
  ];
  await db.events.bulkPut(work);
  await saveReportTripSnapshot(buildTripDetailReportSnapshot({ ...source, events: [...source.events, ...work] }, source.fallbackLabel, currentTs));
  await updateEventTimestamp(work[0].id, '2026-09-05T00:11:00.000Z');
  await updateEventType(work[1].id, 'unload_start');
  await saveReportTripSnapshot(buildTripDetailReportSnapshot({ ...source, events: await db.events.toArray() }, source.fallbackLabel, currentTs));
  const refreshed = (await db.reportTrips.get(tripId))?.days.flatMap(day => day.events);
  assert.equal(refreshed?.find(event => event.type === 'refuel')?.ts, '2026-09-05T00:11:00.000Z', 'a unique pending instant-event time edit remains supported');
  assert.equal(refreshed?.some(event => event.type === 'unload_start'), true, 'an explicit operational type conversion remains supported');
  assert.equal(refreshed?.some(event => event.type === 'load_start'), false);
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
  assert.equal(updated?.label, source.fallbackLabel, 'automatic refresh preserves the existing report label');
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
  testTripEndPersistenceAndHistoryWithoutLocation,
  testCompletedTripReadRefreshesStaleSnapshotWithoutWriting,
  testPartialDownloadKeepsSavedEndAndMissingEndStaysUnknown,
  testExplicitEndDeletionDoesNotReturnFromSnapshot,
  testTimestampFreeDeletionCannotEraseDifferentSavedEnd,
  testRecordedEndOnNewJstDayAndLocalTimeEdit,
  testOlderSyncedBoundaryCannotOverwriteSavedEnd,
  testImportedReportIsNotRewrittenFromAppEvents,
  testLiveReportQueryReflectsSyncedEndWithoutManualNotification,
  testAutomaticSnapshotCannotEraseCompletedReportDuringPartialSync,
  testAutomaticOlderSnapshotCannotRegressEndAndNormalRefreshKeepsMetadata,
  testExplicitEndDeletionAllowsAutomaticSnapshotRefresh,
  testIcReadRefreshesWithoutReopeningTripDetail,
  testHeaderOnlyAutomaticSnapshotPreservesNamedIcAndSourceEvents,
  testAutomaticSnapshotAllowsIcTimeEditAndExplicitDeletion,
  testAutomaticSnapshotAllowsPendingRefuelTimeAndOperationalTypeEdits,
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
