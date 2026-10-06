import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { db } from '../db/db';
import { withRemoteSyncSignalsSuppressed } from '../app/remoteSyncSignal';
import { synchronizeRemoteOutbox } from './remoteSyncV2';
import { SUPABASE_CONFIGURED } from './supabase';
import { updateEventTimestamp, updateExpresswayIcNameManual, updateExpresswayResolved,
  markExpresswayResolveFailure } from '../db/repositories';
import { getReportTrip, listReportTrips, saveReportTripSnapshot } from '../db/reportRepository';
import { buildTripDetailReportSnapshot } from '../ui/screens/tripDetailReportSnapshot';
import type { AppEvent } from '../domain/types';
import type { Trip } from '../domain/reportTypes';

type Request = Parameters<Parameters<typeof synchronizeRemoteOutbox>[1]>[0];
const USER = '11111111-1111-4111-8111-111111111111';
const TRIP = 'synthetic-sync-trip';
const TS = '2026-10-01T00:00:00.000Z';
const cursorKey = `remoteSyncV2Cursor:${USER}`;

async function reset(bootstrapping = false) {
  await withRemoteSyncSignalsSuppressed(async () => {
    for (const table of db.tables) await table.clear();
    await db.meta.put({ key: `remoteSyncV2TripRevision:${USER}:${TRIP}`, value: '1', updatedAt: TS });
    if (!bootstrapping) {
      await db.meta.put({ key: `remoteSyncProtocolVersion:${USER}`, value: '2', updatedAt: TS });
    }
  });
}

async function addPoint(id: string, lat = 35) {
  await db.routePoints.put({ id, tripId: TRIP, ts: TS, lat, lng: 139, accuracy: 10, source: 'background' });
}

function remotePoint(id: string, lat = 35, revision = 1, changeSeq = 1) {
  return {
    id, trip_id: TRIP, device_id: 'synthetic-other-device', owner_user_id: USER,
    ts: TS, updated_at: TS, lat, lng: 139, accuracy: 10, speed: null, heading: null,
    source: 'background', revision, change_seq: changeSeq,
  };
}

function success(request: Request, overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 2,
    cursor: request.cursor + Math.max(1, request.mutations.length),
    hasMore: false,
    acks: request.mutations.map((mutation, index) => ({
      mutationId: mutation.mutationId, entityType: mutation.entityType, entityId: mutation.entityId,
      status: 'applied', revision: (mutation.baseRevision ?? 0) + 1, changeSeq: request.cursor + index + 1,
    })),
    changes: {},
    ...overrides,
  };
}

async function captureRun(send?: (request: Request, call: number) => Promise<unknown>) {
  const calls: Request[] = [];
  await synchronizeRemoteOutbox(USER, async request => {
    calls.push(request);
    return send ? send(request, calls.length) : success(request);
  });
  return calls;
}

const END_TS = '2026-10-01T01:00:00.000Z';
function integrationEvents(): AppEvent[] {
  const event = (id: string, type: AppEvent['type'], ts: string, extras: AppEvent['extras']): AppEvent => ({
    id, tripId: TRIP, type, ts, extras, syncStatus: 'synced', ownerUserId: USER,
    originDeviceId: 'synthetic-other-device', remoteRevision: 1, remoteChangeSeq: 1, __remoteSyncApply: true,
  });
  return [
    event('integration-start', 'trip_start', TS, { odoKm: 100 }),
    event('integration-ic-start', 'expressway_start', '2026-10-01T00:10:00.000Z', {
      expresswaySessionId: 'integration-expressway', icName: '合成開始IC', icResolveStatus: 'resolved',
    }),
    event('integration-ic-end', 'expressway_end', '2026-10-01T00:40:00.000Z', {
      expresswaySessionId: 'integration-expressway', icName: '合成終了IC', icResolveStatus: 'resolved',
    }),
    event('integration-end', 'trip_end', END_TS, { odoKm: 120 }),
  ];
}

function integrationReport(events: AppEvent[]): Trip {
  return buildTripDetailReportSnapshot({ tripId: TRIP, events, dayRuns: [], fallbackLabel: '合成統合日報' }, '', END_TS);
}

function reportEvent(report: Trip | undefined, type: AppEvent['type']) {
  return report?.days.flatMap(day => day.events).find(event => event.type === type);
}

async function testTripEndEditDuringHeaderAckPreservesEventAndReport() {
  await reset();
  const originalEvents = integrationEvents();
  await db.events.bulkPut(originalEvents);
  await db.reportTrips.put({ ...integrationReport(originalEvents), syncStatus: 'synced', __remoteSyncApply: true });
  await updateEventTimestamp('integration-end', END_TS);
  const firstEndMutation = (await db.events.get('integration-end'))?.syncMutationId;
  const correctedEnd = '2026-10-01T00:55:00.000Z';
  const calls = await captureRun(async (request, call) => {
    if (call === 1) {
      assert.equal(request.mutations[0]?.entityType, 'trip');
      assert.equal(request.mutations[0]?.payload?.end_ts, END_TS);
      // The user corrects the occurrence time while the old header is in flight.
      await updateEventTimestamp('integration-end', correctedEnd);
      await saveReportTripSnapshot(integrationReport(await db.events.where('tripId').equals(TRIP).toArray()));
      assert.notEqual((await db.events.get('integration-end'))?.syncMutationId, firstEndMutation);
    }
    return success(request);
  });
  const headers = calls.flatMap(call => call.mutations).filter(mutation => mutation.entityType === 'trip');
  assert.deepEqual(headers.map(mutation => mutation.payload?.end_ts), [END_TS, correctedEnd],
    'the old header ack does not mark the corrected boundary as already applied');
  assert.notEqual(headers[0].mutationId, headers[1].mutationId);
  assert.equal(headers[1].baseRevision, 2, 'the corrected header uses the acknowledged prior revision');
  const eventMutation = calls.flatMap(call => call.mutations).find(mutation => mutation.entityId === 'integration-end');
  assert.equal(eventMutation?.payload?.ts, correctedEnd);
  const reportMutation = calls.flatMap(call => call.mutations).find(mutation => mutation.entityType === 'report');
  assert.equal(reportEvent(reportMutation?.payload?.payload_json as Trip, 'trip_end')?.ts, correctedEnd);
  assert.equal((await db.events.get('integration-end'))?.ts, correctedEnd);
  assert.equal((await db.events.get('integration-end'))?.syncStatus, 'synced');
  assert.equal(reportEvent(await getReportTrip(TRIP), 'trip_end')?.ts, correctedEnd);
  assert.equal((await db.reportTrips.get(TRIP))?.syncStatus, 'synced');
  assert.equal(calls.length, 3, 'two header versions and one event/report batch finish without an empty terminal RPC');
  console.log('PASS integrated trip-end correction during old header acknowledgement');
}

async function testPagedDownloadProtectsReportThenSendsIcCorrection() {
  await reset(true);
  const completeEvents = integrationEvents();
  const completeReport = integrationReport(completeEvents);
  let firstPageReport: Trip | undefined;
  const calls = await captureRun(async (request, call) => {
    assert.equal(request.mutations.length, 0, 'bootstrap pages never upload partially derived reports');
    if (call === 1) {
      return success(request, { hasMore: true, cursor: 20, changes: {
        trips: [{
          trip_id: TRIP, device_id: 'synthetic-other-device', owner_user_id: USER,
          start_ts: TS, end_ts: END_TS, odo_start: 100, odo_end: 120,
          status: 'closed', updated_at: END_TS, revision: 1, change_seq: 1,
        }],
        reports: [{
          trip_id: TRIP, device_id: 'synthetic-other-device', owner_user_id: USER,
          updated_at: END_TS, revision: 4, change_seq: 20, payload_json: completeReport,
        }],
      } });
    }
    assert.equal(call, 2, 'partial snapshot protection cannot create an upload loop');
    firstPageReport = await db.reportTrips.get(TRIP);
    const partialEvents = await db.events.where('tripId').equals(TRIP).toArray();
    assert.equal(partialEvents.some(event => event.type === 'expressway_start'), false);
    // This is the production persistence call made when detail observes only
    // synthetic header boundaries before the event page has arrived.
    await saveReportTripSnapshot(integrationReport(partialEvents));
    assert.deepEqual(await db.reportTrips.get(TRIP), firstPageReport,
      'the partial page cannot replace saved IC names, the end, or sync metadata');
    assert.equal(await db.reportTrips.where('syncStatus').equals('pending').count(), 0);
    return success(request, { hasMore: false, cursor: 24, changes: {
      events: completeEvents.map((event, index) => ({
        id: event.id, trip_id: TRIP, device_id: 'synthetic-other-device', owner_user_id: USER,
        type: event.type, ts: event.ts, extras: event.extras, geo: null, address: null,
        sync_status: 'synced', updated_at: END_TS, revision: 1, change_seq: 21 + index,
      })),
    } });
  });
  assert.equal(calls.length, 2);
  assert.equal((await db.meta.get(cursorKey))?.value, '24');
  assert.equal(reportEvent(await getReportTrip(TRIP), 'expressway_start')?.extras?.icName, '合成開始IC');
  await listReportTrips();
  await getReportTrip(TRIP);
  assert.deepEqual(await db.reportTrips.get(TRIP), firstPageReport, 'post-download read projection adds no write or mutation');

  await updateExpresswayIcNameManual('integration-ic-start', '合成修正IC');
  await saveReportTripSnapshot(integrationReport(await db.events.where('tripId').equals(TRIP).toArray()));
  const uploadCalls = await captureRun();
  assert.equal(uploadCalls.length, 1, 'a real post-download IC edit and report save share one RPC');
  const event = uploadCalls[0].mutations.find(mutation => mutation.entityId === 'integration-ic-start');
  assert.equal((event?.payload?.extras as Record<string, unknown>)?.icName, '合成修正IC');
  const report = uploadCalls[0].mutations.find(mutation => mutation.entityType === 'report');
  assert.equal(reportEvent(report?.payload?.payload_json as Trip, 'expressway_start')?.extras?.icName, '合成修正IC');
  assert.equal((await db.reportTrips.get(TRIP))?.syncStatus, 'synced');
  console.log('PASS integrated paged report/event download, partial-save guard, and IC correction upload');
}

async function testIcMetadataSurvivesSyncConflictAndRestart() {
  await reset();
  const original = integrationEvents()[1];
  const estimate = { displayName: '合成A／合成B入口（推定候補）', candidateNames: ['合成A入口', '合成B入口'],
    source: 'saved_address_official_sources', certainty: 'ambiguous_candidates',
    sourceUrls: ['https://example.invalid/synthetic-source'], note: '入口と方向は未確認', estimatedAt: TS };
  const estimated = { ...original, extras: { ...original.extras, icName: estimate.displayName,
    icNameEstimate: estimate, icResolveStatus: 'pending', icResolveRetryCount: 2, odoKm: 100 } };
  const remote = (extras: Record<string, unknown>, revision = 2, changeSeq = 10) => ({
    id: original.id, trip_id: TRIP, type: original.type, ts: original.ts,
    owner_user_id: USER, device_id: 'synthetic-other-device', updated_at: TS,
    revision, change_seq: changeSeq, extras, address: '合成住所', geo: null,
  });
  await db.events.put(estimated);
  await db.reportTrips.put({ ...integrationReport([estimated]), syncStatus: 'synced', __remoteSyncApply: true });
  const snapshotBefore = await db.reportTrips.get(TRIP);
  await saveReportTripSnapshot(integrationReport([{ ...estimated, extras: { icName: estimate.displayName,
    expresswaySessionId: original.extras!.expresswaySessionId, icResolveStatus: 'pending' } }]));
  assert.deepEqual(await db.reportTrips.get(TRIP), snapshotBefore,
    'an old snapshot with the same IC name cannot discard estimate provenance');
  await captureRun(async request => success(request, { changes: { events: [remote({
    expresswaySessionId: original.extras!.expresswaySessionId, icResolveStatus: 'failed',
    icResolveRetryCount: 6, icResolveLastAttemptAt: END_TS, odoKm: 120,
  })] } }));
  let stored = (await db.events.get(original.id))!;
  assert.equal(stored.extras?.icName, estimate.displayName, 'a nameless remote retry keeps the estimate');
  assert.equal(stored.extras?.icResolveStatus, 'failed');
  assert.equal(stored.extras?.odoKm, 120, 'old IC preservation cannot overwrite an unrelated cloud edit');
  assert.deepEqual(stored.extras?.icNameEstimate, estimate);
  assert.equal(stored.ts, original.ts);
  assert.equal(reportEvent(await getReportTrip(TRIP), original.type)?.extras?.icName, estimate.displayName);

  await updateExpresswayIcNameManual(original.id, '合成手動入口');
  const manualUpdatedAt = (await db.events.get(original.id))!.extras?.icResolveManualUpdatedAt;
  let repairedCloudExtras: Record<string, unknown> | undefined;
  const conflictCalls = await captureRun(async (request, call) => {
    if (call === 1) return success(request, {
      acks: request.mutations.map(mutation => ({ ...mutation, status: 'conflict', code: 'revision_conflict',
        revision: 3, changeSeq: 20, currentRow: remote({ icName: '古い自動入口', icResolveStatus: 'resolved', odoKm: 130 }, 3, 20) })),
    });
    assert.equal(call, 2, 'metadata repair performs a single bounded upload');
    const repair = request.mutations.find(mutation => mutation.entityId === original.id)!;
    assert.equal(repair.baseRevision, 3);
    repairedCloudExtras = repair.payload?.extras as Record<string, unknown>;
    assert.equal(repairedCloudExtras.icName, '合成手動入口', 'protected manual metadata is persisted to the cloud');
    assert.equal(repairedCloudExtras.odoKm, 130, 'IC repair retains the cloud operational edit');
    assert.equal(repair.payload?.ts, original.ts);
    return success(request);
  });
  assert.equal(conflictCalls.length, 2);
  assert.equal(repairedCloudExtras?.icResolveManualUpdatedAt, manualUpdatedAt);
  stored = (await db.events.get(original.id))!;
  assert.equal(stored.extras?.icName, '合成手動入口', 'revision conflicts cannot discard a local manual correction');
  assert.equal(stored.extras?.icResolveManualUpdatedAt, manualUpdatedAt);
  assert.deepEqual(stored.extras?.icNameEstimate, estimate, 'manual sync retains address-derived provenance');
  db.close();
  await db.open();
  assert.equal((await db.events.get(original.id))?.extras?.icName, '合成手動入口', 'IndexedDB reopen preserves manual data');
  await captureRun(async request => success(request, { changes: { events: [remote({
    icName: '別の自動候補', icResolveStatus: 'pending', icResolveRetryCount: 1,
  }, 4, 21)] } }));
  assert.equal((await db.events.get(original.id))?.extras?.icName, '合成手動入口', 'post-restart pull preserves manual data');

  await reset();
  await db.events.put({ ...original, extras: { expresswaySessionId: original.extras!.expresswaySessionId,
    icResolveStatus: 'pending', odoKm: 100 } });
  await updateEventTimestamp(original.id, original.ts);
  const pendingCalls = await captureRun(async (request, call) => {
    if (call === 1) {
      const current = (await db.events.get(original.id))!;
      await db.events.update(original.id, { extras: { ...current.extras, odoKm: 101 }, syncStatus: 'pending' });
      return success(request, { changes: { events: [remote(estimated.extras, 2, 10)] } });
    }
    assert.equal((request.mutations.find(mutation => mutation.entityId === original.id)?.payload?.extras as Record<string, unknown>)?.icName,
      estimate.displayName, 'concurrent pending edits upload the cloud estimate instead of erasing it');
    assert.equal((request.mutations.find(mutation => mutation.entityId === original.id)?.payload?.extras as Record<string, unknown>)?.odoKm,
      101, 'merging incoming IC metadata preserves the concurrent local operation edit');
    return success(request);
  });
  assert.equal(pendingCalls.length, 2);
  assert.deepEqual((await db.events.get(original.id))?.extras?.icNameEstimate, estimate);

  await updateExpresswayResolved({ eventId: original.id, status: 'failed', retryCount: 6,
    errorMessage: 'synthetic timeout', nextRetryAt: null });
  assert.equal((await db.events.get(original.id))?.extras?.icResolveRetryCount, 6);
  assert.equal((await db.events.get(original.id))?.extras?.icResolveNextRetryAt, undefined);
  assert.equal((await db.events.get(original.id))?.extras?.icName, estimate.displayName);
  await updateExpresswayResolved({ eventId: original.id, status: 'resolved', icName: '合成C入口（推定）',
    estimate: { candidates: ['合成C入口'], source: 'overpass_nearby', sourceUrls: [],
      note: '公道地物からの候補', estimatedAt: END_TS } });
  stored = (await db.events.get(original.id))!;
  assert.equal(stored.extras?.icName, '合成C入口（推定）', 'successful retry stores a new candidate');
  assert.equal(stored.extras?.icResolveRetryCount, 0);
  assert.deepEqual(stored.extras?.icNameEstimateHistory, [estimate]);
  await updateExpresswayIcNameManual(original.id, '合成確認入口');
  await markExpresswayResolveFailure({ eventId: original.id, errorMessage: 'synthetic late failure' });
  assert.equal((await db.events.get(original.id))?.extras?.icResolveStatus, 'resolved');
  assert.equal((await db.events.get(original.id))?.extras?.icName, '合成確認入口');
  console.log('PASS IC estimates/manual edits through retries, concurrent sync, conflict, and IndexedDB reopen');
}

async function main() {
  await testTripEndEditDuringHeaderAckPreservesEventAndReport();
  await testPagedDownloadProtectsReportThenSendsIcCorrection();
  await testIcMetadataSurvivesSyncConflictAndRestart();
  await reset();
  assert.equal((await captureRun()).length, 1, 'idle polling retains one pull for other-device changes');

  await reset(true);
  assert.equal((await captureRun()).length, 1, 'an empty first bootstrap does not repeat its completed pull');
  assert.equal((await db.meta.get(`remoteSyncProtocolVersion:${USER}`))?.value, '2');

  await reset();
  let calls = await captureRun(async request => success(request, {
    changes: { routePoints: [remotePoint('other-device-point')] },
  }));
  assert.equal(calls.length, 1);
  assert.equal((await db.routePoints.get('other-device-point'))?.syncStatus, 'synced',
    'an idle initial pull applies route points recorded on another device');

  await reset();
  calls = await captureRun(async (request, call) => {
    if (call === 1) await addPoint('added-during-empty-pull');
    return success(request);
  });
  assert.deepEqual(calls.map(call => call.mutations.length), [0, 1],
    'a mutation arriving during the initial empty pull is drained before the run completes');
  assert.equal((await db.routePoints.get('added-during-empty-pull'))?.syncStatus, 'synced');

  await reset();
  await db.meta.delete(`remoteSyncV2TripRevision:${USER}:${TRIP}`);
  await addPoint('missing-parent');
  let blockedCalls = 0;
  await assert.rejects(() => captureRun(async request => {
    blockedCalls += 1;
    return success(request);
  }), /同期前提/);
  assert.equal(blockedCalls, 1, 'an unresolved parent cannot cause an empty-RPC loop');
  assert.equal((await db.routePoints.get('missing-parent'))?.syncStatus, 'pending');

  await reset();
  for (let index = 0; index < 20; index += 1) await addPoint(`point-${index}`);
  calls = await captureRun();
  assert.deepEqual(calls.map(call => call.mutations.length), [20], 'the completed batch omits its terminal empty RPC');
  assert.equal(await db.routePoints.where('syncStatus').equals('synced').count(), 20);

  await reset();
  await db.routePoints.bulkPut(Array.from({ length: 901 }, (_, index) => ({
    id: `backlog-${index}`, tripId: TRIP, ts: TS, lat: 35, lng: 139, source: 'background' as const,
  })));
  calls = await captureRun();
  assert.deepEqual(calls.map(call => call.mutations.length), [420, 420, 61], 'offline backlogs respect the existing 420 cap');
  assert.equal(await db.routePoints.where('syncStatus').equals('synced').count(), 901);

  await reset(true);
  await addPoint('bootstrap-local');
  calls = await captureRun(async (request, call) => success(request, { hasMore: call < 3 }));
  assert.deepEqual(calls.map(call => call.mutations.length), [0, 0, 0, 1], 'bootstrap drains all pages before sending local changes');
  assert.equal((await db.meta.get(cursorKey))?.value, '4');

  await reset();
  await addPoint('has-more-local');
  calls = await captureRun(async (request, call) => success(request, { hasMore: call < 3 }));
  assert.deepEqual(calls.map(call => call.mutations.length), [1, 0, 0], 'hasMore retains empty outgoing pull pages');

  await reset();
  await addPoint('first');
  calls = await captureRun(async (request, call) => {
    if (call === 1) await addPoint('added-during-transport');
    return success(request);
  });
  assert.deepEqual(calls.map(call => call.mutations.map(mutation => mutation.entityId)), [['first'], ['added-during-transport']],
    'new pending mutations arriving during transport are sent before exiting');

  await reset();
  await addPoint('edited-during-transport');
  calls = await captureRun(async (request, call) => {
    if (call === 1) {
      await db.routePoints.update('edited-during-transport', { lat: 35.001 });
      return success(request, { changes: { routePoints: [remotePoint('edited-during-transport')] } });
    }
    assert.equal(request.mutations[0]?.payload?.lat, 35.001, 'the newer local payload survives the old ack/change echo');
    assert.equal(request.mutations[0]?.baseRevision, 1, 'the retry uses the received cloud revision');
    return success(request);
  });
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].mutations[0].mutationId, calls[1].mutations[0].mutationId);
  assert.equal((await db.routePoints.get('edited-during-transport'))?.syncStatus, 'synced');
  assert.equal((await db.routePoints.get('edited-during-transport'))?.lat, 35.001);

  await reset();
  await addPoint('revision-race');
  calls = await captureRun(async (request, call) => {
    if (call === 1) {
      await db.routePoints.update('revision-race', { lat: 35.002 });
      return success(request, { acks: [{
        ...request.mutations[0], status: 'conflict', code: 'revision_conflict', revision: 2, changeSeq: 8,
        currentRow: remotePoint('revision-race', 35.001, 2, 8),
      }] });
    }
    assert.equal(request.mutations[0]?.baseRevision, 2);
    assert.equal(request.mutations[0]?.payload?.lat, 35.002);
    return success(request);
  });
  assert.equal(calls.length, 2, 'concurrent local edits are retried after a revision conflict');

  await reset();
  await addPoint('stale-local');
  calls = await captureRun(async request => success(request, { acks: [{
    ...request.mutations[0], status: 'conflict', code: 'revision_conflict', revision: 2, changeSeq: 8,
    currentRow: remotePoint('stale-local', 35.003, 2, 8),
  }] }));
  assert.equal(calls.length, 1, 'server-wins conflicts do not cause an unnecessary empty pull');
  assert.equal((await db.routePoints.get('stale-local'))?.lat, 35.003);
  assert.ok(await db.meta.get(`remoteSyncV2ConflictBackup:${USER}:routePoint:stale-local`), 'the replaced local version is backed up');

  await reset();
  await addPoint('retry-identical');
  const mutationId = (await db.routePoints.get('retry-identical'))?.syncMutationId;
  await assert.rejects(() => captureRun(async () => { throw new Error('synthetic offline failure'); }), /synthetic offline/);
  assert.equal((await db.routePoints.get('retry-identical'))?.syncStatus, 'pending');
  calls = await captureRun(async request => {
    assert.equal(request.mutations[0]?.mutationId, mutationId, 'retry preserves the idempotency ID');
    const response = success(request);
    return { ...response, acks: response.acks.map(ack => ({ ...ack, status: 'duplicate' })) };
  });
  assert.equal(calls.length, 1);
  assert.equal((await db.routePoints.get('retry-identical'))?.syncStatus, 'synced');

  await reset();
  await db.deletedEventTombstones.put({ eventId: 'deleted-event', tripId: TRIP, deletedAt: TS });
  calls = await captureRun();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mutations[0]?.entityType, 'eventDelete');
  assert.ok((await db.deletedEventTombstones.get('deleted-event'))?.syncedAt, 'delete receipts are acknowledged');

  await reset();
  await addPoint('deleted-by-other-device');
  await db.meta.put({ key: 'activeTripId', value: TRIP, updatedAt: TS });
  calls = await captureRun(async request => success(request, {
    changes: { deletedTrips: [{
      trip_id: TRIP, device_id: 'synthetic-other-device', owner_user_id: USER,
      deleted_at: TS, revision: 2, change_seq: 2,
    }] },
  }));
  assert.equal(calls.length, 1);
  assert.equal(await db.routePoints.get('deleted-by-other-device'), undefined);
  assert.equal(await db.meta.get('activeTripId'), undefined, 'remote trip deletion clears the local active-trip reference');

  await reset();
  await addPoint('blocked-active-trip');
  await assert.rejects(() => captureRun(async request => success(request, { acks: [{
    ...request.mutations[0], status: 'conflict', code: 'active_trip_conflict', message: 'Another active trip already exists',
  }] })), /別端末で進行中/);
  assert.equal((await db.routePoints.get('blocked-active-trip'))?.syncStatus, 'pending');

  await reset();
  await db.meta.put({ key: 'remoteSyncBoundUserId', value: 'different-synthetic-user', updatedAt: TS });
  let transportCalled = false;
  await assert.rejects(() => synchronizeRemoteOutbox(USER, async () => {
    transportCalled = true;
    return {};
  }), /別アカウント/);
  assert.equal(transportCalled, false, 'account binding is checked before transport');

  await reset();
  assert.equal(SUPABASE_CONFIGURED, false, 'the lifecycle regression test cannot access a real Supabase client');
  Object.assign(globalThis, { __APP_VERSION__: 'test', __BUILD_DATE__: 'test' });
  const { runRemoteSync } = await import('./remoteSync');
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const connectivity = { onLine: false };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: connectivity });
  try {
    await db.meta.put({ key: 'device_display_name', value: 'offline fixture', updatedAt: TS });
    assert.equal((await runRemoteSync('offline-test')).displayName, 'offline fixture');
    await db.meta.put({ key: 'device_display_name', value: 'reconnected fixture', updatedAt: TS });
    connectivity.onLine = true;
    assert.equal((await runRemoteSync('online')).displayName, 'reconnected fixture',
      'an offline early return releases inFlight so reconnect re-enters the sync pipeline');
    await db.meta.put({ key: 'device_display_name', value: 'manual fixture', updatedAt: TS });
    assert.equal((await runRemoteSync('manual')).displayName, 'manual fixture',
      'an unconfigured early return also releases inFlight');
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }

  console.log('remoteSyncV2 tests passed (real outbox/acks/cursors; synthetic transport and IndexedDB)');
}

void main().finally(() => db.close());
