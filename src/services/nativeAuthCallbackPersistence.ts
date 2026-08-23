const NATIVE_AUTH_CALLBACK_URL_KEY = '__tracklog_native_auth_callback_url__';
const NATIVE_AUTH_CALLBACK_INTENT_KEY = '__tracklog_native_auth_callback_intent__';
const NATIVE_AUTH_ATTEMPT_KEY = '__tracklog_native_auth_attempt__';
const STORAGE_CLOCK_SKEW_MS = 60 * 1_000;

export const NATIVE_AUTH_ATTEMPT_TTL_MS = 10 * 60 * 1_000;
export const NATIVE_AUTH_CALLBACK_TTL_MS = 5 * 60 * 1_000;

export type NativeAuthCallbackIntent = 'admin' | 'driver';

export type NativeAuthAttempt = {
  id: string;
  intent: NativeAuthCallbackIntent;
  startedAt: number;
  expiresAt: number;
};

export type NativeAuthCallbackIntentRecord = {
  intent: NativeAuthCallbackIntent;
  attemptId: string;
  expiresAt: number;
};

export type PendingNativeAuthCallback = {
  url: string;
  attemptId: string | null;
  receivedAt: number;
  expiresAt: number;
  exchangeStartedAt?: number;
  priorSessionFingerprint?: string | null;
  sessionEstablishedAt?: number;
};

export class NativeAuthFlowInProgressError extends Error {
  readonly code = 'native_auth_flow_in_progress';

  constructor(readonly attempt: NativeAuthAttempt | null) {
    super('未完了のログインがあります。続けるか、「ログインを最初からやり直す」を選んでください。');
    this.name = 'NativeAuthFlowInProgressError';
  }
}

type BeginNativeAuthAttemptOptions = {
  now?: number;
  restart?: boolean;
  attemptId?: string;
};

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function writeStorage(storage: Storage | null, key: string, value: string) {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // storage can be unavailable in some WebView configurations.
  }
}

function readStorage(storage: Storage | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function removeStorage(storage: Storage | null, key: string) {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Ignore storage failures.
  }
}

function writeMirrored(key: string, value: string) {
  writeStorage(getSessionStorage(), key, value);
  writeStorage(getStorage(), key, value);
}

function removeMirrored(key: string) {
  removeStorage(getSessionStorage(), key);
  removeStorage(getStorage(), key);
}

function readMirrored(key: string): [string | null, string | null] {
  return [
    readStorage(getSessionStorage(), key),
    readStorage(getStorage(), key),
  ];
}

function isKnownIntent(value: unknown): value is NativeAuthCallbackIntent {
  return value === 'admin' || value === 'driver';
}

function isSafeAttemptId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isSafeSessionFingerprint(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 256 && /^[A-Za-z0-9:_-]+$/.test(value);
}

function parseAttempt(value: string | null): NativeAuthAttempt | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<NativeAuthAttempt>;
    if (
      !isSafeAttemptId(parsed.id) ||
      !isKnownIntent(parsed.intent) ||
      !isFiniteTimestamp(parsed.startedAt) ||
      !isFiniteTimestamp(parsed.expiresAt) ||
      parsed.expiresAt <= parsed.startedAt ||
      parsed.expiresAt - parsed.startedAt > NATIVE_AUTH_ATTEMPT_TTL_MS
    ) {
      return null;
    }
    return {
      id: parsed.id,
      intent: parsed.intent,
      startedAt: parsed.startedAt,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

function parseIntentRecord(value: string | null): NativeAuthCallbackIntentRecord | null {
  if (!value) return null;
  // Older builds stored only the role. It was not bound to a PKCE verifier,
  // so it must not be allowed to override the callback's safe next route.
  if (isKnownIntent(value)) return null;
  try {
    const parsed = JSON.parse(value) as Partial<NativeAuthCallbackIntentRecord>;
    if (
      !isKnownIntent(parsed.intent) ||
      !isSafeAttemptId(parsed.attemptId) ||
      !isFiniteTimestamp(parsed.expiresAt)
    ) {
      return null;
    }
    return {
      intent: parsed.intent,
      attemptId: parsed.attemptId,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

function getCallbackAttemptId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const hash = new URLSearchParams(parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash);
    const value = parsed.searchParams.get('attempt') ?? hash.get('attempt');
    return isSafeAttemptId(value) ? value : null;
  } catch {
    return null;
  }
}

function parsePendingCallback(value: string | null, now: number): PendingNativeAuthCallback | null {
  if (!value) return null;
  // Migrate an appUrlOpen captured by an older build. Its receipt time was not
  // recorded, so begin the bounded retry window when this build first sees it.
  if (isAuthCallbackUrl(value)) {
    return {
      url: value,
      attemptId: getCallbackAttemptId(value),
      receivedAt: now,
      expiresAt: now + NATIVE_AUTH_CALLBACK_TTL_MS,
    };
  }
  try {
    const parsed = JSON.parse(value) as Partial<PendingNativeAuthCallback>;
    const hasPriorSessionFingerprint = Object.prototype.hasOwnProperty.call(parsed, 'priorSessionFingerprint');
    if (
      typeof parsed.url !== 'string' ||
      !isAuthCallbackUrl(parsed.url) ||
      (parsed.attemptId != null && !isSafeAttemptId(parsed.attemptId)) ||
      !isFiniteTimestamp(parsed.receivedAt) ||
      !isFiniteTimestamp(parsed.expiresAt) ||
      parsed.expiresAt <= parsed.receivedAt ||
      parsed.expiresAt - parsed.receivedAt > NATIVE_AUTH_CALLBACK_TTL_MS ||
      (parsed.exchangeStartedAt != null && (
        !isFiniteTimestamp(parsed.exchangeStartedAt) ||
        parsed.exchangeStartedAt < parsed.receivedAt - STORAGE_CLOCK_SKEW_MS ||
        parsed.exchangeStartedAt > parsed.expiresAt + STORAGE_CLOCK_SKEW_MS
      )) ||
      (parsed.exchangeStartedAt == null && hasPriorSessionFingerprint) ||
      (parsed.exchangeStartedAt != null && (
        !hasPriorSessionFingerprint ||
        (parsed.priorSessionFingerprint !== null && !isSafeSessionFingerprint(parsed.priorSessionFingerprint))
      )) ||
      (parsed.sessionEstablishedAt != null && (
        !isFiniteTimestamp(parsed.sessionEstablishedAt) ||
        parsed.sessionEstablishedAt < parsed.receivedAt - STORAGE_CLOCK_SKEW_MS ||
        parsed.sessionEstablishedAt > parsed.expiresAt + STORAGE_CLOCK_SKEW_MS
      ))
    ) {
      return null;
    }
    return {
      url: parsed.url,
      attemptId: parsed.attemptId ?? null,
      receivedAt: parsed.receivedAt,
      expiresAt: parsed.expiresAt,
      ...(isFiniteTimestamp(parsed.exchangeStartedAt)
        ? {
          exchangeStartedAt: parsed.exchangeStartedAt,
          priorSessionFingerprint: parsed.priorSessionFingerprint ?? null,
        }
        : {}),
      ...(isFiniteTimestamp(parsed.sessionEstablishedAt)
        ? { sessionEstablishedAt: parsed.sessionEstablishedAt }
        : {}),
    };
  } catch {
    return null;
  }
}

function selectNewest<T>(first: T | null, second: T | null, getTimestamp: (value: T) => number) {
  if (!first) return second;
  if (!second) return first;
  return getTimestamp(second) > getTimestamp(first) ? second : first;
}

function createAttemptId() {
  try {
    const id = globalThis.crypto?.randomUUID?.();
    if (id && isSafeAttemptId(id)) return id;
  } catch {
    // Fall through to a WebView-compatible identifier.
  }
  const random = Math.random().toString(36).slice(2);
  return `auth_${Date.now().toString(36)}_${random}`;
}

function isAuthCallbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'com.tracklog.assist:' &&
      parsed.host === 'auth' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port &&
      (parsed.pathname === '' || parsed.pathname === '/')
    );
  } catch {
    return false;
  }
}

export function isTracklogNativeAuthCallbackUrl(url: string): boolean {
  return isAuthCallbackUrl(url);
}

export function peekNativeAuthAttemptRecord(): NativeAuthAttempt | null {
  const [sessionValue, localValue] = readMirrored(NATIVE_AUTH_ATTEMPT_KEY);
  return selectNewest(
    parseAttempt(sessionValue),
    parseAttempt(localValue),
    attempt => attempt.startedAt,
  );
}

export function getNativeAuthAttempt(now = Date.now()): NativeAuthAttempt | null {
  const selected = peekNativeAuthAttemptRecord();
  if (
    !selected ||
    selected.expiresAt <= now ||
    selected.startedAt > now + STORAGE_CLOCK_SKEW_MS ||
    selected.expiresAt > now + NATIVE_AUTH_ATTEMPT_TTL_MS + STORAGE_CLOCK_SKEW_MS
  ) {
    removeMirrored(NATIVE_AUTH_ATTEMPT_KEY);
    removeMirrored(NATIVE_AUTH_CALLBACK_INTENT_KEY);
    return null;
  }
  writeMirrored(NATIVE_AUTH_ATTEMPT_KEY, JSON.stringify(selected));
  return selected;
}

export function beginNativeAuthAttempt(
  intent: NativeAuthCallbackIntent,
  options: BeginNativeAuthAttemptOptions = {},
): NativeAuthAttempt {
  const now = options.now ?? Date.now();
  const existing = getNativeAuthAttempt(now);
  if (existing && !options.restart) {
    throw new NativeAuthFlowInProgressError(existing);
  }
  if (!existing && getPendingNativeAuthCallback(now) && !options.restart) {
    throw new NativeAuthFlowInProgressError(null);
  }
  if (options.restart) {
    clearNativeAuthAttempt();
    clearNativeAuthCallbackUrl();
  }
  const id = options.attemptId ?? createAttemptId();
  if (!isSafeAttemptId(id)) throw new Error('認証試行IDが不正です');
  const attempt: NativeAuthAttempt = {
    id,
    intent,
    startedAt: now,
    expiresAt: now + NATIVE_AUTH_ATTEMPT_TTL_MS,
  };
  const intentRecord: NativeAuthCallbackIntentRecord = {
    intent,
    attemptId: id,
    expiresAt: attempt.expiresAt,
  };
  writeMirrored(NATIVE_AUTH_ATTEMPT_KEY, JSON.stringify(attempt));
  writeMirrored(NATIVE_AUTH_CALLBACK_INTENT_KEY, JSON.stringify(intentRecord));
  return attempt;
}

export function clearNativeAuthAttempt(expectedAttemptId?: string | null): boolean {
  const current = getNativeAuthAttempt();
  if (expectedAttemptId && current && current.id !== expectedAttemptId) return false;
  if (expectedAttemptId && !current) {
    removeMirrored(NATIVE_AUTH_CALLBACK_INTENT_KEY);
    return false;
  }
  removeMirrored(NATIVE_AUTH_ATTEMPT_KEY);
  removeMirrored(NATIVE_AUTH_CALLBACK_INTENT_KEY);
  return current != null;
}

export function isNativeAuthFlowInProgressError(error: unknown): error is NativeAuthFlowInProgressError {
  return (
    error instanceof NativeAuthFlowInProgressError ||
    (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'native_auth_flow_in_progress')
  );
}

export function getNativeAuthCallbackIntentRecord(now = Date.now()): NativeAuthCallbackIntentRecord | null {
  const attempt = getNativeAuthAttempt(now);
  if (!attempt) return null;
  const [sessionValue, localValue] = readMirrored(NATIVE_AUTH_CALLBACK_INTENT_KEY);
  const sessionRecord = parseIntentRecord(sessionValue);
  const localRecord = parseIntentRecord(localValue);
  const record = sessionRecord?.attemptId === attempt.id
    ? sessionRecord
    : localRecord?.attemptId === attempt.id
      ? localRecord
      : null;
  if (!record || record.expiresAt <= now || record.intent !== attempt.intent) {
    removeMirrored(NATIVE_AUTH_CALLBACK_INTENT_KEY);
    return null;
  }
  writeMirrored(NATIVE_AUTH_CALLBACK_INTENT_KEY, JSON.stringify(record));
  return record;
}

export function getNativeAuthCallbackIntent(now = Date.now()): NativeAuthCallbackIntent | null {
  return getNativeAuthCallbackIntentRecord(now)?.intent ?? null;
}

/** @deprecated Use beginNativeAuthAttempt so the role remains tied to a PKCE attempt. */
export function setNativeAuthCallbackIntent(intent: NativeAuthCallbackIntent | null): void {
  if (intent == null) {
    clearNativeAuthAttempt();
    return;
  }
  const existing = getNativeAuthAttempt();
  if (existing) return;
  beginNativeAuthAttempt(intent);
}

/** @deprecated Callback completion should clear a matching attempt explicitly. */
export function consumeNativeAuthCallbackIntent(): NativeAuthCallbackIntent | null {
  const intent = getNativeAuthCallbackIntent();
  clearNativeAuthAttempt();
  return intent;
}

export function persistNativeAuthCallbackUrl(url: string, now = Date.now()): void {
  if (!url || !isAuthCallbackUrl(url)) return;
  const callbackAttemptId = getCallbackAttemptId(url);
  const activeAttempt = getNativeAuthAttempt(now);
  if (activeAttempt && callbackAttemptId !== activeAttempt.id) return;
  const existing = getPendingNativeAuthCallback(now);
  if (existing?.url === url) return;
  if (activeAttempt && existing?.attemptId === activeAttempt.id) return;
  const callback: PendingNativeAuthCallback = {
    url,
    attemptId: callbackAttemptId,
    receivedAt: now,
    expiresAt: now + NATIVE_AUTH_CALLBACK_TTL_MS,
  };
  writeMirrored(NATIVE_AUTH_CALLBACK_URL_KEY, JSON.stringify(callback));
}

export function getPendingNativeAuthCallback(now = Date.now()): PendingNativeAuthCallback | null {
  const [sessionValue, localValue] = readMirrored(NATIVE_AUTH_CALLBACK_URL_KEY);
  const selected = selectNewest(
    parsePendingCallback(sessionValue, now),
    parsePendingCallback(localValue, now),
    callback => callback.receivedAt,
  );
  if (
    !selected ||
    selected.expiresAt <= now ||
    selected.receivedAt > now + STORAGE_CLOCK_SKEW_MS ||
    selected.expiresAt > now + NATIVE_AUTH_CALLBACK_TTL_MS + STORAGE_CLOCK_SKEW_MS
  ) {
    removeMirrored(NATIVE_AUTH_CALLBACK_URL_KEY);
    return null;
  }
  writeMirrored(NATIVE_AUTH_CALLBACK_URL_KEY, JSON.stringify(selected));
  return selected;
}

export function getNativeAuthCallbackUrl(now = Date.now()): string | null {
  return getPendingNativeAuthCallback(now)?.url ?? null;
}

export function markNativeAuthCallbackExchangeStarted(
  url: string,
  attemptId: string | null,
  priorSessionFingerprint: string | null,
  now = Date.now(),
): boolean {
  const current = getPendingNativeAuthCallback(now);
  if (
    !current ||
    current.url !== url ||
    current.attemptId !== attemptId ||
    (priorSessionFingerprint !== null && !isSafeSessionFingerprint(priorSessionFingerprint))
  ) {
    return false;
  }
  const updated: PendingNativeAuthCallback = {
    ...current,
    exchangeStartedAt: now,
    priorSessionFingerprint,
  };
  writeMirrored(NATIVE_AUTH_CALLBACK_URL_KEY, JSON.stringify(updated));
  return true;
}

export function markNativeAuthCallbackSessionEstablished(url: string, now = Date.now()): boolean {
  const current = getPendingNativeAuthCallback(now);
  if (!current || current.url !== url) return false;
  const updated: PendingNativeAuthCallback = {
    ...current,
    sessionEstablishedAt: now,
  };
  writeMirrored(NATIVE_AUTH_CALLBACK_URL_KEY, JSON.stringify(updated));
  return true;
}

export function clearNativeAuthCallbackUrl(expectedUrl?: string | null): boolean {
  const current = getPendingNativeAuthCallback();
  if (expectedUrl && current && current.url !== expectedUrl) return false;
  if (expectedUrl && !current) return false;
  removeMirrored(NATIVE_AUTH_CALLBACK_URL_KEY);
  return current != null;
}

export function consumeNativeAuthCallbackUrl(): string | null {
  const value = getNativeAuthCallbackUrl();
  clearNativeAuthCallbackUrl(value);
  return value;
}
