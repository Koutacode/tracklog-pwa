import { getJwtSessionId, shouldRestoreNativeAuthorization } from './nativeResidentSessionPolicy';

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

assertEqual(shouldRestoreNativeAuthorization(newToken, null, nowMs), false, 'native cannot restore after WebView sign-out');
assertEqual(shouldRestoreNativeAuthorization(newToken, oldToken, nowMs), true, 'newer native token wins for same driver');
assertEqual(shouldRestoreNativeAuthorization(oldToken, newToken, nowMs), false, 'newer WebView token is preserved');
assertEqual(shouldRestoreNativeAuthorization(newToken, otherDriverToken, nowMs), false, 'another WebView driver is never overwritten');
assertEqual(shouldRestoreNativeAuthorization(newToken, otherSessionToken, nowMs), false, 'another session for the same driver is never overwritten');
assertEqual(shouldRestoreNativeAuthorization(newToken, expiredToken, nowMs), true, 'usable native token replaces expired same-driver token');
assertEqual(shouldRestoreNativeAuthorization(expiredToken, newToken, nowMs), false, 'expired native token cannot replace usable WebView token');
if (getJwtSessionId(newToken) !== 'session-a') throw new Error('JWT session_id is decoded');

console.log('nativeResidentSessionPolicy: 8 tests passed');
