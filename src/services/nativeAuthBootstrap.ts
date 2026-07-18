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
import {
  deferNativeAuthRecovery,
  resetNativeAuthRecoveryBackoff,
} from './nativeAuthRecoveryBackoff';

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

/** Seeds the WebView before supabase-js can refresh an older stored token. */
export async function seedNativeDriverSessionBeforeClient(): Promise<boolean> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return false;
  if (typeof window === 'undefined') return false;
  if (isDriverExplicitSignOutRequested()) return false;

  // Android owns refresh-token rotation. This returns immediately while the
  // access token is healthy and refreshes natively before WebView startup when needed.
  let authorization;
  try {
    authorization = await ResidentLocation.refreshAuthorization();
    resetNativeAuthRecoveryBackoff();
  } catch (error) {
    deferNativeAuthRecovery(error);
    throw error;
  }
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
