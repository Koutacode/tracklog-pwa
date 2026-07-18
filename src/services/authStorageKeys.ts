export const AUTH_DB_NAME = 'tracklog-auth';
export const AUTH_DB_VERSION = 1;
export const AUTH_STORE_NAME = 'sessions';
export const AUTH_CLEARED_KEY_SUFFIX = ':tracklog-cleared';
export const DRIVER_AUTH_STORAGE_KEY = 'tracklog-driver-auth';
export const DRIVER_EXPLICIT_SIGN_OUT_KEY = 'tracklog-driver-explicit-sign-out';

export function isDriverExplicitSignOutRequested(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(DRIVER_EXPLICIT_SIGN_OUT_KEY) === '1';
  } catch {
    return false;
  }
}

export function markDriverExplicitSignOut(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DRIVER_EXPLICIT_SIGN_OUT_KEY, '1');
  } catch {
    // The caller still invalidates the in-memory/native session when storage is unavailable.
  }
}

export function clearDriverExplicitSignOut(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(DRIVER_EXPLICIT_SIGN_OUT_KEY);
  } catch {
    // A successful login remains valid for the current process even without localStorage.
  }
}
