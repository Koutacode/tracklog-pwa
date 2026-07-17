import { Capacitor, registerPlugin } from '@capacitor/core';
import { getStableDeviceKey } from './deviceIdentity';
import {
  clearPersistedDriverAuthSession,
  driverSupabase,
  getPersistedDriverAuthTokens,
  SUPABASE_CONFIGURED,
} from './supabase';
import { getJwtSessionId, shouldRestoreNativeAuthorization } from './nativeResidentSessionPolicy';

export type NativeResidentLocationPoint = {
  id: string;
  tripId: string;
  ts: string;
  lat: number;
  lng: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  source: 'background';
  provider: string | null;
};

export type NativeResidentLocationSettings = {
  foregroundLocation: boolean;
  backgroundLocation: boolean;
  notifications: boolean;
  batteryOptimization: boolean;
  exactAlarm: boolean;
  locationEnabled: boolean;
};

export type NativeResidentLocationStatus = {
  approved: boolean;
  setupComplete: boolean;
  enabled: boolean;
  eligible: boolean;
  ready: boolean;
  running: boolean;
  startRequested: boolean;
  activeTripId: string;
  routePauseAtMs: number;
  queuedPointCount: number;
  authorizationConfigured: boolean;
  authorizationBlocked: boolean;
  lastUploadAt: number;
  settings: NativeResidentLocationSettings;
};

export type NativeResidentLocationAuthorization = {
  configured: boolean;
  accessToken: string;
  refreshToken: string;
  updatedAt: number;
};

type ResidentLocationPlugin = {
  reconcile(options: {
    approved: boolean;
    setupComplete: boolean;
    activeTripId: string;
    routePauseAtMs: number;
    supabaseUrl: string;
    anonKey: string;
    accessToken: string;
    refreshToken: string;
    deviceId: string;
  }): Promise<NativeResidentLocationStatus>;
  stop(options: {
    clearAuthorization: boolean;
    clearActiveTrip: boolean;
  }): Promise<NativeResidentLocationStatus>;
  getStatus(): Promise<NativeResidentLocationStatus>;
  getAuthorization(): Promise<NativeResidentLocationAuthorization>;
  peek(options: { limit: number }): Promise<{
    points: NativeResidentLocationPoint[];
    remaining: number;
  }>;
  acknowledge(options: { ids: string[] }): Promise<{ remaining: number }>;
};

const ResidentLocation = registerPlugin<ResidentLocationPlugin>('ResidentLocation');

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
let restoreAuthorizationGeneration = 0;

function isAndroidNative() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export async function reconcileNativeResidentLocation(options: {
  approved: boolean;
  setupComplete: boolean;
  activeTripId: string | null;
  routePauseAt?: string | null;
}): Promise<NativeResidentLocationStatus> {
  if (!isAndroidNative()) return EMPTY_STATUS;
  await restoreNativeResidentLocationSession();
  const { data, error } = driverSupabase
    ? await driverSupabase.auth.getSession()
    : { data: { session: null }, error: null };
  if (error) throw error;
  const session = data.session;
  const { stableDeviceKey } = await getStableDeviceKey();
  const routePauseAtMs = Date.parse(options.routePauseAt ?? '');
  return ResidentLocation.reconcile({
    approved: options.approved,
    setupComplete: options.setupComplete,
    activeTripId: options.activeTripId?.trim() ?? '',
    routePauseAtMs: Number.isFinite(routePauseAtMs) ? routePauseAtMs : 0,
    supabaseUrl: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY,
    accessToken: session?.access_token ?? '',
    refreshToken: session?.refresh_token ?? '',
    deviceId: stableDeviceKey,
  });
}

export async function restoreNativeResidentLocationSession(): Promise<boolean> {
  if (!isAndroidNative() || !SUPABASE_CONFIGURED || !driverSupabase) return false;
  if (restoreAuthorizationInFlight) return restoreAuthorizationInFlight;

  const restoreGeneration = restoreAuthorizationGeneration;
  restoreAuthorizationInFlight = (async () => {
    const authorization = await ResidentLocation.getAuthorization();
    if (restoreGeneration !== restoreAuthorizationGeneration) return false;
    if (!authorization.configured || !authorization.accessToken || !authorization.refreshToken) return false;
    if (
      restoredAuthorizationUpdatedAt > 0
      && authorization.updatedAt <= restoredAuthorizationUpdatedAt
    ) {
      return false;
    }

    const persisted = await getPersistedDriverAuthTokens();
    if (!shouldRestoreNativeAuthorization(authorization.accessToken, persisted?.accessToken)) {
      restoredAuthorizationUpdatedAt = Math.max(
        restoredAuthorizationUpdatedAt,
        authorization.updatedAt,
      );
      return false;
    }
    if (restoreGeneration !== restoreAuthorizationGeneration) return false;

    // Native upload may have rotated the refresh token while the WebView was suspended.
    const { data, error } = await driverSupabase.auth.setSession({
      access_token: authorization.accessToken,
      refresh_token: authorization.refreshToken,
    });
    if (error) throw error;
    if (restoreGeneration !== restoreAuthorizationGeneration) {
      const restoredAccessToken = data.session?.access_token ?? authorization.accessToken;
      const { data: current } = await driverSupabase.auth.getSession();
      const restoredSessionId = getJwtSessionId(restoredAccessToken);
      const currentSessionId = getJwtSessionId(current.session?.access_token ?? '');
      const sameRestoredSession = restoredSessionId && currentSessionId
        ? restoredSessionId === currentSessionId
        : current.session?.access_token === restoredAccessToken;
      if (sameRestoredSession) {
        // Remove mirrored storage first. signOut can otherwise return early on
        // a revoke-network error and leave this stale session persisted.
        await clearPersistedDriverAuthSession();
        const { error: signOutError } = await driverSupabase.auth.signOut({ scope: 'local' });
        if (signOutError) {
          console.warn('[resident-location] stale restored session notification failed', signOutError);
        }
      }
      return false;
    }
    restoredAuthorizationUpdatedAt = authorization.updatedAt || Date.now();
    return true;
  })();

  try {
    return await restoreAuthorizationInFlight;
  } finally {
    restoreAuthorizationInFlight = null;
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
