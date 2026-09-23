import assert from 'node:assert/strict';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

async function run() {
  const values = new Map<string, string>();
  Object.assign(globalThis, {
    androidBridge: {},
    window: { localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } },
  });
  const { registerPlugin } = await import('@capacitor/core');
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `header.${encode({ sub: 'test-user', iat: 1, exp: 2, email: 'driver@example.com' })}.signature`;
  const native = { configured: true, blocked: false, accessToken: token, refreshToken: 'synthetic-refresh', updatedAt: 1 };
  let getAuthorization: () => Promise<typeof native> = async () => native;
  let refreshCalls = 0;
  registerPlugin('ResidentLocation', { android: {
    getAuthorization: () => getAuthorization(),
    refreshAuthorization: () => { refreshCalls++; return new Promise(() => {}); },
  } });
  const { seedNativeDriverSessionBeforeClient, runBoundedNativeSessionSeed } = await import('./nativeAuthBootstrap');
  const { beginDriverAuthIntent } = await import('./driverAuthMutationLock');
  const { DRIVER_AUTH_STORAGE_KEY, DRIVER_EXPLICIT_SIGN_OUT_KEY } = await import('./authStorageKeys');

  assert.equal(await seedNativeDriverSessionBeforeClient(), true, 'startup uses native persisted enrollment even when refresh would hang');
  assert.equal(refreshCalls, 0, 'pre-client seed performs no network refresh');
  assert.ok(values.has(DRIVER_AUTH_STORAGE_KEY), 'current native session reaches the WebView');
  values.clear();
  getAuthorization = async () => { throw new Error('native read failed'); };
  await assert.rejects(seedNativeDriverSessionBeforeClient(), /native read failed/);
  assert.equal(values.size, 0, 'read failure never creates a session');

  getAuthorization = async () => native;
  Object.assign(globalThis, { indexedDB: { open() { throw new Error('database unavailable'); } } });
  assert.equal(await seedNativeDriverSessionBeforeClient(), true, 'IndexedDB failure can use the current native and localStorage enrollment');
  values.clear();
  for (const invalidate of [
    () => values.set(DRIVER_EXPLICIT_SIGN_OUT_KEY, '1'),
    () => beginDriverAuthIntent(),
  ]) {
    const pending = deferred<typeof native>();
    getAuthorization = () => pending.promise;
    const seed = seedNativeDriverSessionBeforeClient();
    await tick();
    invalidate();
    pending.resolve(native);
    assert.equal(await seed, false, 'logout or a newer auth intent invalidates a pending seed');
    assert.equal(values.has(DRIVER_AUTH_STORAGE_KEY), false, 'stale seed cannot resurrect the old session');
    values.clear();
  }
  {
    const pending = deferred<boolean>();
    let writes = 0;
    const result = await runBoundedNativeSessionSeed(async isActive => {
      await pending.promise;
      if (!isActive()) return false;
      writes++;
      return true;
    }, 10);
    assert.equal(result, false, 'unresponsive native/DB read reaches a finite deadline');
    pending.resolve(true);
    await tick();
    assert.equal(writes, 0, 'deadline prevents late storage writes after client creation');
  }
  {
    const pending = deferred<typeof native>();
    getAuthorization = () => pending.promise;
    assert.equal(await seedNativeDriverSessionBeforeClient(), false, 'a stalled native bridge cannot hold the first render indefinitely');
    pending.resolve(native);
    await tick();
    assert.equal(values.has(DRIVER_AUTH_STORAGE_KEY), false, 'the actual delayed native seed cannot write after its deadline');
  }
  {
    getAuthorization = async () => native;
    Object.assign(globalThis, { indexedDB: { open: () => ({}) } });
    assert.equal(await seedNativeDriverSessionBeforeClient(), false, 'a blocked IndexedDB open also has a startup deadline');
    assert.equal(values.has(DRIVER_AUTH_STORAGE_KEY), false, 'unconfirmed database state does not manufacture a session');
  }
  getAuthorization = async () => ({ ...native, blocked: true });
  assert.equal(await seedNativeDriverSessionBeforeClient(), false, 'blocked native session is not seeded');
  console.log('nativeAuthBootstrap: local-only seed, read failures, bounded waits, and logout races passed');
}
void run();
