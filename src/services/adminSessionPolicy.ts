import type { AdminSession } from '../domain/remoteTypes';

export type ValidatedAdminUser = {
  email: string | null;
};

export type ServerAdminAccessState = {
  email: string | null;
  isAdmin: boolean;
};

export type AdminValidationFailureKind = 'definitive' | 'transient';
export type AdminValidationFailureDisposition = 'revoke' | 'retain-read-only' | 'block';

export type AdminEntryAvailabilityState = {
  visible: boolean;
  hasValidatedAdminSession: boolean;
};

export type AdminEntryValidationOutcome =
  | { kind: 'validated'; authenticated: boolean; isAdmin: boolean }
  | { kind: 'failed'; failure: AdminValidationFailureKind };

type ResolveAdminSessionOptions = {
  configured: boolean;
  validateUser: () => Promise<ValidatedAdminUser | null>;
  getServerAccessState: () => Promise<ServerAdminAccessState>;
};

function normalizeEmail(value: string | null | undefined) {
  return `${value ?? ''}`.trim().toLowerCase();
}

function numericStatus(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function collectErrorEvidence(error: unknown) {
  const messages: string[] = [];
  const statuses: number[] = [];
  let current = error;
  for (let depth = 0; current != null && depth < 6; depth += 1) {
    if (typeof current === 'string') {
      messages.push(current);
      break;
    }
    if (typeof current !== 'object') break;
    const record = current as Record<string, unknown>;
    for (const key of ['name', 'message', 'code']) {
      if (typeof record[key] === 'string') messages.push(record[key] as string);
    }
    const directStatus = numericStatus(record.status) ?? numericStatus(record.statusCode);
    if (directStatus != null) statuses.push(directStatus);
    const context = record.context;
    if (context && typeof context === 'object') {
      const contextRecord = context as Record<string, unknown>;
      const contextStatus = numericStatus(contextRecord.status) ?? numericStatus(contextRecord.statusCode);
      if (contextStatus != null) statuses.push(contextStatus);
    }
    current = record.cause;
  }
  return { message: messages.join(' ').toLowerCase(), statuses };
}

/**
 * Definitive authentication failures revoke access immediately. Everything
 * else is treated as transient, but transient failures only retain a screen
 * that was already validated and are always forced into read-only mode.
 */
export function classifyAdminValidationFailure(
  error: unknown,
  online = typeof navigator === 'undefined' ? true : navigator.onLine,
): AdminValidationFailureKind {
  const evidence = collectErrorEvidence(error);
  if (evidence.statuses.some(status => status === 401 || status === 403)) return 'definitive';
  if (
    evidence.message.includes('authsessionmissing')
    || evidence.message.includes('auth session missing')
    || evidence.message.includes('invalid jwt')
    || evidence.message.includes('jwt expired')
    || evidence.message.includes('token has expired')
    || evidence.message.includes('invalid refresh token')
    || evidence.message.includes('refresh token not found')
    || evidence.message.includes('session not found')
    || evidence.message.includes('user not found')
    || evidence.message.includes('unauthorized')
  ) {
    return 'definitive';
  }
  if (!online) return 'transient';
  return 'transient';
}

export function getAdminValidationFailureDisposition(
  failure: AdminValidationFailureKind,
  hasValidatedAdminSession: boolean,
): AdminValidationFailureDisposition {
  if (failure === 'definitive') return 'revoke';
  return hasValidatedAdminSession ? 'retain-read-only' : 'block';
}

export function initialAdminEntryAvailability(): AdminEntryAvailabilityState {
  return {
    visible: false,
    hasValidatedAdminSession: false,
  };
}

/**
 * Admin entry points stay hidden until this mounted UI has completed a server
 * validation. A transient failure may retain an already-confirmed link, while
 * a definitive denial or invalid session removes it immediately.
 */
export function reduceAdminEntryAvailability(
  current: AdminEntryAvailabilityState,
  outcome: AdminEntryValidationOutcome,
): AdminEntryAvailabilityState {
  if (outcome.kind === 'validated') {
    const confirmedAdmin = outcome.authenticated && outcome.isAdmin;
    return {
      visible: confirmedAdmin,
      hasValidatedAdminSession: confirmedAdmin,
    };
  }

  const disposition = getAdminValidationFailureDisposition(
    outcome.failure,
    current.hasValidatedAdminSession,
  );
  if (disposition === 'retain-read-only') return current;
  return initialAdminEntryAvailability();
}

function unavailableAdminSession(configured: boolean): AdminSession {
  return {
    configured,
    authenticated: false,
    isAdmin: false,
    email: null,
  };
}

/**
 * Builds an admin session only after both Auth and the server-side allowlist
 * have been checked. A missing or mismatched email always fails closed.
 */
export async function resolveAdminSession(
  options: ResolveAdminSessionOptions,
): Promise<AdminSession> {
  if (!options.configured) return unavailableAdminSession(false);

  const user = await options.validateUser();
  if (!user) return unavailableAdminSession(true);

  const email = normalizeEmail(user.email);
  if (!email) {
    return {
      configured: true,
      authenticated: true,
      isAdmin: false,
      email: null,
    };
  }

  const access = await options.getServerAccessState();
  const serverEmail = normalizeEmail(access.email);
  return {
    configured: true,
    authenticated: true,
    isAdmin: access.isAdmin && serverEmail === email,
    email: user.email?.trim() || null,
  };
}
