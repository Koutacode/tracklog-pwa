import assert from 'node:assert/strict';
import { analyzeOverpassElements } from '../../supabase/functions/tracklog-ic-resolver/resolver';
import { getExpresswayIcDisplay } from '../domain/expresswayIcDisplay';
import {
  classifyIcResolverHttpStatus,
  parseIcResult,
  createNearestIcResolver,
  getFunctionErrorDetails,
  getRetryableIcResolverErrorCategory,
  runIcResolverNativeSessionRestore,
  runIcResolverSessionTask,
  createIcResolverSessionTaskRunner,
} from './icResolver';
import { computeIcResolveDeferredBackoffMs } from './expresswayIcRetryPolicy';
import { createIcResolverFunctionInvoker } from './icResolverClient';

async function main() {
  const parsed = parseIcResult({ icName: '合成入口', distanceM: 10.2, confidence: 'estimated',
    candidates: ['合成入口', '別合成入口'], sourceUrls: ['https://www.openstreetmap.org/copyright'], note: 'direction unknown' });
  assert.equal(parsed?.confidence, 'estimated');
  assert.deepEqual(parsed?.candidates, ['合成入口', '別合成入口']);
  assert.equal(parseIcResult({ icName: '旧サーバー候補', distanceM: 50 })?.confidence, 'estimated',
    'old proximity-only responses cannot silently become confirmed IC names');
  assert.throws(() => parseIcResult({ icName: '合成入口', distanceM: 10, confidence: 'confirmed' }), /確度/);
  assert.throws(() => parseIcResult({ icName: '合成入口', distanceM: 10, candidates: [null] }), /候補一覧/);
  // Exercise the deployed server/client contract with anonymous map elements.
  const signal = analyzeOverpassElements([
    { type: 'node', lat: 35, lon: 139, tags: { highway: 'motorway_junction', name: '合成入口' } },
    { type: 'node', lat: 35.0001, lon: 139, tags: { highway: 'motorway_junction', name: '別合成入口' } },
  ], 35, 139, { eventType: 'expressway_start' });
  const wireCandidate = signal.nearestIc!;
  assert.equal(signal.nearIc, true, 'native road proximity remains available with an estimated IC name');
  assert.equal(wireCandidate.icName, '合成入口（推定）', 'old APKs retain uncertainty when they discard confidence');
  assert.ok(wireCandidate.icName.length <= 80, 'the old client name-length validation remains compatible');
  const legacySaved = { icName: wireCandidate.icName, icDistanceM: wireCandidate.distanceM, icResolveStatus: 'resolved' };
  assert.equal(getExpresswayIcDisplay(legacySaved).state, 'estimated', 'an old APK sync cannot promote this candidate');
  const currentCandidate = parseIcResult(wireCandidate)!;
  assert.equal(currentCandidate.icName, wireCandidate.icName, 'the backwards-compatible display suffix is preserved');
  assert.deepEqual(currentCandidate.candidates, ['合成入口', '別合成入口'], 'the display suffix does not add a duplicate candidate');
  assert.equal(currentCandidate.confidence, 'estimated');

  const catalogCandidate = parseIcResult({ icName: '合成公的IC', distanceM: 80, confidence: 'estimated',
    candidates: ['合成公的IC'], estimateSource: 'mlit_n06_2025', sourceDatasetDate: '2025-12-31',
    sourceUrls: ['https://example.invalid/public-dataset'], note: '2025-12-31現況の近傍候補。入口・出口・進行方向未確認。' })!;
  assert.equal(catalogCandidate.icName, '合成公的IC（推定）', 'catalog candidates remain visibly estimated for older clients');
  assert.equal(catalogCandidate.estimateSource, 'mlit_n06_2025');
  assert.equal(catalogCandidate.sourceDatasetDate, '2025-12-31');
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  let upstreamCalls = 0;
  const localResolver = createNearestIcResolver((_lat, _lon, context) => {
    assert.equal(context?.eventType, 'expressway_start');
    return catalogCandidate;
  }, async () => { upstreamCalls += 1; throw new Error('catalog hit must not use a server'); });
  assert.deepEqual(await localResolver(35, 139, undefined, { eventType: 'expressway_start' }), catalogCandidate);
  assert.equal(upstreamCalls, 0, 'a catalog hit skips login, Edge, and external map requests');
  const remoteResolver = createNearestIcResolver(() => null, async request => {
    upstreamCalls += 1;
    assert.deepEqual(request, { action: 'resolve-name', lat: 35, lon: 139, radiusM: 8000, eventType: 'expressway_end' });
    return { icName: '合成補助出口（推定）', distanceM: 90, confidence: 'estimated', estimateSource: 'overpass_nearby' };
  });
  assert.equal((await remoteResolver(35, 139, undefined, { eventType: 'expressway_end' }))?.icName, '合成補助出口（推定）');
  assert.equal(upstreamCalls, 1, 'a catalog miss uses the IC-name action only once');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } });
  try {
    assert.deepEqual(await localResolver(35, 139, undefined, { eventType: 'expressway_start' }), catalogCandidate);
    assert.equal(await remoteResolver(35, 139, undefined, { eventType: 'expressway_end' }), null);
    assert.equal(upstreamCalls, 1, 'offline lookup uses the catalog and never the network');
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }

  const stalledError = Object.assign(new Error('server unavailable'), {
    context: new Response(new ReadableStream({ start() {} }), { status: 503 }),
  });
  const stalledResult = await getFunctionErrorDetails(stalledError, 10);
  assert.deepEqual(stalledResult, { message: 'server unavailable', status: 503 });
  const normalError = Object.assign(new Error('generic failure'), {
    context: new Response(JSON.stringify({ error: 'Device is not approved' }), { status: 403 }),
  });
  assert.deepEqual(await getFunctionErrorDetails(normalError), { message: 'Device is not approved', status: 403 });
  let calls = 0;
  await runIcResolverNativeSessionRestore(async () => { calls += 1; return false; });
  assert.equal(calls, 1, 'a completed restore is allowed even when no session was restored');
  await assert.rejects(
    runIcResolverNativeSessionRestore(() => new Promise(() => {}), 10),
    failure => getRetryableIcResolverErrorCategory(failure) === 'temporary',
    'a stalled native bridge releases the IC worker instead of pinning all later events',
  );
  await assert.rejects(
    runIcResolverSessionTask(() => new Promise(() => {}), 10),
    failure => getRetryableIcResolverErrorCategory(failure) === 'temporary',
    'session lock waits are bounded even outside the native bridge call',
  );
  const sharedSessionTask = createIcResolverSessionTaskRunner<string>(10);
  let sessionAttempts = 0;
  const firstAttempt = sharedSessionTask(() => {
    sessionAttempts += 1;
    return new Promise(() => {});
  });
  assert.equal(sharedSessionTask(async () => 'unused'), firstAttempt, 'concurrent refresh waiters share one task');
  await assert.rejects(firstAttempt, failure => getRetryableIcResolverErrorCategory(failure) === 'temporary');
  assert.equal(await sharedSessionTask(async () => { sessionAttempts += 1; return 'recovered'; }), 'recovered');
  assert.equal(sessionAttempts, 2, 'a timed-out shared task does not trap the next recovery in its old promise');
  for (const error of [
    new Error('SocketTimeoutException'),
    new Error('認証情報を更新できませんでした。'),
    { message: 'native bridge unavailable' },
  ]) {
    await assert.rejects(
      runIcResolverNativeSessionRestore(async () => { throw error; }),
      failure => {
        const category = getRetryableIcResolverErrorCategory(failure);
        assert.equal(category, 'temporary', 'bridge/refresh failure is not a rejected login');
        assert.equal(computeIcResolveDeferredBackoffMs(category!, 1), 15_000);
        return true;
      },
    );
  }
  assert.equal(classifyIcResolverHttpStatus(401), 'authorization-recoverable');
  assert.equal(classifyIcResolverHttpStatus(403), 'authorization-recoverable');
  assert.equal(computeIcResolveDeferredBackoffMs('authorization-recoverable', 1), 900_000);
  const requests: string[] = [];
  const invoke = createIcResolverFunctionInvoker('https://synthetic.example', 'synthetic-key', async (input, init) => {
    requests.push(String(input));
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic-token');
    assert.equal(new Headers(init?.headers).get('apikey'), 'synthetic-key');
    assert.equal(init?.method, 'POST');
    return new Response(JSON.stringify({ ok: true, data: { icName: '合成IC' } }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const result = await invoke<{ ok: boolean; data: { icName: string } }>('synthetic-token', { deviceId: 'synthetic-device' });
  assert.equal(result.error, null);
  assert.equal(result.data?.data.icName, '合成IC');
  assert.deepEqual(requests, ['https://synthetic.example/functions/v1/tracklog-ic-resolver'],
    'an already acquired token reaches the function without any second auth request');

  let capturedSignal: AbortSignal | null | undefined;
  const stalledInvoke = createIcResolverFunctionInvoker('https://synthetic.example', 'synthetic-key', async (_input, init) => {
    capturedSignal = init?.signal;
    return new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'application/json' } });
  });
  await assert.rejects(stalledInvoke('synthetic-token', {}, 10), /タイムアウト/,
    'a success response with a stalled body is bounded even when the transport ignores abort');
  assert.equal(capturedSignal?.aborted, true);
  console.log('icResolver: native refresh recovery assertions passed');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
