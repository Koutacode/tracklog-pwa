/**
 * Screen Wake Lock helper for keeping the display on while the app is in use.
 * Browsers may reject the request; callers should handle false returns.
 */
let sentinel: any = null;

// Type augmentation for TS
type WakeLockType = 'screen';
interface WakeLockSentinel {
  release: () => Promise<void>;
  released: boolean;
  type: WakeLockType;
}
interface WakeLock {
  request: (type: WakeLockType) => Promise<WakeLockSentinel>;
}
declare global {
  interface Navigator {
    wakeLock?: WakeLock;
  }
}

export function isWakeLockSupported() {
  return typeof navigator !== 'undefined' && !!navigator.wakeLock;
}

export async function requestWakeLock(): Promise<boolean> {
  if (!isWakeLockSupported()) return false;
  try {
    sentinel = await navigator.wakeLock!.request('screen');
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
