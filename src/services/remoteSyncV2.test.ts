import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { db } from '../db/db';
import { withRemoteSyncSignalsSuppressed } from '../app/remoteSyncSignal';
import { synchronizeRemoteOutbox } from './remoteSyncV2';
import { SUPABASE_CONFIGURED } from './supabase';

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

async function main() {
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
