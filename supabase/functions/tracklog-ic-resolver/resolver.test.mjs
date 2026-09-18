import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeOverpassElements,
  buildOverpassUnionQuery,
  clearResolverCacheForTests,
  fetchOverpassElements,
  normalizeIcCandidateName,
  OverpassUnavailableError,
  rankIcCandidates,
  resolveExpresswayFromOverpass,
} from './resolver.ts';

// Synthetic points with exact distances, unrelated to any recorded trip.
function elementAtDistance(distanceM, tags) {
  return {
    type: 'node',
    lat: 35 + distanceM / 6371000 * 180 / Math.PI,
    lon: 139,
    tags,
  };
}

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

test('selects an acceptable runner-up when the top-scored junction is too far away', () => {
  const elements = [
    elementAtDistance(1400, { highway: 'motorway_junction', name: '遠方IC' }),
    elementAtDistance(1150, { barrier: 'toll_booth', name: '近傍料金所' }),
  ];
  assert.equal(rankIcCandidates(elements, 35, 139)[0].icName, '遠方IC');

  const result = analyzeOverpassElements(elements, 35, 139);
  assert.deepEqual(result.nearestIc, { icName: '近傍料金所', distanceM: 1150 });
  assert.equal(result.nearIc, true);
  assert.equal(result.onExpresswayRoad, false);
  assert.equal(result.nearEtcGate, false);
});

test('filters distance before merging junction and toll candidates with the same name', () => {
  const elements = [
    elementAtDistance(1400, { highway: 'motorway_junction', name: '同名IC' }),
    elementAtDistance(1150, { barrier: 'toll_booth', name: '同名IC' }),
  ];
  assert.equal(rankIcCandidates(elements, 35, 139)[0].distanceM, 1400);
  assert.deepEqual(analyzeOverpassElements(elements, 35, 139).nearestIc, {
    icName: '同名IC', distanceM: 1150,
  });
});

test('keeps primary and corroborated distance acceptance limits without widening them', () => {
  const nearGate = elementAtDistance(100, { barrier: 'toll_booth' });
  const nearRoad = elementAtDistance(100, { highway: 'motorway', name: '高速道路' });
  const scenarios = [
    { distanceM: 1200, evidence: [], accepted: true },
    { distanceM: 1201, evidence: [], accepted: false },
    { distanceM: 1800, evidence: [nearGate], accepted: false },
    { distanceM: 1800, evidence: [nearRoad], accepted: false },
    { distanceM: 2000, evidence: [nearGate, nearRoad], accepted: true },
    { distanceM: 2001, evidence: [nearGate, nearRoad], accepted: false },
  ];

  for (const { distanceM, evidence, accepted } of scenarios) {
    const result = analyzeOverpassElements([
      elementAtDistance(distanceM, { highway: 'motorway_junction', name: '境界IC' }),
      ...evidence,
    ], 35, 139);
    assert.deepEqual(result.nearestIc, accepted ? { icName: '境界IC', distanceM } : null,
      `distance=${distanceM}, evidence=${evidence.length}`);
    assert.equal(result.nearIc, distanceM <= 1200);
  }
});

test('nearIc reflects a nearby candidate even when a corroborated farther name wins ranking', () => {
  const result = analyzeOverpassElements([
    elementAtDistance(1400, { highway: 'motorway_junction', name: '同名IC' }),
    elementAtDistance(1150, { barrier: 'toll_booth', name: '同名IC' }),
    elementAtDistance(100, { barrier: 'toll_booth' }),
    elementAtDistance(100, { highway: 'motorway' }),
  ], 35, 139);
  assert.deepEqual(result.nearestIc, { icName: '同名IC', distanceM: 1400 });
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

test('times out a body stalled after successful headers and falls back', { timeout: 2000 }, async () => {
  const calls = [];
  let slowSignal;
  const expected = [elementAtDistance(100, { highway: 'motorway_junction', name: '復旧IC' })];
  const fetchImpl = async (endpoint, init) => {
    calls.push(endpoint);
    if (endpoint === 'https://slow-body.invalid') {
      slowSignal = init.signal;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"elements":'));
          // Headers and part of the body arrived, but the stream never ends.
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ elements: expected }), { status: 200 });
  };

  const elements = await fetchOverpassElements('query', {
    endpoints: ['https://slow-body.invalid', 'https://fast.invalid'],
    fetchImpl,
    retryRounds: 1,
    timeoutMs: 50,
  });
  assert.deepEqual(elements, expected);
  assert.deepEqual(calls, ['https://slow-body.invalid', 'https://fast.invalid']);
  assert.equal(slowSignal.aborted, true);
});

for (const partialElements of [[], [elementAtDistance(100, { highway: 'motorway_junction', name: '部分IC' })]]) {
  test(`falls back from HTTP 200 runtime error with ${partialElements.length ? 'partial' : 'empty'} elements`, async () => {
    const calls = [];
    const expected = [elementAtDistance(100, { highway: 'motorway_junction', name: '完全IC' })];
    const elements = await fetchOverpassElements('query', {
      endpoints: ['https://failed-query.invalid', 'https://complete.invalid'],
      retryRounds: 1,
      fetchImpl: async endpoint => {
        calls.push(endpoint);
        return new Response(JSON.stringify(endpoint === 'https://failed-query.invalid'
          ? { elements: partialElements, remark: 'runtime error: Query timed out' }
          : { elements: expected }), { status: 200 });
      },
    });
    assert.deepEqual(elements, expected);
    assert.deepEqual(calls, ['https://failed-query.invalid', 'https://complete.invalid']);
  });
}

test('exhausted runtime errors stay retryable and are not cached as no IC found', async () => {
  clearResolverCacheForTests();
  let fetchCount = 0;
  let available = false;
  const options = {
    endpoints: ['https://one.invalid', 'https://two.invalid'],
    retryRounds: 2,
    sleep: async () => undefined,
    now: () => 1000,
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response(JSON.stringify(available
        ? { elements: [elementAtDistance(100, { highway: 'motorway_junction', name: '復旧IC' })] }
        : { elements: [], remark: 'runtime error: Query ran out of memory' }), { status: 200 });
    },
  };

  await assert.rejects(resolveExpresswayFromOverpass(35, 139, 8000, options), error => {
    assert.ok(error instanceof OverpassUnavailableError);
    assert.match(error.message, /after 4 attempts/);
    return true;
  });
  assert.equal(fetchCount, 4);
  available = true;
  const result = await resolveExpresswayFromOverpass(35, 139, 8000, options);
  assert.equal(fetchCount, 5);
  assert.equal(result.cached, false);
  assert.deepEqual(result.nearestIc, { icName: '復旧IC', distanceM: 100 });
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
