import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveExpresswayIcName } from './ic-name-resolution.ts';

const localCandidate = {
  icName: '試験接続点', distanceM: 240, confidence: 'estimated',
  candidates: ['試験接続点', '隣接接続点'], estimateSource: 'mlit_n06_2025',
  sourceDatasetDate: '2025-12-31',
  sourceUrls: ['https://example.test/public-catalog'],
  note: '公開点に近い候補。利用した入口・出口・進行方向は未確認。',
};

test('catalog name resolution needs no external lookup and has no road-occupancy fields', async () => {
  let requests = 0;
  const result = await resolveExpresswayIcName(30, 130, 8000, { eventType: 'expressway_start' }, {
    catalogLookup: () => localCandidate,
    roadLookup: async () => { requests += 1; throw new Error('upstream unavailable'); },
  });
  assert.equal(requests, 0);
  assert.equal(result.icName, '試験接続点（推定）');
  assert.equal(result.confidence, 'estimated');
  assert.deepEqual(result.candidates, localCandidate.candidates);
  assert.equal(result.sourceDatasetDate, '2025-12-31');
  assert.equal('onExpresswayRoad' in result, false);
  assert.equal('nearEtcGate' in result, false);
  assert.equal('resolved' in result, false);
});

test('catalog estimates retain their complete source and never gain entrance or direction claims', async () => {
  const result = await resolveExpresswayIcName(30, 130, 8000, { eventType: 'expressway_end', travelBearing: 180 }, {
    catalogLookup: () => localCandidate,
    roadLookup: async () => { throw new Error('must not be called'); },
  });
  assert.deepEqual(result.sourceUrls, localCandidate.sourceUrls);
  assert.equal(result.note, localCandidate.note);
  assert.equal(/入口|出口|上り|下り/u.test(result.icName), false);
});

test('a catalog miss forwards the event context to the bounded map lookup', async () => {
  let received;
  const mapCandidate = { icName: '試験出口（推定）', distanceM: 130, confidence: 'estimated', candidates: ['試験出口'] };
  const result = await resolveExpresswayIcName(30, 130, 8000, { eventType: 'expressway_end', travelBearing: 210 }, {
    catalogLookup: () => null,
    roadLookup: async (...args) => {
      received = args;
      return { resolved: true, provider: 'overpass', onExpresswayRoad: true, nearIc: true,
        nearEtcGate: false, nearestIc: mapCandidate, cached: false };
    },
  });
  assert.deepEqual(received, [30, 130, 8000, { eventType: 'expressway_end', travelBearing: 210 }]);
  assert.deepEqual(result, mapCandidate);
});

test('an external failure after a catalog miss remains a failure, not an empty success', async () => {
  await assert.rejects(resolveExpresswayIcName(30, 130, 8000, {}, {
    catalogLookup: () => null,
    roadLookup: async () => { throw new Error('bounded upstream failure'); },
  }), /bounded upstream failure/);
});

test('a valid map-data miss stays null rather than inventing an interchange', async () => {
  const result = await resolveExpresswayIcName(30, 130, 8000, {}, {
    catalogLookup: () => null,
    roadLookup: async () => ({ resolved: true, provider: 'overpass', onExpresswayRoad: false,
      nearIc: false, nearEtcGate: false, nearestIc: null, cached: false }),
  });
  assert.equal(result, null);
});
