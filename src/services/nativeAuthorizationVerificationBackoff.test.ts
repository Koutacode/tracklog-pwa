import {
  EMPTY_NATIVE_AUTHORIZATION_VERIFICATION_BACKOFF,
  createNativeAuthorizationVerificationMarker,
  deferNativeAuthorizationVerification,
  shouldAttemptNativeAuthorizationVerification,
} from './nativeAuthorizationVerificationBackoff';

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function marker(overrides: Partial<Parameters<
  typeof createNativeAuthorizationVerificationMarker
>[0]> = {}) {
  return createNativeAuthorizationVerificationMarker({
    nativeUpdatedAt: 100,
    nativeAccessToken: 'native-access-a',
    nativeRefreshToken: 'native-refresh-a',
    webAccessToken: 'web-access-a',
    webRefreshToken: 'web-refresh-a',
    ...overrides,
  });
}

const originalMarker = marker();
assertEqual(
  shouldAttemptNativeAuthorizationVerification(
    EMPTY_NATIVE_AUTHORIZATION_VERIFICATION_BACKOFF,
    originalMarker,
    1_000,
  ),
  true,
  'a candidate without failures is verified immediately',
);

let backoff = deferNativeAuthorizationVerification(
  EMPTY_NATIVE_AUTHORIZATION_VERIFICATION_BACKOFF,
  originalMarker,
  1_000,
);
assertEqual(backoff.retryAfter, 31_000, 'the first failure defers verification for 30 seconds');
assertEqual(
  shouldAttemptNativeAuthorizationVerification(backoff, originalMarker, 30_999),
  false,
  'the same candidate stays deferred before its deadline',
);
assertEqual(
  shouldAttemptNativeAuthorizationVerification(backoff, originalMarker, 31_000),
  true,
  'the same candidate can retry at its deadline',
);

backoff = deferNativeAuthorizationVerification(backoff, originalMarker, 31_000);
assertEqual(backoff.retryAfter, 91_000, 'a repeated failure doubles the delay');

for (let index = 0; index < 8; index += 1) {
  backoff = deferNativeAuthorizationVerification(backoff, originalMarker, backoff.retryAfter);
}
const cappedRetryStartedAt = backoff.retryAfter;
backoff = deferNativeAuthorizationVerification(
  backoff,
  originalMarker,
  cappedRetryStartedAt,
);
assertEqual(
  backoff.retryAfter - cappedRetryStartedAt,
  300_000,
  'repeated failures are capped at a five-minute delay',
);

assertEqual(
  shouldAttemptNativeAuthorizationVerification(
    backoff,
    marker({ nativeUpdatedAt: 101 }),
    40_000,
  ),
  true,
  'a native update marker bypasses the old cooldown',
);
assertEqual(
  shouldAttemptNativeAuthorizationVerification(
    backoff,
    marker({ webAccessToken: 'web-access-new' }),
    40_000,
  ),
  true,
  'a newly completed WebView login bypasses the old cooldown',
);
assertEqual(
  shouldAttemptNativeAuthorizationVerification(
    backoff,
    marker({ nativeRefreshToken: 'native-refresh-new' }),
    40_000,
  ),
  true,
  'a native credential rotation bypasses the old cooldown',
);
assertEqual(
  shouldAttemptNativeAuthorizationVerification(
    EMPTY_NATIVE_AUTHORIZATION_VERIFICATION_BACKOFF,
    originalMarker,
    40_000,
  ),
  true,
  'resetting the backoff makes the current candidate immediately eligible',
);

console.log('nativeAuthorizationVerificationBackoff: 9 tests passed');
