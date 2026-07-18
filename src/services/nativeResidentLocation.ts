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
  getJwtSessionId,
  shouldInstallWebAuthorizationIntoNative,
  shouldRestoreNativeAuthorization,
} from './nativeResidentSessionPolicy';
import {
  ResidentLocation,
  type NativeResidentLocationPoint,
  type NativeResidentLocationSettings,
  type NativeResidentLocationStatus,
} from './residentLocationBridge';

export type {
  NativeResidentLocationAuthorization,
  NativeResidentLocationPoint,
  NativeResidentLocationSettings,
  NativeResidentLocationStatus,
} from './residentLocationBridge';

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
  authorizationConfigured: false,
  authorizationBlocked: false,
  lastUploadAt: 0,
  settings: EMPTY_SETTINGS,
};

const SUPABASE_URL = (import.meta.env?.VITE_SUPABASE_URL ?? '').trim();
const SUPABASE_ANON_KEY = (import.meta.env?.VITE_SUPABASE_ANON_KEY ?? '').trim();
let restoredAuthorizationUpdatedAt = 0;
let restoreAuthorizationInFlight: Promise<boolean> | null = null;
let restoreAuthorizationForceInFlight = false;
let restoreAuthorizationGeneration = 0;

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
}): Promise<NativeResidentLocationStatus> {
  if (!isAndroidNative()) return EMPTY_STATUS;
  const authIntent = getDriverAuthIntentGeneration();
  if (!isResidentAuthIntentCurrent(authIntent)) return ResidentLocation.getStatus();
  const client = driverAuthSupabase;
  await restoreNativeResidentLocationSession();
  if (!isResidentAuthIntentCurrent(authIntent)) return ResidentLocation.getStatus();
  const { data, error } = client
    ? await client.auth.getSession()
    : { data: { session: null }, error: null };
  if (error) throw error;
  if (!isResidentAuthIntentCurrent(authIntent)) return ResidentLocation.getStatus();
  const session = data.session;
  if (session && client) {
    const nativeAuthorization = await ResidentLocation.getAuthorization();
    if (!isResidentAuthIntentCurrent(authIntent)) return ResidentLocation.getStatus();
    const shouldInstall = shouldInstallWebAuthorizationIntoNative({
      nativeConfigured: nativeAuthorization.configured,
      nativeAccessToken: nativeAuthorization.accessToken,
      nativeRefreshToken: nativeAuthorization.refreshToken,
      webAccessToken: session.access_token,
      webRefreshToken: session.refresh_token,
    });
    if (shouldInstall) {
      const { data: verified, error: verificationError } = await client.auth.getUser();
      if (!verificationError && verified.user) {
        await installNativeResidentLocationAuthorization(authIntent);
      } else if (verificationError) {
        console.warn('[resident-location] newer WebView authorization was not installed', verificationError);
      }
    }
  }
  if (!isResidentAuthIntentCurrent(authIntent)) return ResidentLocation.getStatus();
  const routePauseAtMs = Date.parse(options.routePauseAt ?? '');
  return ResidentLocation.reconcile({
    approved: options.approved,
    setupComplete: options.setupComplete,
    activeTripId: options.activeTripId?.trim() ?? '',
    routePauseAtMs: Number.isFinite(routePauseAtMs) ? routePauseAtMs : 0,
  });
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
  await ResidentLocation.installAuthorization({
    supabaseUrl: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    deviceId: stableDeviceKey,
  });
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
}

export async function stopNativeResidentLocation(options: {
  reason: 'manual' | 'trip-ended' | 'permission-denied' | 'approval-rejected' | 'signed-out';
}): Promise<NativeResidentLocationStatus> {
  if (!isAndroidNative()) return EMPTY_STATUS;
  if (options.reason === 'signed-out') {
    invalidateNativeResidentLocationSessionRestore();
  }
  if (options.reason === 'manual') return ResidentLocation.getStatus();
  const clearsAuthorization =
    options.reason === 'permission-denied'
    || options.reason === 'approval-rejected'
    || options.reason === 'signed-out';
  return ResidentLocation.stop({
    clearAuthorization: clearsAuthorization,
    clearActiveTrip: true,
  });
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
