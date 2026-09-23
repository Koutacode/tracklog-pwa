import assert from 'node:assert/strict';
import {
  classifyIcResolverHttpStatus,
  getFunctionErrorDetails,
  getRetryableIcResolverErrorCategory,
  runIcResolverNativeSessionRestore,
  runIcResolverSessionTask,
  createIcResolverSessionTaskRunner,
} from './icResolver';
import { computeIcResolveDeferredBackoffMs } from './expresswayIcRetryPolicy';
import { createIcResolverFunctionInvoker } from './icResolverClient';

async function main() {
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
