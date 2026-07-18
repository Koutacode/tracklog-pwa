import {
  buildNativeBootstrappedSession,
  getJwtSessionId,
  selectPreferredPersistedAuthSession,
  shouldBootstrapNativeAuthorization,
  shouldInstallWebAuthorizationIntoNative,
  shouldRestoreNativeAuthorization,
} from './nativeResidentSessionPolicy';

function jwt(sub: string, iat: number, exp: number, sessionId = 'session-a') {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ sub, iat, exp, session_id: sessionId })}.signature`;
}

function assertEqual(actual: boolean, expected: boolean, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
}

const nowSeconds = 1_800_000_000;
const nowMs = nowSeconds * 1000;
const oldToken = jwt('driver-a', nowSeconds - 600, nowSeconds + 600);
const newToken = jwt('driver-a', nowSeconds - 60, nowSeconds + 3600);
const expiredToken = jwt('driver-a', nowSeconds - 7200, nowSeconds - 60);
const otherDriverToken = jwt('driver-b', nowSeconds - 30, nowSeconds + 3600);
const otherSessionToken = jwt('driver-a', nowSeconds - 30, nowSeconds + 3600, 'session-b');
const newerOtherSessionToken = jwt('driver-a', nowSeconds - 10, nowSeconds + 7200, 'session-b');

assertEqual(shouldRestoreNativeAuthorization(newToken, null, nowMs), true, 'native restores missing WebView persistence');
assertEqual(shouldRestoreNativeAuthorization(newToken, oldToken, nowMs), true, 'newer native token wins for same driver');
assertEqual(shouldRestoreNativeAuthorization(oldToken, newToken, nowMs), false, 'newer WebView token is preserved');
assertEqual(shouldRestoreNativeAuthorization(newToken, otherDriverToken, nowMs), false, 'another WebView driver is never overwritten');
assertEqual(shouldRestoreNativeAuthorization(newToken, otherSessionToken, nowMs), false, 'newer WebView session is preserved for the same driver');
assertEqual(shouldRestoreNativeAuthorization(newerOtherSessionToken, newToken, nowMs), false, 'runtime restore never replaces another session');
assertEqual(shouldBootstrapNativeAuthorization(newerOtherSessionToken, newToken, nowMs), true, 'startup handoff accepts a newer session for the same driver');
assertEqual(shouldInstallWebAuthorizationIntoNative({
  nativeConfigured: true,
  nativeAccessToken: oldToken,
  nativeRefreshToken: 'old-refresh',
  webAccessToken: newToken,
  webRefreshToken: 'new-refresh',
  nowMs,
}), true, 'verified newer WebView credentials can update native authorization');
assertEqual(shouldInstallWebAuthorizationIntoNative({
  nativeConfigured: true,
  nativeAccessToken: newToken,
  nativeRefreshToken: 'new-refresh',
  webAccessToken: oldToken,
  webRefreshToken: 'old-refresh',
  nowMs,
}), false, 'routine reconcile cannot roll native authorization back');
assertEqual(shouldInstallWebAuthorizationIntoNative({
  nativeConfigured: true,
  nativeAccessToken: newToken,
  nativeRefreshToken: 'native-refresh',
  webAccessToken: otherDriverToken,
  webRefreshToken: 'other-refresh',
  nowMs,
}), false, 'another WebView account cannot replace native authorization');
assertEqual(shouldRestoreNativeAuthorization(newToken, expiredToken, nowMs), true, 'usable native token replaces expired same-driver token');
assertEqual(shouldRestoreNativeAuthorization(expiredToken, newToken, nowMs), false, 'expired native token cannot replace usable WebView token');
if (getJwtSessionId(newToken) !== 'session-a') throw new Error('JWT session_id is decoded');

const bootstrapped = buildNativeBootstrappedSession({
  nativeAccessToken: newToken,
  nativeRefreshToken: 'native-refresh',
  persistedRaw: null,
  nowMs,
});
if (!bootstrapped) throw new Error('native session bootstrap is created');
const parsedBootstrap = JSON.parse(bootstrapped) as Record<string, unknown>;
if (parsedBootstrap.access_token !== newToken) throw new Error('bootstrap stores native access token');
if (parsedBootstrap.refresh_token !== 'native-refresh') throw new Error('bootstrap stores native refresh token');
if (parsedBootstrap.expires_at !== nowSeconds + 3600) throw new Error('bootstrap stores JWT expiry');

const rejectedDifferentAccount = buildNativeBootstrappedSession({
  nativeAccessToken: newToken,
  nativeRefreshToken: 'native-refresh',
  persistedRaw: JSON.stringify({
    access_token: otherDriverToken,
    refresh_token: 'other-refresh',
    expires_at: nowSeconds + 3600,
  }),
  nowMs,
});
if (rejectedDifferentAccount !== null) throw new Error('bootstrap never overwrites another account');

const localSession = JSON.stringify({
  access_token: oldToken,
  refresh_token: 'local-refresh',
  expires_at: nowSeconds + 600,
  user: { id: 'driver-a' },
});
const indexedSession = JSON.stringify({
  access_token: newToken,
  refresh_token: 'indexed-refresh',
  expires_at: nowSeconds + 3600,
  user: { id: 'driver-a' },
});
if (selectPreferredPersistedAuthSession(null, indexedSession, nowMs) !== indexedSession) {
  throw new Error('IndexedDB remains authoritative when localStorage is missing');
}
if (selectPreferredPersistedAuthSession(localSession, indexedSession, nowMs) !== indexedSession) {
  throw new Error('newer same-account IndexedDB session is preferred');
}

const bootstrappedSessionHandoff = buildNativeBootstrappedSession({
  nativeAccessToken: newerOtherSessionToken,
  nativeRefreshToken: 'newer-native-refresh',
  persistedRaw: indexedSession,
  nowMs,
});
if (!bootstrappedSessionHandoff) throw new Error('startup bootstrap accepts same-account session handoff');

console.log('nativeResidentSessionPolicy: 24 tests passed');
