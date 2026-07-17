type JwtSessionClaims = {
  sub: string;
  iat: number;
  exp: number;
  sessionId: string | null;
};

function decodeJwtSessionClaims(token: string): JwtSessionClaims | null {
  const payload = token.split('.')[1];
  if (!payload || typeof atob !== 'function' || typeof TextDecoder === 'undefined') return null;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const sub = typeof parsed.sub === 'string' ? parsed.sub.trim() : '';
    const iat = Number(parsed.iat);
    const exp = Number(parsed.exp);
    const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id.trim() : '';
    if (!sub || !Number.isFinite(iat) || !Number.isFinite(exp)) return null;
    return { sub, iat, exp, sessionId: sessionId || null };
  } catch {
    return null;
  }
}

export function getJwtSessionId(token: string): string | null {
  return decodeJwtSessionClaims(token)?.sessionId ?? null;
}

/** Returns true only when native credentials are safe and newer than WebView persistence. */
export function shouldRestoreNativeAuthorization(
  nativeAccessToken: string,
  persistedAccessToken: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  // Without a persisted WebView session we cannot prove that the native token
  // belongs to the account that is still signed in. This also prevents an
  // explicit sign-out from being undone by the background service.
  if (!persistedAccessToken) return false;
  const nativeClaims = decodeJwtSessionClaims(nativeAccessToken);
  const persistedClaims = decodeJwtSessionClaims(persistedAccessToken);
  if (!persistedClaims) return !!nativeClaims;
  if (!nativeClaims) return false;
  if (nativeClaims.sub !== persistedClaims.sub) return false;
  if (
    nativeClaims.sessionId
    && persistedClaims.sessionId
    && nativeClaims.sessionId !== persistedClaims.sessionId
  ) {
    return false;
  }

  const marginSeconds = 30;
  const nowSeconds = Math.floor(nowMs / 1000);
  const nativeUsable = nativeClaims.exp > nowSeconds + marginSeconds;
  const persistedUsable = persistedClaims.exp > nowSeconds + marginSeconds;
  if (nativeUsable !== persistedUsable) return nativeUsable;
  if (nativeClaims.iat !== persistedClaims.iat) return nativeClaims.iat > persistedClaims.iat;
  return nativeClaims.exp > persistedClaims.exp;
}
