import {
  createMirroredAuthStorage,
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

  Object.assign(globalThis, {
    __APP_VERSION__: 'test',
    __BUILD_DATE__: 'test',
  });
  const {
    deriveDriverIdentityFromPersistence,
    isPermanentDriverAuthFailure,
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

  console.log('remoteAuthPersistence: 18 tests passed');
}

void run().catch(error => {
  globalThis.setTimeout(() => {
    throw error;
  }, 0);
});
