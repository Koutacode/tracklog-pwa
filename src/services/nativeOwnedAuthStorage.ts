import type { AuthStorageAdapter } from './supabase';
import { DRIVER_AUTH_STORAGE_KEY } from './authStorageKeys';
import { decodeJwtSessionClaims } from './nativeResidentSessionPolicy';

// @supabase/auth-js 2.100.1: lib/constants EXPIRY_MARGIN_MS = 3 * 30 seconds.
// __loadSession refreshes inside this margin even with autoRefreshToken:false.
// The SDK integration test checks that constant when dependencies change.
export const NATIVE_AUTH_SDK_REFRESH_MARGIN_MS = 90_000;

export function isNativeAccessTokenUsableBySdk(accessToken: string, nowMs = Date.now()): boolean {
  const claims = decodeJwtSessionClaims(accessToken);
  return !!claims && claims.exp * 1000 - nowMs > NATIVE_AUTH_SDK_REFRESH_MARGIN_MS;
}

function canExposeNativeSession(raw: string, nowMs: number): boolean {
  try {
    const session = JSON.parse(raw) as Record<string, unknown>;
    return typeof session.access_token === 'string'
      && typeof session.refresh_token === 'string' && session.refresh_token.length > 0
      && typeof session.expires_at === 'number' && Number.isFinite(session.expires_at)
      && session.expires_at * 1000 - nowMs > NATIVE_AUTH_SDK_REFRESH_MARGIN_MS
      && isNativeAccessTokenUsableBySdk(session.access_token, nowMs);
  } catch {
    return false;
  }
}

/**
 * The native owner retains expired credentials for recovery. Hide only the
 * session read from auth-js so INITIAL_SESSION/getSession cannot rotate them.
 * This is not logout: raw storage, tombstones, and native credentials are untouched.
 */
export function createNativeOwnedAuthStorage(
  rawStorage: AuthStorageAdapter,
  now: () => number = Date.now,
): AuthStorageAdapter {
  return {
    async getItem(key) {
      const raw = await rawStorage.getItem(key);
      if (key !== DRIVER_AUTH_STORAGE_KEY || raw == null) return raw;
      return canExposeNativeSession(raw, now()) ? raw : null;
    },
    setItem: (key, value) => rawStorage.setItem(key, value),
    removeItem: key => rawStorage.removeItem(key),
  };
}
