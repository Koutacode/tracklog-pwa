export type NativeAuthorizationVerificationMarkerInput = {
  nativeUpdatedAt: number;
  nativeAccessToken: string;
  nativeRefreshToken: string;
  webAccessToken: string;
  webRefreshToken: string;
};

export type NativeAuthorizationVerificationBackoff = {
  marker: string;
  failureCount: number;
  retryAfter: number;
};

export const EMPTY_NATIVE_AUTHORIZATION_VERIFICATION_BACKOFF:
  NativeAuthorizationVerificationBackoff = {
  marker: '',
  failureCount: 0,
  retryAfter: 0,
};

/**
 * The marker is deliberately never logged or persisted. Including both owners'
 * exact credentials makes a newly completed login immediately eligible for
 * verification even while an older candidate is cooling down.
 */
export function createNativeAuthorizationVerificationMarker(
  input: NativeAuthorizationVerificationMarkerInput,
): string {
  return [
    String(input.nativeUpdatedAt),
    input.nativeAccessToken,
    input.nativeRefreshToken,
    input.webAccessToken,
    input.webRefreshToken,
  ].join('\u0000');
}

export function shouldAttemptNativeAuthorizationVerification(
  backoff: NativeAuthorizationVerificationBackoff,
  marker: string,
  now = Date.now(),
): boolean {
  return backoff.marker !== marker || now >= backoff.retryAfter;
}

export function deferNativeAuthorizationVerification(
  backoff: NativeAuthorizationVerificationBackoff,
  marker: string,
  now = Date.now(),
): NativeAuthorizationVerificationBackoff {
  const failureCount = backoff.marker === marker
    ? backoff.failureCount + 1
    : 1;
  const delayMs = Math.min(
    5 * 60 * 1000,
    30 * 1000 * 2 ** Math.min(failureCount - 1, 4),
  );
  return {
    marker,
    failureCount,
    retryAfter: now + delayMs,
  };
}
