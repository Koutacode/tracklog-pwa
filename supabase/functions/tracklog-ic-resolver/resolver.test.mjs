import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeOverpassElements,
  buildOverpassUnionQuery,
  clearResolverCacheForTests,
  fetchOverpassElements,
  normalizeIcCandidateName,
  resolveExpresswayFromOverpass,
} from './resolver.ts';

test('buildOverpassUnionQuery includes all candidate classes in one union', () => {
  const query = buildOverpassUnionQuery(35.681236, 139.767125, 8000);
  assert.equal((query.match(/\[out:json\]/g) ?? []).length, 1);
  assert.match(query, /"highway"="motorway_junction"/);
  assert.match(query, /"barrier"="toll_booth"/);
  assert.match(query, /"highway"="toll_gantry"/);
  assert.match(query, /"highway"="motorway_link"/);
  assert.match(query, /"highway"="motorway"/);
  assert.match(query, /out body center;/);
});

test('normalizes Japanese junction and motorway link names', () => {
  assert.equal(normalizeIcCandidateName('厚木インターチェンジ', 'junction'), '厚木IC');
  assert.equal(normalizeIcCandidateName('木更津東出口', 'motorway_link'), '木更津東IC');
  assert.equal(normalizeIcCandidateName('E1', 'junction'), null);
});

test('ranks a named junction ahead of auxiliary toll and road candidates', () => {
  const elements = [
    {
      type: 'node',
      id: 1,
      lat: 35.001,
      lon: 139,
      tags: { highway: 'motorway_junction', name: '厚木インターチェンジ' },
    },
    {
      type: 'node',
      id: 2,
      lat: 35.0001,
      lon: 139,
      tags: { barrier: 'toll_booth', name: '厚木料金所' },
    },
    {
      type: 'way',
      id: 3,
      center: { lat: 35.0002, lon: 139 },
      tags: { highway: 'motorway_link', destination: '厚木出口' },
    },
    {
      type: 'way',
      id: 4,
      center: { lat: 35.01, lon: 139 },
      tags: { highway: 'motorway', name: '東名高速道路' },
    },
  ];

  const result = analyzeOverpassElements(elements, 35, 139);
  assert.deepEqual(result.nearestIc, { icName: '厚木IC', distanceM: 111 });
  assert.equal(result.nearIc, true);
  assert.equal(result.nearEtcGate, true);
  assert.equal(result.onExpresswayRoad, true);
});

test('retries all endpoints after a failed round', async () => {
  const calls = [];
  const fetchImpl = async endpoint => {
    calls.push(endpoint);
    if (calls.length < 3) return new Response('', { status: 503 });
    return new Response(JSON.stringify({ elements: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const elements = await fetchOverpassElements('query', {
    endpoints: ['https://one.invalid', 'https://two.invalid'],
    fetchImpl,
    retryRounds: 2,
    timeoutMs: 100,
    sleep: async () => undefined,
  });
  assert.deepEqual(elements, []);
  assert.deepEqual(calls, [
    'https://one.invalid',
    'https://two.invalid',
    'https://one.invalid',
  ]);
});

test('applies timeout per endpoint before falling back', async () => {
  const calls = [];
  const fetchImpl = async (endpoint, init) => {
    calls.push(endpoint);
    if (endpoint === 'https://slow.invalid') {
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    return new Response(JSON.stringify({ elements: [] }), { status: 200 });
  };

  const elements = await fetchOverpassElements('query', {
    endpoints: ['https://slow.invalid', 'https://fast.invalid'],
    fetchImpl,
    retryRounds: 1,
    timeoutMs: 50,
  });
  assert.deepEqual(elements, []);
  assert.deepEqual(calls, ['https://slow.invalid', 'https://fast.invalid']);
});

test('reuses the in-memory cache for the same location cell', async () => {
  clearResolverCacheForTests();
  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({
      elements: [
        {
          type: 'node',
          id: 10,
          lat: 35.001,
          lon: 139,
          tags: { highway: 'motorway_junction', 'name:ja': '厚木IC' },
        },
      ],
    }), { status: 200 });
  };
  const options = {
    endpoints: ['https://cache.invalid'],
    fetchImpl,
    retryRounds: 1,
    timeoutMs: 100,
    now: () => 1000,
  };

  const first = await resolveExpresswayFromOverpass(35, 139, 8000, options);
  const second = await resolveExpresswayFromOverpass(35.0004, 139.0004, 8000, options);
  assert.equal(fetchCount, 1);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.nearestIc?.icName, '厚木IC');
});
