import type { DriverIdentity } from '../domain/remoteTypes';

export const DRIVER_IDENTITY_CHECK_TIMEOUT_MS = 8_000;

export function getNativeAuthorizationEmail(accessToken: string): string | null {
  try {
    const payload = accessToken.split('.')[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
    return typeof claims.sub === 'string' && typeof claims.email === 'string'
      ? claims.email.trim().toLowerCase() || null
      : null;
  } catch {
    return null;
  }
}

/** Native credentials remain the offline owner; saved approval alone is insufficient. */
export function resolveNativeStartupIdentity(input: {
  identity: DriverIdentity;
  authorizationConfigured: boolean;
  authorizationBlocked: boolean;
  authorizationEmail: string | null;
  explicitSignOut: boolean;
}): DriverIdentity {
  if (input.explicitSignOut || input.authorizationBlocked || !input.authorizationConfigured
    || !input.authorizationEmail || input.authorizationEmail !== input.identity.email?.trim().toLowerCase()) {
    return { ...input.identity, authInitialized: false, approvalStatus: 'unregistered' };
  }
  return input.identity;
}

/** Publish local state immediately, but let a later server result take precedence. */
export function startDriverIdentityCheck(options: {
  readLocal: () => Promise<DriverIdentity | null>;
  refresh: () => Promise<DriverIdentity>;
  onIdentity: (identity: DriverIdentity) => void;
  onUnavailable: () => void;
  onFailure?: (error: unknown) => boolean | void;
  onSettled: () => void;
  timeoutMs?: number;
}) {
  let cancelled = false;
  let finished = false;
  let localFinished = false;
  let remoteFinished = false;
  let remotePublished = false;
  let identityAvailable = false;
  let resolveSettled!: () => void;
  const settled = new Promise<void>(resolve => { resolveSettled = resolve; });
  const finish = () => {
    if (finished || cancelled) return;
    finished = true;
    clearTimeout(timer);
    if (!identityAvailable) options.onUnavailable();
    options.onSettled();
    resolveSettled();
  };
  const timer = setTimeout(finish, options.timeoutMs ?? DRIVER_IDENTITY_CHECK_TIMEOUT_MS);
  const publish = (identity: DriverIdentity) => {
    if (cancelled) return;
    identityAvailable = true;
    options.onIdentity(identity);
  };
  void Promise.resolve().then(options.readLocal).then(identity => {
    if (identity && !remotePublished) publish(identity);
  }).catch(() => {
    // A local read failure is not evidence of a missing registration.
  }).finally(() => {
    localFinished = true;
    if (remoteFinished) finish();
  });
  void Promise.resolve().then(options.refresh).then(identity => {
    remotePublished = true;
    publish(identity);
    finish();
  }).catch(error => {
    if (!cancelled && options.onFailure?.(error) === true) remotePublished = true;
    // Retain a confirmed local snapshot during transient communication failure.
  }).finally(() => {
    remoteFinished = true;
    if (localFinished) finish();
  });
  return {
    settled,
    cancel() {
      cancelled = true;
      clearTimeout(timer);
      resolveSettled();
    },
  };
}
