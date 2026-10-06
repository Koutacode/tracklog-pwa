import assert from 'node:assert/strict';
import test from 'node:test';
import { findNearbyIcCatalogCandidates, resolveIcCatalogCandidates, lookupJapanIcCatalog } from './index.ts';

// Synthetic positions/names, unrelated to real trips or public catalogue data.
const point = (id, name, distance, kind = 1) => [id, name, 35 + distance / 6371000 * 180 / Math.PI, 139, kind];

test('offline catalogue search returns all nearby candidates with explicit uncertainty', () => {
  const matches = findNearbyIcCatalogCandidates([
    point('a', '合成北IC', 100), point('b', '合成南IC', 150), point('c', '遠いIC', 1300),
  ], 35, 139);
  const result = resolveIcCatalogCandidates(matches);
  assert.deepEqual(result.candidates, ['合成北IC', '合成南IC']);
  assert.equal(result.confidence, 'estimated');
  assert.equal(result.estimateSource, 'mlit_n06_2025');
  assert.equal(result.sourceDatasetDate, '2025-12-31');
  assert.match(result.note, /入口・出口・進行方向は未確認/);
  assert.equal('onExpresswayRoad' in result, false);
  assert.equal('nearEtcGate' in result, false);
});

test('distance acceptance is bounded before rounding', () => {
  const matches = findNearbyIcCatalogCandidates([
    point('a', '境界内IC', 1200), point('b', '境界外IC', 1200.1),
  ], 35, 139);
  assert.deepEqual(matches.candidates.map(c => c.id), ['a']);
});

test('preserves official labels, compatible entrance/exit names and smart ICs', () => {
  const entries = [point('a', '合成入口', 10), point('b', '合成出口', 20),
    point('c', '合成', 30), point('d', '合成スマートIC', 40, 2)];
  const start = resolveIcCatalogCandidates(findNearbyIcCatalogCandidates(entries, 35, 139, { eventType: 'expressway_start' }));
  const end = resolveIcCatalogCandidates(findNearbyIcCatalogCandidates(entries, 35, 139, { eventType: 'expressway_end' }));
  assert.deepEqual(start.candidates, ['合成入口', '合成', '合成スマートIC']);
  assert.deepEqual(end.candidates, ['合成出口', '合成', '合成スマートIC']);
  assert.equal(start.candidates.some(name => name === '合成IC入口'), false);
});

test('invalid data and JCT/other joints never produce IC candidates', () => {
  const entries = [point('a', '合成JCT', 10, 3), point('b', '合成PA', 10, 4),
    ['c', '壊れたIC', NaN, 139, 1], point('d', ' ', 20)];
  assert.equal(resolveIcCatalogCandidates(findNearbyIcCatalogCandidates(entries, 35, 139)), null);
  assert.throws(() => lookupJapanIcCatalog(NaN, 139), /座標/);
});

test('overflow does not silently select the nearest twelve ICs', () => {
  const entries = Array.from({ length: 13 }, (_, i) => point(`id-${i}`, `合成${i}IC`, 100 + i));
  const matches = findNearbyIcCatalogCandidates(entries, 35, 139);
  assert.equal(matches.totalCandidates, 13);
  assert.equal(matches.candidates.length, 12);
  assert.equal(matches.overflow, true);
  assert.equal(resolveIcCatalogCandidates(matches), null);
});

test('same-name separate public features remain distinct and ordering is deterministic', () => {
  const entries = [point('b', '同名IC', 100), point('a', '同名IC', 100), point('a', '同名IC', 100)];
  const matches = findNearbyIcCatalogCandidates(entries, 35, 139);
  assert.deepEqual(matches.candidates.map(c => c.id), ['a', 'b']);
  assert.equal(matches.totalCandidates, 2);
  assert.deepEqual(resolveIcCatalogCandidates(matches).candidates, ['同名IC']);
});
