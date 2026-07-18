import { createClient } from '@supabase/supabase-js';
import { Capacitor } from '@capacitor/core';
import {
  AUTH_CLEARED_KEY_SUFFIX,
  AUTH_DB_NAME,
  AUTH_DB_VERSION,
  AUTH_STORE_NAME,
  DRIVER_AUTH_STORAGE_KEY,
  isDriverExplicitSignOutRequested,
} from './authStorageKeys';
import { selectPreferredPersistedAuthSession } from './nativeResidentSessionPolicy';
import { ResidentLocation } from './residentLocationBridge';

const supabaseUrl = (import.meta.env?.VITE_SUPABASE_URL ?? '').trim();
const supabaseAnonKey = (import.meta.env?.VITE_SUPABASE_ANON_KEY ?? '').trim();

export type AuthStorageAdapter = {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
};

export const SUPABASE_CONFIGURED = !!supabaseUrl && !!supabaseAnonKey;
const ANDROID_NATIVE = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

let authDatabasePromise: Promise<IDBDatabase> | null = null;

function openAuthDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is unavailable'));
  }
  if (authDatabasePromise) return authDatabasePromise;

  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(AUTH_DB_NAME, AUTH_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(AUTH_STORE_NAME)) {
        database.createObjectStore(AUTH_STORE_NAME);
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        authDatabasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => reject(request.error ?? new Error('Failed to open auth IndexedDB'));
  });
  const result = opening.catch(error => {
    authDatabasePromise = null;
    throw error;
  });
  authDatabasePromise = result;
  return result;
}

function createIndexedDbAuthStorage(): AuthStorageAdapter {
  return {
    async getItem(key) {
      const database = await openAuthDatabase();
      return new Promise<string | null>((resolve, reject) => {
        const transaction = database.transaction(AUTH_STORE_NAME, 'readonly');
        const request = transaction.objectStore(AUTH_STORE_NAME).get(key);
        request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : null);
        request.onerror = () => reject(request.error ?? new Error('Failed to read auth IndexedDB'));
      });
    },
    async setItem(key, value) {
      const database = await openAuthDatabase();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(AUTH_STORE_NAME, 'readwrite');
        transaction.objectStore(AUTH_STORE_NAME).put(value, key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('Failed to write auth IndexedDB'));
        transaction.onabort = () => reject(transaction.error ?? new Error('Auth IndexedDB write was aborted'));
      });
    },
    async removeItem(key) {
      const database = await openAuthDatabase();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(AUTH_STORE_NAME, 'readwrite');
        transaction.objectStore(AUTH_STORE_NAME).delete(key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('Failed to clear auth IndexedDB'));
        transaction.onabort = () => reject(transaction.error ?? new Error('Auth IndexedDB clear was aborted'));
      });
    },
  };
}

function getBrowserLocalStorage(): AuthStorageAdapter | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Keeps Supabase Auth compatible with existing localStorage while adding an IndexedDB copy. */
export function createMirroredAuthStorage(
  localStorage: AuthStorageAdapter | null,
  indexedDbStorage: AuthStorageAdapter,
): AuthStorageAdapter {
  return {
    async getItem(key) {
      let localValue: string | null = null;
      if (localStorage) {
        try {
          localValue = await localStorage.getItem(key);
        } catch {
          localValue = null;
        }
      }

      let indexedValue: string | null = null;
      try {
        indexedValue = await indexedDbStorage.getItem(key);
      } catch {
        indexedValue = null;
      }

      if (localValue != null) {
        const preferredValue = key === DRIVER_AUTH_STORAGE_KEY
          ? selectPreferredPersistedAuthSession(localValue, indexedValue) ?? localValue
          : localValue;
        if (localStorage && preferredValue !== localValue) {
          try {
            await localStorage.setItem(key, preferredValue);
          } catch {
            // IndexedDB remains usable if localStorage cannot be repaired.
          }
        }
        try {
          if (preferredValue !== indexedValue) {
            await indexedDbStorage.setItem(key, preferredValue);
          }
        } catch {
          // localStorage remains a valid compatibility source when IndexedDB is unavailable.
        }
        return preferredValue;
      }

      if (localStorage) {
        try {
          if (await localStorage.getItem(`${key}${AUTH_CLEARED_KEY_SUFFIX}`)) {
            try {
              await indexedDbStorage.removeItem(key);
            } catch {
              // The tombstone prevents a stale IndexedDB session from being restored.
            }
            return null;
          }
        } catch {
          // Fall through to IndexedDB when localStorage cannot be read.
        }
      }

      if (indexedValue == null) return null;

      if (localStorage) {
        try {
          await localStorage.setItem(key, indexedValue);
          await localStorage.removeItem(`${key}${AUTH_CLEARED_KEY_SUFFIX}`);
        } catch {
          // IndexedDB remains authoritative when localStorage cannot be written.
        }
      }
      return indexedValue;
    },
    async setItem(key, value) {
      let stored = false;
      if (localStorage) {
        try {
          await localStorage.setItem(key, value);
          await localStorage.removeItem(`${key}${AUTH_CLEARED_KEY_SUFFIX}`);
          stored = true;
        } catch {
          // Continue so IndexedDB can retain the session.
        }
      }
      try {
        await indexedDbStorage.setItem(key, value);
        stored = true;
      } catch {
        // localStorage is sufficient if it accepted the write.
      }
      if (!stored) throw new Error('認証情報を端末に保存できませんでした');
    },
    async removeItem(key) {
      if (localStorage) {
        try {
          await localStorage.removeItem(key);
          await localStorage.setItem(`${key}${AUTH_CLEARED_KEY_SUFFIX}`, '1');
        } catch {
          // IndexedDB removal still prevents future session restoration.
        }
      }
      try {
        await indexedDbStorage.removeItem(key);
      } catch {
        // A local tombstone suppresses stale IndexedDB data until deletion succeeds later.
      }
    },
  };
}

function buildClient(
  storageKey: string,
  storage?: AuthStorageAdapter,
  autoRefreshToken = true,
) {
  if (!SUPABASE_CONFIGURED) return null;
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken,
      persistSession: true,
      detectSessionInUrl: false,
      storageKey,
      ...(storage ? { storage } : {}),
    },
  });
}

async function getNativeDriverAccessToken(): Promise<string | null> {
  if (!ANDROID_NATIVE || isDriverExplicitSignOutRequested()) return null;
  const authorization = await ResidentLocation.refreshAuthorization({ force: false });
  if (!authorization.configured || authorization.blocked) return null;
  return authorization.accessToken || null;
}

function buildNativeDriverDataClient() {
  if (!SUPABASE_CONFIGURED) return null;
  return createClient(supabaseUrl, supabaseAnonKey, {
    accessToken: getNativeDriverAccessToken,
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

const driverAuthStorage = createMirroredAuthStorage(
  getBrowserLocalStorage(),
  createIndexedDbAuthStorage(),
);

export type PersistedDriverAuthTokens = {
  accessToken: string;
  refreshToken: string;
  hasUser: boolean;
};

export async function getPersistedDriverAuthTokens(): Promise<PersistedDriverAuthTokens | null> {
  let raw: string | null;
  try {
    raw = await driverAuthStorage.getItem(DRIVER_AUTH_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const session = (
      parsed.currentSession && typeof parsed.currentSession === 'object'
        ? parsed.currentSession
        : parsed
    ) as Record<string, unknown>;
    const accessToken = typeof session.access_token === 'string' ? session.access_token.trim() : '';
    const refreshToken = typeof session.refresh_token === 'string' ? session.refresh_token.trim() : '';
    const hasUser = !!session.user && typeof session.user === 'object';
    return accessToken && refreshToken ? { accessToken, refreshToken, hasUser } : null;
  } catch {
    return null;
  }
}

/** Forces local driver sign-out even when Supabase's revoke request is offline. */
export async function clearPersistedDriverAuthSession(): Promise<void> {
  await Promise.all([
    driverAuthStorage.removeItem(DRIVER_AUTH_STORAGE_KEY),
    driverAuthStorage.removeItem(`${DRIVER_AUTH_STORAGE_KEY}-code-verifier`),
    driverAuthStorage.removeItem(`${DRIVER_AUTH_STORAGE_KEY}-user`),
  ]);
}

// The Android foreground service is the sole refresh-token owner. This avoids
// native/WebView rotation races while still allowing normal PWA auto-refresh.
export const driverAuthSupabase = buildClient(
  DRIVER_AUTH_STORAGE_KEY,
  driverAuthStorage,
  !ANDROID_NATIVE,
);
// Android data requests use a token callback backed by the native owner. This
// client intentionally exposes no usable auth API, preventing implicit refresh.
export const driverSupabase = ANDROID_NATIVE
  ? buildNativeDriverDataClient()
  : driverAuthSupabase;
export const adminSupabase = buildClient('tracklog-admin-auth');
