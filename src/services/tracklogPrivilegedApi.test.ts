import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { createTracklogExplicitTokenClient } from './tracklogExplicitTokenClient';
import { createTracklogPrivilegedInvoker } from './tracklogPrivilegedApi';

type CapturedRequest = { path: string; authorization: string | null; apiKey: string | null; body: Record<string, unknown> };

async function run() {
  const requests: CapturedRequest[] = [];
  let responseStatus = 200;
  let responseBody: unknown = { ok: true, data: { email: 'admin@example.com', isAdmin: true } };
  let transportFailure = false;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    requests.push({
      path: url.pathname + url.search,
      authorization: headers.get('Authorization'), apiKey: headers.get('apikey'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : {},
    });
    if (url.pathname.startsWith('/auth/')) throw new Error('Unexpected auth refresh during an explicit-token request');
    if (transportFailure) throw new TypeError('synthetic transport failure');
    return new Response(JSON.stringify(responseBody), {
      status: responseStatus, headers: { 'Content-Type': 'application/json' },
    });
  };
  let storageReads = 0;
  let storageWrites = 0;
  const storageKey = 'synthetic-privileged-test-session';
  const savedSession = {
    access_token: 'synthetic-old-access', refresh_token: 'synthetic-old-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'synthetic-user', email: 'admin@example.com' },
  };
  const stored = new Map([[storageKey, JSON.stringify(savedSession)]]);
  const ordinaryClient = createClient('https://synthetic.invalid', 'synthetic-api-key', {
    global: { fetch: fakeFetch },
    auth: {
      autoRefreshToken: false, persistSession: true, detectSessionInUrl: false, storageKey,
      storage: {
        getItem: key => { storageReads++; return stored.get(key) ?? null; },
        setItem: (key, value) => { storageWrites++; stored.set(key, value); },
        removeItem: key => { storageWrites++; stored.delete(key); },
      },
    },
  });
  await ordinaryClient.auth.initialize();
  await new Promise(resolve => setTimeout(resolve, 0));
  // Let the ordinary client's initial Auth event settle before simulating the
  // expired WebView snapshot that exists during a later native refresh.
  stored.set(storageKey, JSON.stringify({ ...savedSession, expires_at: 1 }));
  const readsBeforeRequest = storageReads;
  const writesBeforeRequest = storageWrites;
  const explicitClient = createTracklogExplicitTokenClient('https://synthetic.invalid', 'synthetic-api-key', fakeFetch);
  const invoke = createTracklogPrivilegedInvoker(explicitClient);

  const result = await invoke<{ email: string; isAdmin: boolean }>(ordinaryClient, 'getAdminAccessState', {}, '  synthetic-current-native-access  ');
  assert.equal(result.isAdmin, true, 'server-validated access result is returned unchanged');
  assert.deepEqual(requests.map(request => request.path), ['/functions/v1/tracklog-privileged'],
    'an expired saved WebView session never starts an additional refresh');
  assert.equal(storageReads, readsBeforeRequest, 'explicit-token invocation does not read another Auth session');
  assert.equal(storageWrites, writesBeforeRequest, 'explicit-token invocation cannot change persisted login state');
  assert.equal(requests[0].authorization, 'Bearer synthetic-current-native-access', 'exact caller token is trimmed and preserved');
  assert.equal(requests[0].apiKey, 'synthetic-api-key', 'Supabase API key remains present');
  assert.deepEqual(requests[0].body, { action: 'getAdminAccessState' }, 'access token is absent from request payload');

  requests.length = 0;
  await Promise.all([
    invoke(ordinaryClient, 'claimDeviceProfile', { deviceId: 'synthetic-device', displayName: 'Test Driver' }, 'synthetic-enrollment-access'),
    invoke(ordinaryClient, 'getAdminAccessState', {}, 'synthetic-other-access'),
  ]);
  assert.deepEqual(requests.map(request => request.authorization).sort(), [
    'Bearer synthetic-enrollment-access', 'Bearer synthetic-other-access',
  ], 'parallel requests never share or replace each other\'s Authorization header');
  assert.deepEqual(requests.find(request => request.body.action === 'claimDeviceProfile')?.body,
    { action: 'claimDeviceProfile', deviceId: 'synthetic-device', displayName: 'Test Driver' },
    'enrollment action and payload are retained without adding credentials');

  requests.length = 0;
  stored.set(storageKey, JSON.stringify({ ...savedSession, expires_at: Math.floor(Date.now() / 1000) + 3600 }));
  await invoke(ordinaryClient, 'getAdminAccessState', {});
  assert.equal(requests[0].authorization, 'Bearer synthetic-old-access', 'Web calls without an explicit token keep their own Auth client');
  assert.ok(storageReads > readsBeforeRequest, 'normal session-owner requests still read their current session');
  await createTracklogPrivilegedInvoker(null)(ordinaryClient, 'getAdminAccessState', {}, '   ');
  assert.equal(requests[1].authorization, 'Bearer synthetic-old-access',
    'blank tokens use the regular client even without explicit-token client configuration');

  for (const status of [401, 403, 503]) {
    responseStatus = status;
    responseBody = { error: 'synthetic server failure' };
    await assert.rejects(invoke(ordinaryClient, 'getAdminAccessState', {}, 'synthetic-current-native-access'), error => {
      const failure = error as Error & { status?: number; cause?: { context?: Response } };
      return failure.status === status && failure.cause?.context?.status === status;
    }, 'HTTP failure and status reach the existing auth/availability policy');
  }
  responseStatus = 200;
  responseBody = { ok: false, error: 'synthetic action rejected' };
  await assert.rejects(invoke(ordinaryClient, 'getAdminAccessState', {}, 'synthetic-current-native-access'), /synthetic action rejected/,
    'a successful HTTP response cannot turn an application rejection into access');
  transportFailure = true;
  await assert.rejects(invoke(ordinaryClient, 'getAdminAccessState', {}, 'synthetic-current-native-access'), error => {
    const failure = error as Error & { cause?: { name?: string } };
    return failure.cause?.name === 'FunctionsFetchError';
  }, 'transport exception retains the SDK cause for transient failure classification');
  await assert.rejects(createTracklogPrivilegedInvoker(null)(ordinaryClient, 'getAdminAccessState', {}, 'synthetic-current-native-access'),
    /Supabase が未設定です/, 'missing explicit-token configuration never falls back to the stored Auth session');
  assert.equal(requests.some(request => request.path.startsWith('/auth/')), false, 'no test request reached Auth refresh');
  console.log('tracklogPrivilegedApi: explicit-token ownership, headers, payloads, Web compatibility, and failure propagation passed');
}
void run();
