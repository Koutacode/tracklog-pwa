import assert from 'node:assert/strict';
import {
  classifyIcResolverHttpStatus,
  getFunctionErrorDetails,
  getRetryableIcResolverErrorCategory,
  runIcResolverNativeSessionRestore,
} from './icResolver';
import { computeIcResolveDeferredBackoffMs } from './expresswayIcRetryPolicy';

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
  console.log('icResolver: native refresh recovery assertions passed');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
