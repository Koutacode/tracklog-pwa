/**
 * Screen Wake Lock helper for keeping the display on while the app is in use.
 * Browsers may reject the request; callers should handle false returns.
 */
let sentinel: { release: () => Promise<void> } | null = null;

export function isWakeLockSupported() {
  return typeof navigator !== 'undefined' && !!(navigator as any).wakeLock;
}

export async function requestWakeLock(): Promise<boolean> {
  if (!isWakeLockSupported()) return false;
  try {
    sentinel = await (navigator as any).wakeLock.request('screen');
    return true;
  } catch {
    sentinel = null;
    return false;
  }
}

export async function releaseWakeLock(): Promise<void> {
  if (!sentinel) return;
  try {
    await sentinel.release();
  } finally {
    sentinel = null;
  }
}
