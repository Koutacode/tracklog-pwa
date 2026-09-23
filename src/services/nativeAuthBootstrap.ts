import { Capacitor } from '@capacitor/core';
import {
  AUTH_CLEARED_KEY_SUFFIX,
  AUTH_DB_NAME,
  AUTH_DB_VERSION,
  AUTH_STORE_NAME,
  DRIVER_AUTH_STORAGE_KEY,
  isDriverExplicitSignOutRequested,
} from './authStorageKeys';
import {
  buildNativeBootstrappedSession,
  selectPreferredPersistedAuthSession,
} from './nativeResidentSessionPolicy';
import { ResidentLocation } from './residentLocationBridge';
import { getDriverAuthIntentGeneration, isCurrentDriverAuthIntent } from './driverAuthMutationLock';

async function readIndexedDriverSession(): Promise<string | null> {
  if (typeof indexedDB === 'undefined') return null;
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(AUTH_DB_NAME, AUTH_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(AUTH_STORE_NAME)) {
        request.result.createObjectStore(AUTH_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open auth IndexedDB'));
  });
  try {
    return await new Promise<string | null>((resolve, reject) => {
      const transaction = database.transaction(AUTH_STORE_NAME, 'readonly');
      const request = transaction.objectStore(AUTH_STORE_NAME).get(DRIVER_AUTH_STORAGE_KEY);
      request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : null);
      request.onerror = () => reject(request.error ?? new Error('Failed to read auth IndexedDB'));
    });
  } finally {
    database.close();
  }
}

/** A timed-out seed must never overwrite storage after the clients are created. */
export async function runBoundedNativeSessionSeed(
  seed: (isActive: () => boolean) => Promise<boolean>,
  timeoutMs = 2_000,
): Promise<boolean> {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>(resolve => {
    timer = setTimeout(() => {
      active = false;
      resolve(false);
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => seed(() => active)), timeout]);
  } finally {
    active = false;
    clearTimeout(timer);
  }
}

/** Seeds the WebView from native storage without waiting for the network. */
export function seedNativeDriverSessionBeforeClient(): Promise<boolean> {
  return runBoundedNativeSessionSeed(seedNativeDriverSession);
}

async function seedNativeDriverSession(isActive: () => boolean): Promise<boolean> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return false;
  if (typeof window === 'undefined') return false;
  if (isDriverExplicitSignOutRequested()) return false;
  const authIntent = getDriverAuthIntentGeneration();

  // Seed from the native owner's current snapshot before creating clients.
  // Token refresh belongs to background recovery, never the first render.
  const authorization = await ResidentLocation.getAuthorization();
  if (!isActive()) return false;
  if (!authorization.configured || authorization.blocked) return false;

  let localRaw: string | null;
  let hasClearTombstone: boolean;
  try {
    localRaw = window.localStorage.getItem(DRIVER_AUTH_STORAGE_KEY);
    hasClearTombstone = window.localStorage.getItem(
      `${DRIVER_AUTH_STORAGE_KEY}${AUTH_CLEARED_KEY_SUFFIX}`,
    ) != null;
  } catch {
    return false;
  }
  let indexedRaw: string | null = null;
  try {
    indexedRaw = await readIndexedDriverSession();
  } catch {
    // Native and localStorage remain sufficient if IndexedDB is unavailable.
  }
  if (!isActive() || !isCurrentDriverAuthIntent(authIntent) || isDriverExplicitSignOutRequested()) return false;
  const persistedRaw = selectPreferredPersistedAuthSession(localRaw, indexedRaw);
  const nextSession = buildNativeBootstrappedSession({
    nativeAccessToken: authorization.accessToken,
    nativeRefreshToken: authorization.refreshToken,
    persistedRaw,
  });
  if (!nextSession) {
    if (!hasClearTombstone && persistedRaw && persistedRaw !== localRaw) {
      window.localStorage.setItem(DRIVER_AUTH_STORAGE_KEY, persistedRaw);
    }
    return false;
  }

  window.localStorage.setItem(DRIVER_AUTH_STORAGE_KEY, nextSession);
  window.localStorage.removeItem(`${DRIVER_AUTH_STORAGE_KEY}${AUTH_CLEARED_KEY_SUFFIX}`);
  return true;
}
