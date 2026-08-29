import { Capacitor } from '@capacitor/core';
import { getStableDeviceKey } from './deviceIdentity';
import {
  clearPersistedDriverAuthSession,
  driverAuthSupabase,
  getPersistedDriverAuthTokens,
  SUPABASE_CONFIGURED,
} from './supabase';
import { isDriverExplicitSignOutRequested } from './authStorageKeys';
import { isPermanentDriverAuthFailure } from './driverAuthFailurePolicy';
import {
  canApplyDriverAuthIntent,
  getDriverAuthIntentGeneration,
  withDriverAuthMutation,
} from './driverAuthMutationLock';
import {
  deferNativeAuthRecovery,
  getDeferredNativeAuthRecoveryError,
  resetNativeAuthRecoveryBackoff,
} from './nativeAuthRecoveryBackoff';
import {
  EMPTY_NATIVE_AUTHORIZATION_VERIFICATION_BACKOFF,
  createNativeAuthorizationVerificationMarker,
  deferNativeAuthorizationVerification,
  shouldAttemptNativeAuthorizationVerification,
} from './nativeAuthorizationVerificationBackoff';
import {
  getJwtSessionId,
  shouldInstallWebAuthorizationIntoNative,
  shouldRestoreNativeAuthorization,
} from './nativeResidentSessionPolicy';
import {
  ResidentLocation,
  type NativeResidentLocationAuthorization,
  type NativeResidentExpresswayEvent,
  type NativeResidentLocationPoint,
  type NativeResidentLocationSettings,
  type NativeResidentLocationStatus,
} from './residentLocationBridge';

export type {
  NativeResidentLocationAuthorization,
  NativeResidentExpresswayEvent,
  NativeResidentLocationPoint,
  NativeResidentLocationSettings,
  NativeResidentLocationStatus,
} from './residentLocationBridge';

export type NativeResidentExpresswayConfig = {
  speedKmh: number;
  durationSec: number;
  endSpeedKmh: number;
  endDurationSec: number;
};

const DEFAULT_NATIVE_EXPRESSWAY_CONFIG: NativeResidentExpresswayConfig = {
  speedKmh: 78,
  durationSec: 6,
  endSpeedKmh: 34,
  endDurationSec: 24,
};

export type NativeResidentLocationTrackingIntent = {
  approved: boolean;
  setupComplete: boolean;
  activeTripId: string | null;
  routePauseAt?: string | null;
  expresswayOpen?: boolean;
  expresswayConfig?: NativeResidentExpresswayConfig;
};

function normalizeFiniteInteger(value: number, fallback: number, min: number, max: number) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

export function buildNativeResidentLocationReconcileRequest(
  options: NativeResidentLocationTrackingIntent,
) {
  const routePauseAtMs = Date.parse(options.routePauseAt ?? '');
  const config = options.expresswayConfig ?? DEFAULT_NATIVE_EXPRESSWAY_CONFIG;
  return {
    approved: options.approved,
    setupComplete: options.setupComplete,
    activeTripId: options.activeTripId?.trim() ?? '',
    routePauseAtMs: Number.isFinite(routePauseAtMs) ? routePauseAtMs : 0,
    expresswayOpen: options.expresswayOpen === true,
    expresswayConfig: {
      speedKmh: normalizeFiniteInteger(config.speedKmh, DEFAULT_NATIVE_EXPRESSWAY_CONFIG.speedKmh, 30, 160),
      durationSec: normalizeFiniteInteger(config.durationSec, DEFAULT_NATIVE_EXPRESSWAY_CONFIG.durationSec, 1, 60),
      endSpeedKmh: normalizeFiniteInteger(config.endSpeedKmh, DEFAULT_NATIVE_EXPRESSWAY_CONFIG.endSpeedKmh, 10, 120),
      endDurationSec: normalizeFiniteInteger(config.endDurationSec, DEFAULT_NATIVE_EXPRESSWAY_CONFIG.endDurationSec, 5, 300),
    },
  };
}

export function buildNativeApprovalSuspensionRequest() {
  return buildNativeResidentLocationReconcileRequest({
    approved: false,
    setupComplete: false,
    activeTripId: null,
    expresswayOpen: false,
  });
}

export function matchesInstalledNativeAuthorization(
  installed: NativeResidentLocationAuthorization,
  expected: { accessToken: string; refreshToken: string },
) {
  return installed.configured
    && !installed.blocked
    && installed.accessToken === expected.accessToken
    && installed.refreshToken === expected.refreshToken;
}

const EMPTY_SETTINGS: NativeResidentLocationSettings = {
  foregroundLocation: false,
  backgroundLocation: false,
  notifications: false,
  batteryOptimization: false,
  exactAlarm: false,
  locationEnabled: false,
};

const EMPTY_STATUS: NativeResidentLocationStatus = {
  approved: false,
  setupComplete: false,
  enabled: false,
  eligible: false,
  ready: false,
  running: false,
  startRequested: false,
  activeTripId: '',
  routePauseAtMs: 0,
  queuedPointCount: 0,
  expresswayPendingEventCount: 0,
  expresswayStorageHealthy: true,
  expresswayOpen: false,
  expresswayPromptPending: false,
  expresswayProbePending: false,
  expresswayProbeAttemptCount: 0,
  expresswayProbeLastFailureCategory: '',
  expresswayProbeFailureUpdatedAt: 0,
  expresswayGeneration: 0,
  queuedStorageBytes: 0,
  queueSegmentCount: 0,
  quarantinedStorageBytes: 0,
  quarantineSegmentCount: 0,
  queueStorageHealthy: true,
  authorizationConfigured: false,
  authorizationBlocked: false,
  lastUploadAt: 0,
  lastAcceptedLocationAt: 0,
  locationQualitySessionStartedAt: 0,
  locationQualityUpdatedAt: 0,
  locationRejectCounts: {},
  lastQueueWriteAt: 0,
  queueWriteFailureCount: 0,
  lastQueueWriteFailureAt: 0,
  settings: EMPTY_SETTINGS,
};

export type NativeTrackingStateCoordinator = {
  getGeneration(): number;
  advanceGeneration(): number;
  isCurrent(expectedGeneration: number): boolean;
  enqueueCommit<T>(commit: () => Promise<T>): Promise<T>;
};

/**
 * Coordinates local tracking-state intent and serializes native reconcile calls.
 * The settled tail deliberately absorbs failures so one rejected bridge call
 * cannot prevent a later, newer state from reaching the foreground service.
 */
export function createNativeTrackingStateCoordinator(): NativeTrackingStateCoordinator {
  let generation = 0;
  let settledCommitTail: Promise<void> = Promise.resolve();

  return {
    getGeneration: () => generation,
    advanceGeneration: () => {
      generation += 1;
      return generation;
    },
    isCurrent: expectedGeneration => expectedGeneration === generation,
    enqueueCommit: <T>(commit: () => Promise<T>) => {
      const result = settledCommitTail.then(commit);
      settledCommitTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

const trackingStateCoordinator = createNativeTrackingStateCoordinator();

export function getNativeResidentLocationTrackingStateGeneration(): number {
  return trackingStateCoordinator.getGeneration();
}

async function commitNativeResidentLocationTrackingState(
  options: NativeResidentLocationTrackingIntent,
): Promise<NativeResidentLocationStatus> {
  if (!isAndroidNative()) return EMPTY_STATUS;
  const request = buildNativeResidentLocationReconcileRequest(options);
  return trackingStateCoordinator.enqueueCommit(() => ResidentLocation.reconcile(request));
}

async function commitFastNativeResidentLocationTrackingState(
  options: NativeResidentLocationTrackingIntent,
): Promise<NativeResidentLocationStatus> {
  if (!isAndroidNative()) return EMPTY_STATUS;
  const request = buildNativeResidentLocationReconcileRequest(options);
  return trackingStateCoordinator.enqueueCommit(() => ResidentLocation.applyTrackingState({
    activeTripId: request.activeTripId,
    routePauseAtMs: request.routePauseAtMs,
    expresswayOpen: request.expresswayOpen,
    expresswayConfig: request.expresswayConfig,
  }));
}

/** Stops all native tracking while preserving the enrollment authorization. */
export async function suspendNativeResidentLocationForApproval(): Promise<NativeResidentLocationStatus> {
  if (!isAndroidNative()) return EMPTY_STATUS;
  trackingStateCoordinator.advanceGeneration();
  const request = buildNativeApprovalSuspensionRequest();
  return trackingStateCoordinator.enqueueCommit(() => ResidentLocation.reconcile(request));
}

const SUPABASE_URL = (import.meta.env?.VITE_SUPABASE_URL ?? '').trim();
const SUPABASE_ANON_KEY = (import.meta.env?.VITE_SUPABASE_ANON_KEY ?? '').trim();
let restoredAuthorizationUpdatedAt = 0;
let restoreAuthorizationInFlight: Promise<boolean> | null = null;
let restoreAuthorizationForceInFlight = false;
let restoreAuthorizationGeneration = 0;
let authorizationVerificationBackoff = {
  ...EMPTY_NATIVE_AUTHORIZATION_VERIFICATION_BACKOFF,
};

function resetNativeAuthorizationVerificationBackoff() {
  authorizationVerificationBackoff = {
    ...EMPTY_NATIVE_AUTHORIZATION_VERIFICATION_BACKOFF,
  };
}

function isAndroidNative() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

function isResidentAuthIntentCurrent(generation: number) {
  return canApplyDriverAuthIntent(
    generation,
    getDriverAuthIntentGeneration(),
    isDriverExplicitSignOutRequested(),
  );
}

function needsNativeSessionHydration(
  authorization: { accessToken: string; refreshToken: string },
  persisted: Awaited<ReturnType<typeof getPersistedDriverAuthTokens>>,
) {
  return !!persisted
    && !persisted.hasUser
    && persisted.accessToken === authorization.accessToken
    && persisted.refreshToken === authorization.refreshToken;
}

export async function reconcileNativeResidentLocation(options: {
  approved: boolean;
  setupComplete: boolean;
  activeTripId: string | null;
  routePauseAt?: string | null;
  expresswayOpen?: boolean;
  expresswayConfig?: NativeResidentExpresswayConfig;
  expectedTrackingStateGeneration?: number;
}): Promise<NativeResidentLocationStatus> {
  if (!isAndroidNative()) return EMPTY_STATUS;
  const expectedTrackingStateGeneration = options.expectedTrackingStateGeneration
    ?? trackingStateCoordinator.getGeneration();
  const trackingStateIsCurrent = () => trackingStateCoordinator.isCurrent(
    expectedTrackingStateGeneration,
  );
  if (!trackingStateIsCurrent()) return ResidentLocation.getStatus();
  const authIntent = getDriverAuthIntentGeneration();
  if (!isResidentAuthIntentCurrent(authIntent)) return ResidentLocation.getStatus();
  // Local tracking intent is the safety-critical commit. Persist it before any WebView auth or
  // network work so an offline/expired session cannot prevent route spooling and native motion
  // detection. Upload and road probes keep their own durable authorization retry paths.
  await commitNativeResidentLocationTrackingState(options);
  if (!isResidentAuthIntentCurrent(authIntent) || !trackingStateIsCurrent()) {
    return ResidentLocation.getStatus();
  }
  const client = driverAuthSupabase;
  await restoreNativeResidentLocationSession();
  if (!isResidentAuthIntentCurrent(authIntent) || !trackingStateIsCurrent()) {
    return ResidentLocation.getStatus();
  }
  const { data, error } = client
    ? await client.auth.getSession()
    : { data: { session: null }, error: null };
  if (error) throw error;
  if (!isResidentAuthIntentCurrent(authIntent) || !trackingStateIsCurrent()) {
    return ResidentLocation.getStatus();
  }
  const session = data.session;
  if (session && client) {
    const nativeAuthorization = await ResidentLocation.getAuthorization();
    if (!isResidentAuthIntentCurrent(authIntent) || !trackingStateIsCurrent()) {
      return ResidentLocation.getStatus();
    }
    const shouldInstall = shouldInstallWebAuthorizationIntoNative({
      nativeConfigured: nativeAuthorization.configured,
      nativeAccessToken: nativeAuthorization.accessToken,
      nativeRefreshToken: nativeAuthorization.refreshToken,
      webAccessToken: session.access_token,
      webRefreshToken: session.refresh_token,
    });
    if (shouldInstall) {
      const verificationMarker = createNativeAuthorizationVerificationMarker({
        nativeUpdatedAt: nativeAuthorization.updatedAt,
        nativeAccessToken: nativeAuthorization.accessToken,
        nativeRefreshToken: nativeAuthorization.refreshToken,
        webAccessToken: session.access_token,
        webRefreshToken: session.refresh_token,
      });
      if (shouldAttemptNativeAuthorizationVerification(
        authorizationVerificationBackoff,
        verificationMarker,
      )) {
        try {
          const { data: verified, error: verificationError } = await client.auth.getUser();
          if (!verificationError && verified.user) {
            await installNativeResidentLocationAuthorization(authIntent);
          } else {
            authorizationVerificationBackoff = deferNativeAuthorizationVerification(
              authorizationVerificationBackoff,
              verificationMarker,
            );
            if (verificationError) {
              console.warn(
                '[resident-location] newer WebView authorization was not installed',
                verificationError,
              );
            }
          }
        } catch (verificationError) {
          authorizationVerificationBackoff = deferNativeAuthorizationVerification(
            authorizationVerificationBackoff,
            verificationMarker,
          );
          console.warn(
            '[resident-location] newer WebView authorization was not installed',
            verificationError,
          );
        }
      }
    }
  }
  if (!isResidentAuthIntentCurrent(authIntent) || !trackingStateIsCurrent()) {
    return ResidentLocation.getStatus();
  }
  return ResidentLocation.getStatus();
}

/**
 * Apply only the local trip/pause state. This intentionally skips WebView auth
 * refresh so a driver's explicit break decision reaches the foreground service
 * before the app can be backgrounded; the regular supervisor still performs
 * the full authorization reconciliation immediately afterwards.
 */
export async function applyNativeResidentLocationTrackingState(options: {
  approved: boolean;
  setupComplete: boolean;
  activeTripId: string | null;
  routePauseAt?: string | null;
  expresswayOpen?: boolean;
  expresswayConfig?: NativeResidentExpresswayConfig;
}): Promise<NativeResidentLocationStatus> {
  if (!isAndroidNative()) return EMPTY_STATUS;
  const authIntent = getDriverAuthIntentGeneration();
  if (!isResidentAuthIntentCurrent(authIntent)) return ResidentLocation.getStatus();
  trackingStateCoordinator.advanceGeneration();
  return commitFastNativeResidentLocationTrackingState(options);
}

/** Explicitly installs a confirmed login session into the Android owner. */
export async function installNativeResidentLocationAuthorization(
  expectedAuthIntent = getDriverAuthIntentGeneration(),
): Promise<boolean> {
  const client = driverAuthSupabase;
  if (!isAndroidNative() || !SUPABASE_CONFIGURED || !client) return false;
  if (!isResidentAuthIntentCurrent(expectedAuthIntent)) return false;
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  if (!isResidentAuthIntentCurrent(expectedAuthIntent)) return false;
  const session = data.session;
  if (!session?.access_token || !session.refresh_token) return false;
  const { stableDeviceKey } = await getStableDeviceKey();
  if (!isResidentAuthIntentCurrent(expectedAuthIntent)) return false;
  const installedAuthorization = await ResidentLocation.installAuthorization({
    supabaseUrl: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    deviceId: stableDeviceKey,
  });
  if (!matchesInstalledNativeAuthorization(installedAuthorization, {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
  })) {
    throw new Error('端末の認証情報を更新できませんでした');
  }
  if (!isResidentAuthIntentCurrent(expectedAuthIntent)) return false;
  resetNativeAuthRecoveryBackoff();
  resetNativeAuthorizationVerificationBackoff();
  return isResidentAuthIntentCurrent(expectedAuthIntent);
}

export async function restoreNativeResidentLocationSession(options?: {
  forceRefresh?: boolean;
}): Promise<boolean> {
  const client = driverAuthSupabase;
  if (!isAndroidNative() || !SUPABASE_CONFIGURED || !client) return false;
  if (isDriverExplicitSignOutRequested()) return false;
  if (restoreAuthorizationInFlight) {
    const currentRestore = restoreAuthorizationInFlight;
    const currentRestoreWasForced = restoreAuthorizationForceInFlight;
    const result = await currentRestore;
    if (options?.forceRefresh && !currentRestoreWasForced) {
      return restoreNativeResidentLocationSession(options);
    }
    return result;
  }
  const deferredError = getDeferredNativeAuthRecoveryError();
  if (deferredError) throw deferredError;

  const restoreGeneration = restoreAuthorizationGeneration;
  restoreAuthorizationForceInFlight = options?.forceRefresh === true;
  restoreAuthorizationInFlight = withDriverAuthMutation(async () => {
    if (restoreGeneration !== restoreAuthorizationGeneration) return false;
    if (isDriverExplicitSignOutRequested()) return false;
    let authorization;
    try {
      authorization = await ResidentLocation.refreshAuthorization({
        force: options?.forceRefresh === true,
      });
    } catch (error) {
      deferNativeAuthRecovery(error);
      throw error;
    }
    if (restoreGeneration !== restoreAuthorizationGeneration) return false;
    if (!authorization.configured || !authorization.accessToken || !authorization.refreshToken) {
      resetNativeAuthRecoveryBackoff();
      return false;
    }
    const persisted = await getPersistedDriverAuthTokens();
    if (authorization.blocked) {
      const sameBlockedCredential = !persisted || (
        persisted.accessToken === authorization.accessToken
        && persisted.refreshToken === authorization.refreshToken
      );
      if (sameBlockedCredential) {
        await clearPersistedDriverAuthSession();
        const { data: current } = await client.auth.getSession();
        if (current.session) {
          const { error: signOutError } = await client.auth.signOut({ scope: 'local' });
          if (signOutError) {
            console.warn('[resident-location] blocked session cleanup failed', signOutError);
          }
        }
      }
      restoredAuthorizationUpdatedAt = authorization.updatedAt || Date.now();
      resetNativeAuthRecoveryBackoff();
      return false;
    }
    if (
      persisted
      && restoredAuthorizationUpdatedAt > 0
      && authorization.updatedAt <= restoredAuthorizationUpdatedAt
    ) {
      resetNativeAuthRecoveryBackoff();
      return false;
    }
    if (
      !shouldRestoreNativeAuthorization(authorization.accessToken, persisted?.accessToken)
      && !needsNativeSessionHydration(authorization, persisted)
    ) {
      restoredAuthorizationUpdatedAt = Math.max(
        restoredAuthorizationUpdatedAt,
        authorization.updatedAt,
      );
      resetNativeAuthRecoveryBackoff();
      return false;
    }
    if (restoreGeneration !== restoreAuthorizationGeneration) return false;
    if (isDriverExplicitSignOutRequested()) return false;

    // Login callbacks can replace the session while native state is being read.
    // Check persistence again immediately before the mutation.
    const latestPersisted = await getPersistedDriverAuthTokens();
    if (
      !shouldRestoreNativeAuthorization(authorization.accessToken, latestPersisted?.accessToken)
      && !needsNativeSessionHydration(authorization, latestPersisted)
    ) {
      resetNativeAuthRecoveryBackoff();
      return false;
    }
    if (restoreGeneration !== restoreAuthorizationGeneration) return false;

    // Native upload may have rotated the refresh token while the WebView was suspended.
    const { data, error } = await client.auth.setSession({
      access_token: authorization.accessToken,
      refresh_token: authorization.refreshToken,
    });
    if (error) {
      if (isPermanentDriverAuthFailure(error)) {
        invalidateNativeResidentLocationSessionRestore();
        restoredAuthorizationUpdatedAt = authorization.updatedAt || Date.now();
        resetNativeAuthRecoveryBackoff();
        await clearPersistedDriverAuthSession();
        try {
          await ResidentLocation.blockAuthorization();
        } catch (blockError) {
          console.warn('[resident-location] invalid native authorization could not be quarantined', blockError);
        }
        const { data: current } = await client.auth.getSession();
        if (current.session) {
          const { error: signOutError } = await client.auth.signOut({ scope: 'local' });
          if (signOutError) {
            console.warn('[resident-location] invalid WebView session cleanup failed', signOutError);
          }
        }
      } else {
        deferNativeAuthRecovery(error);
      }
      throw error;
    }
    if (restoreGeneration !== restoreAuthorizationGeneration) {
      const restoredAccessToken = data.session?.access_token ?? authorization.accessToken;
      const { data: current } = await client.auth.getSession();
      const restoredSessionId = getJwtSessionId(restoredAccessToken);
      const currentSessionId = getJwtSessionId(current.session?.access_token ?? '');
      const sameRestoredSession = restoredSessionId && currentSessionId
        ? restoredSessionId === currentSessionId
        : current.session?.access_token === restoredAccessToken;
      if (sameRestoredSession) {
        // Remove mirrored storage first. signOut can otherwise return early on
        // a revoke-network error and leave this stale session persisted.
        await clearPersistedDriverAuthSession();
        const { error: signOutError } = await client.auth.signOut({ scope: 'local' });
        if (signOutError) {
          console.warn('[resident-location] stale restored session notification failed', signOutError);
        }
      }
      return false;
    }
    restoredAuthorizationUpdatedAt = authorization.updatedAt || Date.now();
    resetNativeAuthRecoveryBackoff();
    return true;
  });

  try {
    return await restoreAuthorizationInFlight;
  } finally {
    restoreAuthorizationInFlight = null;
    restoreAuthorizationForceInFlight = false;
  }
}

export function invalidateNativeResidentLocationSessionRestore(): void {
  restoreAuthorizationGeneration += 1;
  resetNativeAuthRecoveryBackoff();
  resetNativeAuthorizationVerificationBackoff();
}

export type NativeResidentLocationStopReason =
  | 'manual'
  | 'trip-ended'
  | 'permission-denied'
  | 'approval-rejected'
  | 'signed-out';

export function buildNativeResidentLocationStopRequest(reason: NativeResidentLocationStopReason) {
  const clearAuthorization = reason === 'permission-denied'
    || reason === 'approval-rejected'
    || reason === 'signed-out';
  return {
    clearAuthorization,
    clearActiveTrip: true,
    // A permission/setup interruption may recover. Only explicit sign-out is
    // authorized to remove the private native detector snapshot and queue.
    clearExpresswayData: reason === 'signed-out',
  };
}

export async function stopNativeResidentLocation(options: {
  reason: NativeResidentLocationStopReason;
}): Promise<NativeResidentLocationStatus> {
  if (!isAndroidNative()) return EMPTY_STATUS;
  if (options.reason === 'signed-out') {
    invalidateNativeResidentLocationSessionRestore();
  }
  if (options.reason === 'manual') return ResidentLocation.getStatus();
  trackingStateCoordinator.advanceGeneration();
  return trackingStateCoordinator.enqueueCommit(
    () => ResidentLocation.stop(buildNativeResidentLocationStopRequest(options.reason)),
  );
}

export async function getNativeResidentLocationStatus(): Promise<NativeResidentLocationStatus> {
  if (!isAndroidNative()) return EMPTY_STATUS;
  return ResidentLocation.getStatus();
}

export async function peekNativeResidentLocationPoints(limit = 500): Promise<{
  points: NativeResidentLocationPoint[];
  remaining: number;
}> {
  if (!isAndroidNative()) return { points: [], remaining: 0 };
  return ResidentLocation.peek({ limit: Math.max(1, Math.min(Math.trunc(limit), 5000)) });
}

export async function acknowledgeNativeResidentLocationPoints(ids: string[]): Promise<{ remaining: number }> {
  if (!isAndroidNative()) return { remaining: 0 };
  return ResidentLocation.acknowledge({
    ids: [...new Set(ids.map(id => id.trim()).filter(Boolean))],
  });
}

export async function peekNativeResidentExpresswayEvents(limit = 100): Promise<{
  events: NativeResidentExpresswayEvent[];
  remaining: number;
}> {
  if (!isAndroidNative()) return { events: [], remaining: 0 };
  return ResidentLocation.peekExpresswayEvents({
    limit: Math.max(1, Math.min(Math.trunc(limit), 1_000)),
  });
}

export async function acknowledgeNativeResidentExpresswayEvents(
  ids: string[],
): Promise<{ remaining: number }> {
  if (!isAndroidNative()) return { remaining: 0 };
  return ResidentLocation.acknowledgeExpresswayEvents({
    ids: [...new Set(ids.map(id => id.trim()).filter(Boolean))],
  });
}

export type NativeResidentExpresswayPromptResolution = {
  stored: true;
  eventId: string;
  generation: number;
};

export async function resolveNativeResidentExpresswayPrompt(options: {
  promptId: string;
  action: 'end' | 'keep';
}): Promise<NativeResidentExpresswayPromptResolution> {
  if (!isAndroidNative()) throw new Error('Android高速判定を利用できません');
  const promptId = options.promptId.trim();
  if (!promptId) throw new Error('高速終了確認IDが不正です');
  const result = await ResidentLocation.resolveExpresswayPrompt({
    promptId,
    action: options.action,
  });
  const eventId = typeof result?.eventId === 'string' ? result.eventId.trim() : '';
  const generation = Number(result?.generation);
  if (result?.stored !== true || !eventId || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('Android高速判定の保存結果が不正です');
  }
  return { stored: true, eventId, generation };
}
