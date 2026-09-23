import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { AUTH_CLEARED_KEY_SUFFIX, DRIVER_AUTH_STORAGE_KEY } from './authStorageKeys';
import { createMirroredAuthStorage, type AuthStorageAdapter } from './supabase';
import { buildNativeBootstrappedSession } from './nativeResidentSessionPolicy';
import {
  createNativeOwnedAuthStorage,
  isNativeAccessTokenUsableBySdk,
  NATIVE_AUTH_SDK_REFRESH_MARGIN_MS,
} from './nativeOwnedAuthStorage';
import { resolveUnapprovedNativeLocationAction } from '../app/nativeResidentLocationPolicy';

class MemoryStorage implements AuthStorageAdapter {
  readonly values = new Map<string, string>();
  writes = 0;
  removals = 0;
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.writes++; this.values.set(key, value); }
  removeItem(key: string) { this.removals++; this.values.delete(key); }
}

function jwt(iat: number, exp: number) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ sub: 'synthetic-user', email: 'driver@example.com', iat, exp })}.${encode('synthetic-signature')}`;
}
function session(nowMs: number, remainingMs: number) {
  const expiresAt = (nowMs + remainingMs) / 1000;
  return JSON.stringify({
    access_token: jwt(nowMs / 1000 - 3600, expiresAt), refresh_token: 'synthetic-refresh', expires_at: expiresAt,
    user: { id: 'synthetic-user', email: 'driver@example.com' },
  });
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

async function run() {
  const require = createRequire(import.meta.url);
  const authPackage = require.resolve('@supabase/auth-js/package.json');
  const sdk = require(join(dirname(authPackage), 'dist/main/lib/constants.js')) as { EXPIRY_MARGIN_MS: number };
  assert.equal(NATIVE_AUTH_SDK_REFRESH_MARGIN_MS, sdk.EXPIRY_MARGIN_MS,
    'dependency upgrades must review the native guard when the SDK refresh margin changes');

  const nowMs = 1_800_000_000_000;
  const boundaryRaw = new MemoryStorage();
  const boundary = createNativeOwnedAuthStorage(boundaryRaw, () => nowMs);
  for (const [remaining, exposed] of [[-1, false], [0, false], [89_999, false], [90_000, false], [90_001, true], [300_000, true]] as const) {
    const raw = session(nowMs, remaining);
    boundaryRaw.values.set(DRIVER_AUTH_STORAGE_KEY, raw);
    assert.equal(await boundary.getItem(DRIVER_AUTH_STORAGE_KEY), exposed ? raw : null,
      'SDK visibility follows the expiry margin without erasing durable credentials');
    assert.equal(boundaryRaw.getItem(DRIVER_AUTH_STORAGE_KEY), raw, 'filtered reads retain their original persisted session');
    assert.equal(isNativeAccessTokenUsableBySdk(JSON.parse(raw).access_token, nowMs), exposed,
      'native setSession guard uses the same token expiry boundary');
  }
  for (const raw of [
    'invalid-json', '{}', 'null',
    JSON.stringify({ ...JSON.parse(session(nowMs, 300_000)), expires_at: 1 }),
    JSON.stringify({ ...JSON.parse(session(nowMs, -1)), expires_at: nowMs / 1000 + 3600 }),
    JSON.stringify({ ...JSON.parse(session(nowMs, 300_000)), refresh_token: '' }),
  ]) {
    boundaryRaw.values.set(DRIVER_AUTH_STORAGE_KEY, raw);
    assert.equal(await boundary.getItem(DRIVER_AUTH_STORAGE_KEY), null, 'malformed or inconsistent expiry cannot trigger SDK recovery');
    assert.equal(boundaryRaw.getItem(DRIVER_AUTH_STORAGE_KEY), raw, 'invalid data remains available to the native recovery path');
  }
  assert.equal(boundaryRaw.writes, 0);
  assert.equal(boundaryRaw.removals, 0);
  const verifierKey = `${DRIVER_AUTH_STORAGE_KEY}-code-verifier`;
  await boundary.setItem(verifierKey, 'synthetic-pkce-verifier');
  assert.equal(await boundary.getItem(verifierKey), 'synthetic-pkce-verifier', 'PKCE reads and writes remain transparent');
  await boundary.removeItem(verifierKey);
  assert.equal(await boundary.getItem(verifierKey), null, 'PKCE cleanup remains transparent');

  const actualNow = Date.now();
  const nowSeconds = Math.floor(actualNow / 1000);
  const expiredNativeAccess = jwt(nowSeconds - 120, nowSeconds - 60);
  const nativeSnapshot = buildNativeBootstrappedSession({
    nativeAccessToken: expiredNativeAccess, nativeRefreshToken: 'synthetic-native-refresh',
    persistedRaw: session(actualNow - 7_200_000, 3_600_000),
  });
  assert.ok(nativeSnapshot, 'the real bootstrap policy can retain an expired native snapshot for recovery');
  const local = new MemoryStorage();
  const indexed = new MemoryStorage();
  local.values.set(DRIVER_AUTH_STORAGE_KEY, nativeSnapshot);
  indexed.values.set(DRIVER_AUTH_STORAGE_KEY, nativeSnapshot);
  local.values.set(verifierKey, 'synthetic-pkce-verifier');
  indexed.values.set(verifierKey, 'synthetic-pkce-verifier');
  const rawStorage = createMirroredAuthStorage(local, indexed);
  const sdkStorage = createNativeOwnedAuthStorage(rawStorage);
  const requests: Array<{ path: string; authorization: string | null }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({ path: url.pathname + url.search, authorization: new Headers(init?.headers).get('Authorization') });
    if (url.pathname !== '/auth/v1/user') {
      return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Unexpected synthetic Auth refresh' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ id: 'synthetic-user', email: 'driver@example.com' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = createClient('https://synthetic.invalid', 'synthetic-api-key', {
    global: { fetch: fakeFetch },
    auth: { storageKey: DRIVER_AUTH_STORAGE_KEY, storage: sdkStorage, autoRefreshToken: false, persistSession: true, detectSessionInUrl: false, flowType: 'pkce' },
  });
  const events: Array<{ event: string; hasSession: boolean }> = [];
  const subscription = client.auth.onAuthStateChange((event, current) => { events.push({ event, hasSession: !!current }); });
  await client.auth.initialize();
  await tick();
  assert.equal(requests.length, 0, 'SDK INITIAL_SESSION must not refresh an expired native snapshot');
  assert.deepEqual(events, [{ event: 'INITIAL_SESSION', hasSession: false }], 'hidden stale session emits initial null, never SIGNED_OUT');
  assert.equal((await client.auth.getSession()).data.session, null, 'explicit SDK getSession also leaves refresh with the native owner');
  assert.equal(await rawStorage.getItem(DRIVER_AUTH_STORAGE_KEY), nativeSnapshot, 'raw recovery adapter still exposes the original native snapshot');
  assert.equal(local.getItem(DRIVER_AUTH_STORAGE_KEY), indexed.getItem(DRIVER_AUTH_STORAGE_KEY), 'both durable copies survive SDK initialization');
  assert.equal(local.getItem(`${DRIVER_AUTH_STORAGE_KEY}${AUTH_CLEARED_KEY_SUFFIX}`), null, 'initial null does not create a logout tombstone');
  assert.equal(local.getItem(verifierKey), 'synthetic-pkce-verifier', 'initial null does not clear the PKCE verifier');
  assert.equal(local.writes + local.removals + indexed.writes + indexed.removals, 0, 'SDK initialization only observes the hidden session');
  assert.equal(resolveUnapprovedNativeLocationAction({ authInitialized: false, approvalStatus: 'unregistered', explicitSignOutRequested: false }),
    'preserve-native-auth', 'existing tracking policy does not clear native auth for a temporary missing WebView session');

  const freshAccess = jwt(nowSeconds, nowSeconds + 3600);
  const user = await client.auth.getUser(freshAccess);
  assert.equal(user.error, null, 'explicit getUser still validates the native token while stored SDK session is hidden');
  assert.equal(requests[0].authorization, `Bearer ${freshAccess}`, 'user validation uses exactly the explicit native token');
  assert.equal(await rawStorage.getItem(DRIVER_AUTH_STORAGE_KEY), nativeSnapshot, 'explicit user validation cannot erase the hidden session');
  assert.equal(local.getItem(verifierKey), 'synthetic-pkce-verifier');

  assert.equal(isNativeAccessTokenUsableBySdk(freshAccess), true);
  const restored = await client.auth.setSession({ access_token: freshAccess, refresh_token: 'synthetic-new-native-refresh' });
  assert.equal(restored.error, null, 'a refreshed native session can still be installed normally');
  assert.equal((await client.auth.getSession()).data.session?.access_token, freshAccess, 'subsequent reads expose the freshly installed session');
  assert.ok(events.some(entry => entry.event === 'SIGNED_IN' && entry.hasSession), 'successful native installation emits normal signed-in state');
  assert.equal(events.some(entry => entry.event === 'SIGNED_OUT'), false, 'native recovery does not manufacture logout');
  assert.equal(requests.every(request => request.path === '/auth/v1/user'), true, 'neither initialization, getSession, nor fresh installation sent a refresh-token request');

  local.values.set(DRIVER_AUTH_STORAGE_KEY, nativeSnapshot);
  indexed.values.set(DRIVER_AUTH_STORAGE_KEY, nativeSnapshot);
  const signedOut = await client.auth.signOut({ scope: 'local' });
  assert.equal(signedOut.error, null, 'explicit logout works even when the expired session is hidden');
  assert.equal(await rawStorage.getItem(DRIVER_AUTH_STORAGE_KEY), null, 'explicit logout removes both durable session copies');
  assert.equal(local.getItem(`${DRIVER_AUTH_STORAGE_KEY}${AUTH_CLEARED_KEY_SUFFIX}`), '1', 'only explicit logout writes the session tombstone');
  assert.ok(events.some(entry => entry.event === 'SIGNED_OUT'), 'explicit logout still notifies the application');
  subscription.data.subscription.unsubscribe();
  console.log('nativeOwnedAuthStorage: SDK initial session, expiry boundaries, native restore, explicit user validation, PKCE, and logout passed');
}
void run();
