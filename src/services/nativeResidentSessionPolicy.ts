export type JwtSessionClaims = {
  sub: string;
  iat: number;
  exp: number;
  sessionId: string | null;
};

export function decodeJwtSessionClaims(token: string): JwtSessionClaims | null {
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
function shouldUseNativeAuthorization(
  nativeAccessToken: string,
  persistedAccessToken: string | null | undefined,
  nowMs: number,
  allowSessionHandoff: boolean,
): boolean {
  const nativeClaims = decodeJwtSessionClaims(nativeAccessToken);
  // Native authorization is cleared before an explicit driver sign-out. If
  // WebView persistence alone disappeared, the remaining native credentials
  // are the durable enrollment for this approved Android installation.
  if (!persistedAccessToken) return !!nativeClaims;
  const persistedClaims = decodeJwtSessionClaims(persistedAccessToken);
  if (!persistedClaims) return !!nativeClaims;
  if (!nativeClaims) return false;
  if (nativeClaims.sub !== persistedClaims.sub) return false;
  if (
    !allowSessionHandoff
    && nativeClaims.sessionId
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

export function shouldRestoreNativeAuthorization(
  nativeAccessToken: string,
  persistedAccessToken: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  return shouldUseNativeAuthorization(
    nativeAccessToken,
    persistedAccessToken,
    nowMs,
    false,
  );
}

export function shouldBootstrapNativeAuthorization(
  nativeAccessToken: string,
  persistedAccessToken: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  return shouldUseNativeAuthorization(
    nativeAccessToken,
    persistedAccessToken,
    nowMs,
    true,
  );
}

export function shouldInstallWebAuthorizationIntoNative(input: {
  nativeConfigured: boolean;
  nativeAccessToken: string;
  nativeRefreshToken: string;
  webAccessToken: string;
  webRefreshToken: string;
  nowMs?: number;
}): boolean {
  if (!input.webAccessToken || !input.webRefreshToken) return false;
  if (
    input.nativeAccessToken === input.webAccessToken
    && input.nativeRefreshToken === input.webRefreshToken
  ) {
    return false;
  }
  if (!input.nativeConfigured) return true;
  return shouldBootstrapNativeAuthorization(
    input.webAccessToken,
    input.nativeAccessToken,
    input.nowMs,
  );
}

function parseStoredSession(raw: string | null): {
  raw: string;
  session: Record<string, unknown>;
  accessToken: string;
  claims: JwtSessionClaims;
  hasUser: boolean;
} | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    const session = (
      parsed.currentSession && typeof parsed.currentSession === 'object'
        ? parsed.currentSession
        : parsed
    ) as Record<string, unknown>;
    const accessToken = typeof session.access_token === 'string' ? session.access_token.trim() : '';
    const claims = decodeJwtSessionClaims(accessToken);
    if (!accessToken || !claims) return null;
    return {
      raw,
      session,
      accessToken,
      claims,
      hasUser: !!session.user && typeof session.user === 'object',
    };
  } catch {
    return null;
  }
}

export function selectPreferredPersistedAuthSession(
  localRaw: string | null,
  indexedRaw: string | null,
  nowMs = Date.now(),
): string | null {
  const local = parseStoredSession(localRaw);
  const indexed = parseStoredSession(indexedRaw);
  if (!local) return indexed?.raw ?? null;
  if (!indexed) return local.raw;
  if (local.accessToken === indexed.accessToken) {
    return indexed.hasUser && !local.hasUser ? indexed.raw : local.raw;
  }
  // localStorage remains authoritative across different accounts. Native
  // bootstrap will then reject a credential belonging to the other account.
  if (local.claims.sub !== indexed.claims.sub) return local.raw;
  if (shouldBootstrapNativeAuthorization(indexed.accessToken, local.accessToken, nowMs)) {
    return indexed.raw;
  }
  if (shouldBootstrapNativeAuthorization(local.accessToken, indexed.accessToken, nowMs)) {
    return local.raw;
  }
  return indexed.hasUser && !local.hasUser ? indexed.raw : local.raw;
}

export function buildNativeBootstrappedSession(input: {
  nativeAccessToken: string;
  nativeRefreshToken: string;
  persistedRaw: string | null;
  nowMs?: number;
}): string | null {
  const nativeAccessToken = input.nativeAccessToken.trim();
  const nativeRefreshToken = input.nativeRefreshToken.trim();
  if (!nativeAccessToken || !nativeRefreshToken) return null;

  let persisted: Record<string, unknown> = {};
  if (input.persistedRaw) {
    try {
      const parsed = JSON.parse(input.persistedRaw) as unknown;
      if (parsed && typeof parsed === 'object') persisted = parsed as Record<string, unknown>;
    } catch {
      persisted = {};
    }
  }
  const persistedSession = (
    persisted.currentSession && typeof persisted.currentSession === 'object'
      ? persisted.currentSession
      : persisted
  ) as Record<string, unknown>;
  const persistedAccessToken = typeof persistedSession.access_token === 'string'
    ? persistedSession.access_token
    : null;
  const nowMs = input.nowMs ?? Date.now();
  if (!shouldBootstrapNativeAuthorization(nativeAccessToken, persistedAccessToken, nowMs)) {
    return null;
  }

  const claims = decodeJwtSessionClaims(nativeAccessToken);
  if (!claims) return null;
  const nowSeconds = Math.floor(nowMs / 1000);
  const nextSession: Record<string, unknown> = {
    ...persistedSession,
    access_token: nativeAccessToken,
    refresh_token: nativeRefreshToken,
    token_type: typeof persistedSession.token_type === 'string'
      ? persistedSession.token_type
      : 'bearer',
    expires_at: claims.exp,
    expires_in: Math.max(0, claims.exp - nowSeconds),
  };
  return JSON.stringify(nextSession);
}
