import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { db } from '../db/db';
import { backfillMissingAddresses, refreshEventAddressFromGeo, updateEventAddress, updateEventAddressManual, updateExpresswayIcNameManual } from '../db/repositories';
import { withRemoteSyncSignalsSuppressed } from '../app/remoteSyncSignal';
import {
  parseExpresswayIcNameCandidates, prepareExpresswayIcManualSelection,
  validateExpresswayIcManualSelection,
} from './expresswayIcManualEdit';

// Synthetic fixtures only; no network, current location or real records.
const eventGeo = { lat: 35, lng: 139, accuracy: 8 };
const feature = { id: 'node/77', icName: '合成IC', lat: 36, lon: 140 };

async function testExplicitAddressRefreshRaces() {
  const id = 'manual-address-refresh-fixture';
  const cases: Array<{
    label: string;
    mutate: () => Promise<unknown>;
    verify: () => Promise<void>;
    succeeds?: boolean;
  }> = [{
    label: 'later manual address',
    mutate: () => updateEventAddressManual(id, '後から手入力した住所'),
    verify: async () => { assert.equal((await db.events.get(id))!.address, '後から手入力した住所'); },
  }, {
    label: 'later selected IC address',
    mutate: () => updateExpresswayIcNameManual(id, '選択IC', {
      id: 'node/99', icName: '選択IC', address: '選択ICの住所',
    }),
    verify: async () => {
      const event = (await db.events.get(id))!;
      assert.equal(event.address, '選択ICの住所');
      assert.equal(event.extras!.icNameSearchAddressUpdated, true);
      assert.deepEqual(event.geo, eventGeo);
    },
  }, {
    label: 'later IC edit with an unchanged address',
    mutate: () => updateExpresswayIcNameManual(id, '選択IC', {
      id: 'node/99', icName: '選択IC', address: '取得開始時の住所',
    }),
    verify: async () => { assert.equal((await db.events.get(id))!.extras!.icName, '選択IC'); },
  }, {
    label: 'changed observed coordinates',
    mutate: () => db.events.update(id, { geo: { lat: 36, lng: 140, accuracy: 8 } }),
    verify: async () => {
      assert.equal((await db.events.get(id))!.address, '取得開始時の住所');
      assert.deepEqual((await db.events.get(id))!.geo, { lat: 36, lng: 140, accuracy: 8 });
    },
  }, {
    label: 'deleted event',
    mutate: () => db.events.delete(id),
    verify: async () => { assert.equal(await db.events.get(id), undefined, 'late lookup never revives a deleted event'); },
  }, {
    label: 'unchanged event', succeeds: true,
    mutate: async () => {},
    verify: async () => {
      const event = (await db.events.get(id))!;
      assert.equal(event.address, '観測県観測市再取得した住所');
      assert.equal(event.extras!.icNameSearchAddressUpdated, false,
        'explicit refresh no longer claims the address belongs to the selected IC');
      assert.equal(event.syncStatus, 'pending');
      assert.deepEqual(event.geo, eventGeo);
    },
  }];

  const originalFetch = globalThis.fetch;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  try {
    for (const scenario of cases) {
      await db.events.put({ id, tripId: 'manual-trip-fixture', type: 'expressway_end',
        ts: '2026-09-23T00:00:00.000Z', geo: eventGeo, address: '取得開始時の住所', syncStatus: 'synced',
        extras: { icName: '元のIC', icResolvedManually: true, icNameSearchAddressUpdated: true } });
      let finishLookup!: () => void;
      let lookupStarted!: () => void;
      const lookupHasStarted = new Promise<void>(resolve => { lookupStarted = resolve; });
      const releaseLookup = new Promise<void>(resolve => { finishLookup = resolve; });
      globalThis.fetch = async () => {
        lookupStarted();
        await releaseLookup;
        return new Response(JSON.stringify({ response: { location: [{
          prefecture: '観測県', city: '観測市', town: '再取得した住所', distance: 1,
        }] } }));
      };
      const refresh = refreshEventAddressFromGeo(id).then(
        address => ({ address, error: null }), error => ({ address: undefined, error }),
      );
      await lookupHasStarted;
      await scenario.mutate();
      finishLookup();
      const result = await refresh;
      assert.equal(result.error instanceof Error, !scenario.succeeds, scenario.label);
      await scenario.verify();
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    await db.events.delete(id);
  }
}

async function main() {
  const candidates = parseExpresswayIcNameCandidates({ candidates: [feature, { ...feature, lat: NaN },
    { ...feature, id: 'invalid' }, { ...feature, icName: '' }, { ...feature, lon: '140' }] });
  assert.equal(candidates.length, 1);
  assert.throws(() => parseExpresswayIcNameCandidates({ wrong: [] }));
  const selected = await prepareExpresswayIcManualSelection(candidates[0], async geo => {
    assert.deepEqual(geo, { lat: 36, lng: 140 }, 'address lookup uses only the selected public feature');
    assert.notDeepEqual(geo, eventGeo, 'the saved event position is never repurposed as an IC candidate');
    return '合成県合成市';
  });
  assert.deepEqual(selected, { id: 'node/77', icName: '合成IC', address: '合成県合成市' });
  assert.throws(() => validateExpresswayIcManualSelection('別名IC', selected));
  const withAddress = await prepareExpresswayIcManualSelection({ ...candidates[0], address: '候補の住所' }, async () => {
    throw new Error('tagged addresses must not trigger a lookup');
  });
  assert.equal(withAddress.address, '候補の住所');
  const unavailable = await prepareExpresswayIcManualSelection(candidates[0], async () => undefined);
  assert.equal(unavailable.address, undefined);

  await db.events.put({ id: 'manual-ic-fixture', tripId: 'manual-trip-fixture', type: 'expressway_end',
    ts: '2026-09-23T00:00:00.000Z', geo: eventGeo, address: '観測地点の住所', syncStatus: 'synced',
    extras: { icName: '以前IC', icResolveStatus: 'pending', icDistanceM: 100,
      icResolveNextRetryAt: '2026-09-24T00:00:00.000Z', icResolveError: 'offline', unrelated: 'retain' } });
  await updateExpresswayIcNameManual('manual-ic-fixture', selected.icName, selected);
  let saved = (await db.events.get('manual-ic-fixture'))!;
  assert.equal(saved.address, selected.address, 'name and address update in the same event mutation');
  assert.deepEqual(saved.geo, eventGeo, 'observed coordinates and accuracy remain intact');
  assert.equal(saved.extras!.icName, selected.icName);
  assert.equal(saved.extras!.icResolvedManually, true);
  assert.equal(saved.extras!.icNameSearchSourceId, 'node/77');
  assert.equal(saved.extras!.icNameSearchAddressUpdated, true);
  assert.equal(saved.extras!.unrelated, 'retain');
  assert.equal(saved.extras!.icDistanceM, undefined);
  assert.equal(saved.extras!.icResolveNextRetryAt, undefined);
  assert.equal(saved.syncStatus, 'pending');
  await assert.rejects(updateExpresswayIcNameManual('manual-ic-fixture', '別名IC', selected));
  assert.equal((await db.events.get('manual-ic-fixture'))!.extras!.icName, selected.icName);

  await updateExpresswayIcNameManual('manual-ic-fixture', '手入力IC');
  saved = (await db.events.get('manual-ic-fixture'))!;
  assert.equal(saved.address, selected.address, 'name-only fallback never guesses an address');
  assert.deepEqual(saved.geo, eventGeo);
  assert.equal(saved.extras!.icNameSearchSourceId, undefined, 'old selection metadata is removed for plain manual edits');

  await updateExpresswayIcNameManual('manual-ic-fixture', unavailable.icName, unavailable);
  saved = (await db.events.get('manual-ic-fixture'))!;
  assert.equal(saved.address, selected.address, 'failed lookup keeps the existing address');
  assert.equal(saved.extras!.icNameSearchAddressUpdated, false);
  await db.events.update('manual-ic-fixture', { address: undefined });
  const originalFetch = globalThis.fetch;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let finishLookup!: () => void;
  let lookupStarted!: () => void;
  const lookupHasStarted = new Promise<void>(resolve => { lookupStarted = resolve; });
  const releaseLookup = new Promise<void>(resolve => { finishLookup = resolve; });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  globalThis.fetch = async () => {
    lookupStarted();
    await releaseLookup;
    return new Response(JSON.stringify({ response: { location: [{
      prefecture: '観測県', city: '観測市', town: '古い住所', distance: 1,
    }] } }));
  };
  try {
    const pendingBackfill = backfillMissingAddresses(1, 1);
    await lookupHasStarted;
    await updateExpresswayIcNameManual('manual-ic-fixture', selected.icName, selected);
    finishLookup();
    assert.equal(await pendingBackfill, false, 'backfill reports only actual updates');
    assert.equal((await db.events.get('manual-ic-fixture'))!.address, selected.address,
      'a late address lookup cannot overwrite the selected IC address');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
  await updateEventAddressManual('manual-ic-fixture', '利用者が直接修正した住所');
  assert.equal(await updateEventAddress('manual-ic-fixture', '後着の補完住所'), false);
  assert.equal((await db.events.get('manual-ic-fixture'))!.address, '利用者が直接修正した住所');
  await db.events.update('manual-ic-fixture', { address: undefined, syncStatus: 'synced' });
  assert.equal(await updateEventAddress('manual-ic-fixture', '新しい補完住所'), true);
  assert.equal((await db.events.get('manual-ic-fixture'))!.syncStatus, 'pending');
  await db.events.delete('manual-ic-fixture');
  await testExplicitAddressRefreshRaces();
  db.close();
}

void withRemoteSyncSignalsSuppressed(main).then(() => console.log('Expressway IC manual name/address edit: passed'));
