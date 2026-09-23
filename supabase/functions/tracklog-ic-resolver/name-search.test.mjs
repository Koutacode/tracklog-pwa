import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIcNameSearchQuery, normalizeIcSearchQuery, selectNamedIcCandidates } from './name-search.ts';

// Synthetic map features, unrelated to device trips.
const junction = (id, name, lat = 35, extra = {}) => ({
  type: 'node', id, lat, lon: 139, tags: { highway: 'motorway_junction', name, ...extra },
});

test('search accepts full-width IC spelling and removes a suffix without changing the base name', () => {
  assert.equal(normalizeIcSearchQuery(' 合成ＩＣ '), '合成');
  assert.equal(normalizeIcSearchQuery('合成インターチェンジ'), '合成');
  assert.equal(normalizeIcSearchQuery('津IC'), '津');
  assert.match(buildIcNameSearchQuery('津IC'), /\^津/);
  assert.throws(() => normalizeIcSearchQuery('IC'));
});

test('query escapes regex and string syntax and contains only named IC feature classes', () => {
  const query = buildIcNameSearchQuery('合成.*"\\IC');
  assert.ok(query.includes(JSON.stringify('合成\\.\\*"\\\\')));
  assert.match(query, /"motorway_junction"/);
  assert.match(query, /"toll_booth"/);
  assert.match(query, /"motorway_link"/);
  assert.doesNotMatch(query, /destination|around/);
  assert.match(query, /out body center 100;/);
  assert.throws(() => buildIcNameSearchQuery('合成\nIC'));
});

test('separate faraway names survive; duplicate entrance objects collapse without auto-selecting', () => {
  const results = selectNamedIcCandidates([
    junction(1, '合成インターチェンジ'), junction(2, '合成IC', 35.001),
    junction(3, '合成IC', 36), junction(4, '合成西IC', 35.005),
  ], '合成');
  assert.deepEqual(results.map(r => r.id), ['node/1', 'node/3', 'node/4']);
  assert.equal(results[0].icName, '合成IC');
});

test('destination-only links, unrelated names, broken points and non-IC features are rejected', () => {
  const results = selectNamedIcCandidates([
    { type: 'way', id: 1, center: { lat: 35, lon: 139 }, tags: { highway: 'motorway_link', destination: '合成IC' } },
    junction(2, '別名IC'), junction(3, '合成IC', NaN), junction(4, '合成IC', 80),
    { ...junction(5, '合成IC'), tags: { amenity: 'restaurant', name: '合成IC食堂' } },
  ], '合成');
  assert.deepEqual(results, []);
});

test('a candidate carries its own tagged address and can use a way center', () => {
  const results = selectNamedIcCandidates([
    { type: 'way', id: 10, center: { lat: 35, lon: 139 },
      tags: { highway: 'motorway_link', name: '合成IC入口', 'addr:state': '合成県', 'addr:city': '合成市' } },
  ], '合成IC');
  assert.equal(results[0].icName, '合成IC');
  assert.equal(results[0].address, '合成県合成市');
});

test('partial address tags never become replacement addresses', () => {
  for (const tags of [
    { 'addr:housenumber': '1' }, { 'addr:city': '合成市' }, { 'addr:street': '合成通り' },
    { 'addr:state': '合成県', 'addr:city': ' ' },
  ]) {
    const [candidate] = selectNamedIcCandidates([junction(1, '合成IC', 35, tags)], '合成');
    assert.equal(candidate.address, undefined, 'incomplete tags must fall through to public-feature reverse lookup');
  }
  const [candidate] = selectNamedIcCandidates([junction(1, '合成IC', 35, { 'addr:full': '合成県合成市完全住所' })], '合成');
  assert.equal(candidate.address, '合成県合成市完全住所');
});
