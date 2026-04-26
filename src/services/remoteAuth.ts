import { Capacitor } from '@capacitor/core';
import { APP_VERSION } from '../app/version';
import { requestImmediateRemoteSync } from '../app/remoteSyncSignal';
import { db } from '../db/db';
import type { AdminSession, DriverIdentity } from '../domain/remoteTypes';
import { getStableDeviceKey } from './deviceIdentity';
import { adminSupabase, DEFAULT_ADMIN_EMAIL, driverSupabase, SUPABASE_CONFIGURED } from './supabase';

const META_DEVICE_ID = 'device_id';
const META_DEVICE_DISPLAY_NAME = 'device_display_name';
const META_DEVICE_VEHICLE_LABEL = 'device_vehicle_label';
const META_REMOTE_LAST_SYNC_AT = 'remote_last_sync_at';
const META_REMOTE_AUTH_INITIALIZED = 'remote_auth_initialized';
const NATIVE_ADMIN_REDIRECT = 'com.tracklog.assist://auth?next=%2Fadmin';

function nowIso() {
  return new Date().toISOString();
}

async function getMeta(key: string): Promise<string | null> {
  const row = await db.meta.get(key);
  return row?.value ?? null;
}

async function setMeta(key: string, value: string | null): Promise<void> {
  if (value == null || value === '') {
    await db.meta.delete(key);
    return;
  }
  await db.meta.put({
    key,
    value,
    updatedAt: nowIso(),
  });
}

function buildDefaultDisplayName(deviceId: string) {
  const suffix = deviceId.replace(/[^a-z0-9]/gi, '').slice(-8).toUpperCase();
  const platform = Capacitor.getPlatform();
  return `${platform.toUpperCase()}-${suffix}`;
}

export function isDriverProfileComplete(input: { displayName?: string | null; vehicleLabel?: string | null }) {
  return !!input.displayName?.trim() && !!input.vehicleLabel?.trim();
}

function isLegacyAnonymousDeviceId(deviceId?: string | null) {
  return !!deviceId?.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
}

async function claimTracklogDeviceProfile(input: {
  deviceId: string;
  displayName?: string | null;
  vehicleLabel?: string | null;
  latestStatus?: string | null;
  latestTripId?: string | null;
  latestLat?: number | null;
  latestLng?: number | null;
  latestAccuracy?: number | null;
}) {
  if (!driverSupabase) return null;
  const { data, error } = await driverSupabase.rpc('claim_tracklog_device_profile', {
    _device_id: input.deviceId,
    _display_name: input.displayName?.trim() || null,
    _vehicle_label: input.vehicleLabel?.trim() || null,
    _platform: Capacitor.getPlatform(),
    _app_version: APP_VERSION,
    _latest_status: input.latestStatus ?? null,
    _latest_trip_id: input.latestTripId ?? null,
    _latest_lat: input.latestLat ?? null,
    _latest_lng: input.latestLng ?? null,
    _latest_accuracy: input.latestAccuracy ?? null,
    _last_seen_at: nowIso(),
  });
  if (error) throw error;
  return (Array.isArray(data) ? data[0] : data) as
    | {
        device_id: string;
        display_name: string;
        vehicle_label: string | null;
      }
    | null;
}

export async function getDriverIdentity(): Promise<DriverIdentity> {
  const [deviceId, displayName, vehicleLabel, authInitialized] = await Promise.all([
    getMeta(META_DEVICE_ID),
    getMeta(META_DEVICE_DISPLAY_NAME),
    getMeta(META_DEVICE_VEHICLE_LABEL),
    getMeta(META_REMOTE_AUTH_INITIALIZED),
  ]);
  return {
    configured: SUPABASE_CONFIGURED,
    deviceId,
    displayName: displayName?.trim() || (deviceId ? buildDefaultDisplayName(deviceId) : ''),
    vehicleLabel: vehicleLabel?.trim() || '',
    authInitialized: authInitialized === 'true',
    profileComplete: isDriverProfileComplete({ displayName, vehicleLabel }),
  };
}

export async function initializeDriverIdentity(): Promise<DriverIdentity> {
  if (!SUPABASE_CONFIGURED || !driverSupabase) {
    return getDriverIdentity();
  }

  let session = (await driverSupabase.auth.getSession()).data.session;
  if (!session) {
    const { data, error } = await driverSupabase.auth.signInAnonymously();
    if (error) throw error;
    session = data.session;
  }

  const user = session?.user;
  if (!user) {
    throw new Error('匿名ログインの初期化に失敗しました');
  }

  const [savedDisplayName, savedVehicleLabel, currentDeviceId, stableKey] = await Promise.all([
    getMeta(META_DEVICE_DISPLAY_NAME),
    getMeta(META_DEVICE_VEHICLE_LABEL),
    getMeta(META_DEVICE_ID),
    getStableDeviceKey(),
  ]);
  const deviceId = stableKey.stableDeviceKey;
  if (driverSupabase && currentDeviceId && currentDeviceId !== deviceId && isLegacyAnonymousDeviceId(currentDeviceId)) {
    const { error } = await driverSupabase.rpc('migrate_tracklog_device_records', {
      _old_device_id: currentDeviceId,
      _new_device_id: deviceId,
    });
    if (error) throw error;
  }
  const claimedProfile = await claimTracklogDeviceProfile({
    deviceId,
    displayName: savedDisplayName,
    vehicleLabel: savedVehicleLabel,
  });
  const displayName = claimedProfile?.display_name?.trim() || savedDisplayName?.trim() || buildDefaultDisplayName(deviceId);
  const vehicleLabel = claimedProfile?.vehicle_label?.trim() || savedVehicleLabel?.trim() || '';

  await Promise.all([
    setMeta(META_DEVICE_ID, deviceId),
    setMeta(META_DEVICE_DISPLAY_NAME, displayName),
    setMeta(META_DEVICE_VEHICLE_LABEL, vehicleLabel || null),
    setMeta(META_REMOTE_AUTH_INITIALIZED, 'true'),
  ]);

  return {
    configured: true,
    deviceId,
    displayName,
    vehicleLabel,
    authInitialized: true,
    profileComplete: isDriverProfileComplete({ displayName, vehicleLabel }),
  };
}

export async function setDriverProfileLocal(input: {
  displayName: string;
  vehicleLabel?: string;
}) {
  const trimmedDisplayName = input.displayName.trim();
  if (!trimmedDisplayName) {
    throw new Error('表示名を入力してください');
  }
  const trimmedVehicleLabel = input.vehicleLabel?.trim() ?? '';
  if (!trimmedVehicleLabel) {
    throw new Error('車番・識別名を入力してください');
  }
  await Promise.all([
    setMeta(META_DEVICE_DISPLAY_NAME, trimmedDisplayName),
    setMeta(META_DEVICE_VEHICLE_LABEL, trimmedVehicleLabel),
  ]);
  requestImmediateRemoteSync('profile-save');
}

export async function getRemoteSyncEnabled(): Promise<boolean> {
  return true;
}

export async function setRemoteSyncEnabled(enabled: boolean): Promise<void> {
  if (!enabled) {
    throw new Error('クラウド同期は常時有効です');
  }
}

export async function getRemoteLastSyncAt(): Promise<string | null> {
  return getMeta(META_REMOTE_LAST_SYNC_AT);
}

export async function setRemoteLastSyncAt(ts: string | null): Promise<void> {
  await setMeta(META_REMOTE_LAST_SYNC_AT, ts);
}

export function getDefaultAdminEmail() {
  return DEFAULT_ADMIN_EMAIL;
}

export { claimTracklogDeviceProfile };

export function getAdminRedirectUrl(override?: string) {
  if (override?.trim()) return override.trim();
  if (Capacitor.isNativePlatform()) return NATIVE_ADMIN_REDIRECT;
  return `${window.location.origin}/admin`;
}

export async function getAdminSession(): Promise<AdminSession> {
  if (!SUPABASE_CONFIGURED || !adminSupabase) {
    return {
      configured: false,
      authenticated: false,
      email: null,
    };
  }
  const { data } = await adminSupabase.auth.getSession();
  const session = data.session;
  return {
    configured: true,
    authenticated: !!session?.user,
    email: session?.user?.email ?? null,
  };
}

export async function sendAdminMagicLink(email: string, redirectTo?: string): Promise<void> {
  if (!SUPABASE_CONFIGURED || !adminSupabase) {
    throw new Error('Supabase が未設定です');
  }
  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    throw new Error('メールアドレスを入力してください');
  }
  const { error } = await adminSupabase.auth.signInWithOtp({
    email: normalized,
    options: { emailRedirectTo: getAdminRedirectUrl(redirectTo) },
  });
  if (error) throw error;
}

export async function getAdminGoogleSignInUrl(redirectTo?: string): Promise<string> {
  if (!SUPABASE_CONFIGURED || !adminSupabase) {
    throw new Error('Supabase が未設定です');
  }
  const { data, error } = await adminSupabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: getAdminRedirectUrl(redirectTo),
      queryParams: {
        access_type: 'offline',
        prompt: 'select_account',
      },
      skipBrowserRedirect: true,
    },
  });
  if (error) throw error;
  if (!data.url) throw new Error('GoogleログインURLの取得に失敗しました');
  return data.url;
}

export async function signOutAdmin(): Promise<void> {
  if (!adminSupabase) return;
  const { error } = await adminSupabase.auth.signOut();
  if (error) throw error;
}

export function onAdminAuthStateChange(callback: () => void) {
  if (!adminSupabase) return () => undefined;
  const { data } = adminSupabase.auth.onAuthStateChange(() => {
    callback();
  });
  return () => {
    data.subscription.unsubscribe();
  };
}

function parseAuthCallbackUrl(url: string) {
  const parsed = new URL(url);
  const query = new URLSearchParams(parsed.search);
  const hash = new URLSearchParams(parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash);
  const accessToken = hash.get('access_token') ?? query.get('access_token');
  const refreshToken = hash.get('refresh_token') ?? query.get('refresh_token');
  const errorCode = hash.get('error_code') ?? query.get('error_code');
  const errorDescription = hash.get('error_description') ?? query.get('error_description');
  const nextPath = query.get('next') || '/admin';
  return {
    scheme: parsed.protocol,
    host: parsed.host,
    accessToken,
    refreshToken,
    errorCode,
    errorDescription,
    nextPath,
  };
}

export async function handleAdminAuthCallbackUrl(url: string): Promise<{
  handled: boolean;
  nextPath?: string;
}> {
  if (!SUPABASE_CONFIGURED || !adminSupabase) {
    throw new Error('Supabase が未設定です');
  }
  const parsed = parseAuthCallbackUrl(url);
  if (parsed.scheme !== 'com.tracklog.assist:' || parsed.host !== 'auth') {
    return { handled: false };
  }
  if (parsed.errorCode) {
    throw new Error(parsed.errorDescription || parsed.errorCode);
  }
  if (!parsed.accessToken || !parsed.refreshToken) {
    return {
      handled: true,
      nextPath: parsed.nextPath,
    };
  }
  const { error } = await adminSupabase.auth.setSession({
    access_token: parsed.accessToken,
    refresh_token: parsed.refreshToken,
  });
  if (error) throw error;
  return {
    handled: true,
    nextPath: parsed.nextPath,
  };
}
