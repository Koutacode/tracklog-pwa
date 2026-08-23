import {
  createAuthCodeVerifierStorage,
  createMirroredAuthStorage,
  getAuthCodeVerifierStorageKey,
  type AuthStorageAdapter,
} from './supabase';

class MemoryStorage implements AuthStorageAdapter {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function assertThrows(run: () => unknown, message: string) {
  let threw = false;
  try {
    run();
  } catch {
    threw = true;
  }
  assertEqual(threw, true, message);
}

function jwt(sub: string, iat: number, exp: number) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ sub, iat, exp, session_id: 'session-a' })}.signature`;
}

async function run() {
  const local = new MemoryStorage();
  const indexed = new MemoryStorage();
  const storage = createMirroredAuthStorage(local, indexed);
  local.setItem('tracklog-driver-auth', 'legacy-session');

  assertEqual(
    await storage.getItem('tracklog-driver-auth'),
    'legacy-session',
    'legacy localStorage session is readable',
  );
  assertEqual(
    indexed.getItem('tracklog-driver-auth'),
    'legacy-session',
    'legacy localStorage session migrates to IndexedDB',
  );

  const restoredLocal = new MemoryStorage();
  const restoredStorage = createMirroredAuthStorage(restoredLocal, indexed);
  assertEqual(
    await restoredStorage.getItem('tracklog-driver-auth'),
    'legacy-session',
    'IndexedDB session restores localStorage',
  );
  assertEqual(
    restoredLocal.getItem('tracklog-driver-auth'),
    'legacy-session',
    'restored session is mirrored back to localStorage',
  );

  const nowSeconds = Math.floor(Date.now() / 1000);
  const staleLocalSession = JSON.stringify({
    access_token: jwt('driver-a', nowSeconds - 600, nowSeconds + 600),
    refresh_token: 'stale-local-refresh',
  });
  const newerIndexedSession = JSON.stringify({
    access_token: jwt('driver-a', nowSeconds - 30, nowSeconds + 3600),
    refresh_token: 'newer-indexed-refresh',
  });
  const competingLocal = new MemoryStorage();
  const competingIndexed = new MemoryStorage();
  competingLocal.setItem('tracklog-driver-auth', staleLocalSession);
  competingIndexed.setItem('tracklog-driver-auth', newerIndexedSession);
  const competingStorage = createMirroredAuthStorage(competingLocal, competingIndexed);
  assertEqual(
    await competingStorage.getItem('tracklog-driver-auth'),
    newerIndexedSession,
    'newer same-account IndexedDB session wins over stale localStorage',
  );
  assertEqual(
    competingLocal.getItem('tracklog-driver-auth'),
    newerIndexedSession,
    'the selected IndexedDB session repairs localStorage',
  );

  await restoredStorage.setItem('tracklog-driver-auth-code-verifier', 'pkce');
  assertEqual(
    indexed.getItem('tracklog-driver-auth-code-verifier'),
    'pkce',
    'new auth values are mirrored to IndexedDB',
  );
  await restoredStorage.removeItem('tracklog-driver-auth');
  await restoredStorage.removeItem('tracklog-driver-auth-code-verifier');
  assertEqual(restoredLocal.getItem('tracklog-driver-auth'), null, 'logout clears localStorage session');
  assertEqual(indexed.getItem('tracklog-driver-auth'), null, 'logout clears IndexedDB session');
  assertEqual(
    await restoredStorage.getItem('tracklog-driver-auth'),
    null,
    'logout tombstone prevents stale session restoration',
  );

  const adminVerifierAdapter = new MemoryStorage();
  const driverVerifierLocal = new MemoryStorage();
  const driverVerifierIndexed = new MemoryStorage();
  const driverVerifierAdapter = createMirroredAuthStorage(driverVerifierLocal, driverVerifierIndexed);
  const verifierStorage = createAuthCodeVerifierStorage(adminVerifierAdapter, driverVerifierAdapter);
  const adminVerifierKey = getAuthCodeVerifierStorageKey('admin');
  const driverVerifierKey = getAuthCodeVerifierStorageKey('driver');
  adminVerifierAdapter.setItem(adminVerifierKey, 'admin-verifier-snapshot');
  await driverVerifierAdapter.setItem(driverVerifierKey, 'driver-verifier-snapshot');
  assertEqual(await verifierStorage.snapshot('admin'), 'admin-verifier-snapshot', 'admin verifier uses the admin auth adapter');
  assertEqual(await verifierStorage.snapshot('driver'), 'driver-verifier-snapshot', 'driver verifier uses the mirrored driver adapter');
  adminVerifierAdapter.removeItem(adminVerifierKey);
  await driverVerifierAdapter.removeItem(driverVerifierKey);
  await verifierStorage.restore('admin', 'admin-verifier-snapshot');
  await verifierStorage.restore('driver', 'driver-verifier-snapshot');
  assertEqual(adminVerifierAdapter.getItem(adminVerifierKey), 'admin-verifier-snapshot', 'admin verifier is restorable after exchange removes it');
  assertEqual(driverVerifierLocal.getItem(driverVerifierKey), 'driver-verifier-snapshot', 'driver verifier is restored to localStorage');
  assertEqual(driverVerifierIndexed.getItem(driverVerifierKey), 'driver-verifier-snapshot', 'driver verifier is restored to IndexedDB mirror');
  await verifierStorage.clear('admin');
  await verifierStorage.clear('driver');
  assertEqual(adminVerifierAdapter.getItem(adminVerifierKey), null, 'admin restart clears only its verifier key');
  assertEqual(driverVerifierLocal.getItem(driverVerifierKey), null, 'driver restart clears its local verifier key');
  assertEqual(driverVerifierIndexed.getItem(driverVerifierKey), null, 'driver restart clears its mirrored verifier key');

  Object.assign(globalThis, {
    __APP_VERSION__: 'test',
    __BUILD_DATE__: 'test',
  });
  const {
    buildAuthRedirectUrl,
    deriveDriverIdentityFromPersistence,
    isPermanentDriverAuthFailure,
    normalizeNativeAuthNextPath,
    parseAuthCallbackUrl,
  } = await import('./remoteAuth');
  const profile = {
    configured: true,
    deviceId: 'android:test-device',
    displayName: 'Test Driver',
    vehicleLabel: '札幌101か8916',
    driverPhone: '09012345678',
    driverEmail: 'driver@example.com',
    approvalStatus: 'approved',
  };
  const firstUse = deriveDriverIdentityFromPersistence(profile);
  assertEqual(firstUse.authInitialized, false, 'first unauthenticated use stays locked');
  assertEqual(firstUse.approvalStatus, 'unregistered', 'approval alone cannot unlock first use');

  const persistedApproval = deriveDriverIdentityFromPersistence({
    ...profile,
    remoteAuthInitialized: 'true',
    allowPersistedAuth: true,
  });
  assertEqual(persistedApproval.authInitialized, true, 'persisted authentication survives a transient auth error');
  assertEqual(persistedApproval.profileComplete, true, 'persisted complete profile remains complete');
  assertEqual(persistedApproval.approvalStatus, 'approved', 'persisted approval remains available offline');

  const confirmedSignOut = deriveDriverIdentityFromPersistence({
    ...profile,
    remoteAuthInitialized: 'true',
  });
  assertEqual(confirmedSignOut.authInitialized, false, 'a confirmed missing session stays locked');
  assertEqual(confirmedSignOut.approvalStatus, 'unregistered', 'cached approval cannot bypass sign-out');
  assertEqual(
    isPermanentDriverAuthFailure(Object.assign(new Error('Invalid Refresh Token: Refresh Token Not Found'), {
      code: 'refresh_token_not_found',
    })),
    true,
    'revoked refresh token is permanent',
  );
  assertEqual(
    isPermanentDriverAuthFailure(Object.assign(new Error('Invalid Refresh Token: Already Used'), {
      code: 'refresh_token_already_used',
    })),
    true,
    'already-used refresh token is treated as revoked',
  );
  assertEqual(
    isPermanentDriverAuthFailure(new TypeError('Failed to fetch')),
    false,
    'network failure remains retryable',
  );

  const queryNext = parseAuthCallbackUrl('com.tracklog.assist://auth?code=abc&access_token=atk&refresh_token=rtk&next=%2Fadmin');
  assertEqual(queryNext.nextPath, '/admin', 'native callback parses next from query');
  assertEqual(queryNext.callbackRole, 'admin', 'native callback derives admin only from an allowed route');
  assertEqual(queryNext.code, 'abc', 'native callback preserves query code');
  const hashNext = parseAuthCallbackUrl('com.tracklog.assist://auth#access_token=atk&refresh_token=rtk&next=%2Fadmin');
  assertEqual(hashNext.nextPath, '/admin', 'native callback parses next from hash');
  assertEqual(hashNext.code, null, 'native callback handles hash-only callback');
  const noNext = parseAuthCallbackUrl('com.tracklog.assist://auth?code=abc&access_token=atk&refresh_token=rtk');
  assertEqual(noNext.nextPath, '/settings', 'native callback defaults to settings when next is missing');
  assertEqual(noNext.callbackRole, null, 'missing next does not silently select a client role');
  const encoded = parseAuthCallbackUrl('com.tracklog.assist://auth?code=abc&next=%2Fadmin%3Fmode%3Dtest');
  assertEqual(encoded.nextPath, '/admin?mode=test', 'next query values are URI-decoded');

  assertEqual(normalizeNativeAuthNextPath('/settings')?.role, 'driver', 'settings is an allowed driver route');
  assertEqual(normalizeNativeAuthNextPath('/')?.role, 'driver', 'home is an allowed driver route');
  assertEqual(normalizeNativeAuthNextPath('/administrator'), null, 'admin prefix lookalike is rejected');
  assertEqual(normalizeNativeAuthNextPath('//evil.example/path'), null, 'protocol-relative next is rejected');
  assertEqual(normalizeNativeAuthNextPath('/settings/../admin'), null, 'traversal next is rejected');
  assertEqual(normalizeNativeAuthNextPath('%252F%252Fevil.example'), null, 'double-encoded external next is rejected');

  const nativeAdminRedirect = buildAuthRedirectUrl({
    role: 'admin',
    native: true,
    currentOrigin: 'https://tracklog.example',
    attemptId: 'attempt_admin_1',
  });
  const parsedNativeRedirect = new URL(nativeAdminRedirect);
  assertEqual(parsedNativeRedirect.protocol, 'com.tracklog.assist:', 'native redirect uses the known app scheme');
  assertEqual(parsedNativeRedirect.host, 'auth', 'native redirect uses the known auth host');
  assertEqual(parsedNativeRedirect.searchParams.get('next'), '/admin', 'native redirect uses the admin allowlist route');
  assertEqual(parsedNativeRedirect.searchParams.get('attempt'), 'attempt_admin_1', 'native redirect binds the attempt id');
  assertThrows(() => buildAuthRedirectUrl({
    role: 'admin',
    native: true,
    currentOrigin: 'https://tracklog.example',
    override: 'https://evil.example/auth/admin/callback',
  }), 'foreign native redirect override is rejected');
  assertThrows(() => buildAuthRedirectUrl({
    role: 'admin',
    native: true,
    currentOrigin: 'https://tracklog.example',
    override: 'com.tracklog.assist://auth?next=%2Fsettings',
  }), 'cross-role native redirect override is rejected');

  assertEqual(buildAuthRedirectUrl({
    role: 'driver',
    native: false,
    currentOrigin: 'https://tracklog.example',
    override: 'https://tracklog.example/auth/driver/callback?ignored=true',
  }), 'https://tracklog.example/auth/driver/callback', 'same-origin exact web callback is normalized');
  assertThrows(() => buildAuthRedirectUrl({
    role: 'driver',
    native: false,
    currentOrigin: 'https://tracklog.example',
    override: 'https://evil.example/auth/driver/callback',
  }), 'foreign web redirect override is rejected');
  assertThrows(() => buildAuthRedirectUrl({
    role: 'driver',
    native: false,
    currentOrigin: 'https://tracklog.example',
    override: 'https://tracklog.example/auth/admin/callback',
  }), 'cross-role web redirect override is rejected');

  console.log('remoteAuthPersistence: 54 tests passed');
}

void run().catch(error => {
  globalThis.setTimeout(() => {
    throw error;
  }, 0);
});
