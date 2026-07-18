let failureCount = 0;
let retryAfter = 0;
let lastError: Error | null = null;

export function resetNativeAuthRecoveryBackoff() {
  failureCount = 0;
  retryAfter = 0;
  lastError = null;
}

export function deferNativeAuthRecovery(error: unknown) {
  failureCount += 1;
  const delayMs = Math.min(5 * 60 * 1000, 5000 * 2 ** Math.min(failureCount - 1, 6));
  retryAfter = Date.now() + delayMs;
  lastError = error instanceof Error
    ? error
    : new Error('端末認証を一時的に更新できませんでした');
}

export function getDeferredNativeAuthRecoveryError(): Error | null {
  return Date.now() < retryAfter ? lastError : null;
}
