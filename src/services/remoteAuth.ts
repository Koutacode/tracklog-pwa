import { Capacitor } from '@capacitor/core';
import { APP_VERSION } from '../app/version';
import { requestImmediateRemoteSync } from '../app/remoteSyncSignal';
import { db } from '../db/db';
import type { AdminSession, DriverIdentity } from '../domain/remoteTypes';
import { getStableDeviceKey } from './deviceIdentity';
import { adminSupabase, driverSupabase, SUPABASE_CONFIGURED } from './supabase';

const META_DEVICE_ID = 'device_id';
const META_DEVICE_DISPLAY_NAME = 'device_display_name';
const META_DEVICE_VEHICLE_LABEL = 'vehicle_label';
const META_DRIVER_PHONE = 'driver_phone';
const META_DRIVER_EMAIL = 'driver_email';
const META_REMOTE_LAST_SYNC_AT = 'remote_last_sync_at';
const META_REMOTE_AUTH_INITIALIZED = 'remote_auth_initialized';
const NATIVE_ADMIN_REDIRECT = 'com.tracklog.assist://auth?next=%2Fadmin';
const NATIVE_DRIVER_REDIRECT = 'com.tracklog.assist://auth?next=%2Fsettings';

type DriverProfileSeed = {
  displayName: string;
  vehicleLabel: string;
  driverPhone: string;
  driverEmail: string;
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value: string | null | undefined) {
  return value?.trim() ?? '';
}

function normalizeEmail(value: string | null | undefined) {
  return normalizeText(value).toLowerCase();
}

function getUserMetaText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function getDriverDisplayNameFallback(user: {
  user_metadata?: Record<string, unknown> | null;
  email?: string | null;
}) {
  return (
    getUserMetaText(user.user_metadata?.full_name) ||
    getUserMetaText(user.user_metadata?.name) ||
    getUserMetaText(user.user_metadata?.display_name) ||
    normalizeText(user.email?.split('@')[0])
  );
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

export function isDriverProfileComplete(input: {
  displayName?: string | null;
  vehicleLabel?: string | null;
  email?: string | null;
  phone?: string | null;
  requireContactInfo?: boolean;
}) {
  const displayName = normalizeText(input.displayName);
  const vehicleLabel = normalizeText(input.vehicleLabel);
  const email = normalizeText(input.email);
  const phone = normalizeText(input.phone);
  if (!input.requireContactInfo) {
    return displayName.length > 0 && vehicleLabel.length > 0;
  }
  return displayName.length > 0 && vehicleLabel.length > 0 && phone.length > 0 && email.length > 0;
}

function isLegacyAnonymousDeviceId(deviceId?: string | null) {
  return !!deviceId?.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
}

async function claimTracklogDeviceProfile(input: {
  deviceId: string;
  displayName?: string | null;
  vehicleLabel?: string | null;
  driverPhone?: string | null;
  driverEmail?: string | null;
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
    _driver_phone: input.driverPhone?.trim() || null,
    _driver_email: input.driverEmail?.trim() || null,
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
        driver_phone: string | null;
        driver_email: string | null;
      }
    | null;
}

async function getCurrentCloudProfile(userId: string): Promise<DriverProfileSeed | null> {
  if (!driverSupabase) return null;
  const { data, error } = await driverSupabase
    .from('device_profiles')
    .select('display_name, vehicle_label, driver_phone, driver_email')
    .eq('auth_user_id', userId)
    .order('last_seen_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) {
    return null;
  }
  return {
    displayName: normalizeText(data.display_name),
    vehicleLabel: normalizeText(data.vehicle_label),
    driverPhone: normalizeText(data.driver_phone),
    driverEmail: normalizeText(data.driver_email),
  };
}

export async function getDriverIdentity(): Promise<DriverIdentity> {
  const { stableDeviceKey } = await getStableDeviceKey();
  const [displayName, vehicleLabel, driverPhone, localEmail] = await Promise.all([
    getMeta(META_DEVICE_DISPLAY_NAME),
    getMeta(META_DEVICE_VEHICLE_LABEL),
    getMeta(META_DRIVER_PHONE),
    getMeta(META_DRIVER_EMAIL),
  ]);

  const profile = await getProfileIdentity();
  const finalPhone = normalizeText(driverPhone) || normalizeText(profile?.phone);
  const email = normalizeText(profile?.email) || normalizeText(localEmail) || null;

  return {
    configured: SUPABASE_CONFIGURED,
    deviceId: stableDeviceKey,
    displayName: normalizeText(displayName) || buildDefaultDisplayName(stableDeviceKey),
    vehicleLabel: normalizeText(vehicleLabel),
    phone: finalPhone,
    email,
    authInitialized: !!profile?.email,
    profileComplete: isDriverProfileComplete({
      displayName,
      vehicleLabel,
      email,
      phone: finalPhone,
      requireContactInfo: SUPABASE_CONFIGURED,
    }),
  };
}

async function getProfileIdentity() {
  if (!SUPABASE_CONFIGURED || !driverSupabase) return null;
  const session = (await driverSupabase.auth.getSession()).data.session;
  if (!session?.user) return null;
  return {
    email: normalizeText(session.user.email),
    phone: normalizeText(session.user.phone),
  };
}

export async function initializeDriverIdentity(): Promise<DriverIdentity> {
  if (!SUPABASE_CONFIGURED || !driverSupabase) {
    return getDriverIdentity();
  }

  const session = (await driverSupabase.auth.getSession()).data.session;
  const { stableDeviceKey } = await getStableDeviceKey();

  if (!session) {
    const [savedDisplayName, savedVehicleLabel, localPhone, localEmail] = await Promise.all([
      getMeta(META_DEVICE_DISPLAY_NAME),
      getMeta(META_DEVICE_VEHICLE_LABEL),
      getMeta(META_DRIVER_PHONE),
      getMeta(META_DRIVER_EMAIL),
      setMeta(META_DEVICE_ID, stableDeviceKey),
    ]);
    const displayName = normalizeText(savedDisplayName) || buildDefaultDisplayName(stableDeviceKey);
    const vehicleLabel = normalizeText(savedVehicleLabel);
    const phone = normalizeText(localPhone);
    const email = normalizeEmail(localEmail);
    return {
      configured: true,
      deviceId: stableDeviceKey,
      displayName,
      vehicleLabel,
      phone,
      email,
      authInitialized: false,
      profileComplete: isDriverProfileComplete({
        displayName,
        vehicleLabel,
        email,
        phone,
        requireContactInfo: true,
      }),
    };
  }

  const user = session.user;
  if (!user) {
    throw new Error('ユーザー情報の初期化に失敗しました');
  }

  const [savedDisplayName, savedVehicleLabel, currentDeviceId, savedDriverPhone, savedDriverEmail] = await Promise.all([
    getMeta(META_DEVICE_DISPLAY_NAME),
    getMeta(META_DEVICE_VEHICLE_LABEL),
    getMeta(META_DEVICE_ID),
    getMeta(META_DRIVER_PHONE),
    getMeta(META_DRIVER_EMAIL),
  ]);
  const cloudProfile = await getCurrentCloudProfile(user.id);
  const deviceId = stableDeviceKey;
  if (currentDeviceId && currentDeviceId !== deviceId && isLegacyAnonymousDeviceId(currentDeviceId)) {
    const { error } = await driverSupabase.rpc('migrate_tracklog_device_records', {
      _old_device_id: currentDeviceId,
      _new_device_id: deviceId,
    });
    if (error) throw error;
  }

  const mergedDisplayName = normalizeText(savedDisplayName) || cloudProfile?.displayName || getDriverDisplayNameFallback(user) || '';
  const mergedVehicleLabel = normalizeText(savedVehicleLabel) || cloudProfile?.vehicleLabel || '';
  const mergedDriverPhone =
    normalizeText(savedDriverPhone) || cloudProfile?.driverPhone || normalizeText(user.phone) || '';
  const mergedDriverEmail = normalizeText(savedDriverEmail) || cloudProfile?.driverEmail || normalizeText(user.email) || '';

  const claimedProfile = await claimTracklogDeviceProfile({
    deviceId,
    displayName: mergedDisplayName,
    vehicleLabel: mergedVehicleLabel,
    driverPhone: mergedDriverPhone,
    driverEmail: mergedDriverEmail,
  });
  const displayName = claimedProfile?.display_name?.trim() || mergedDisplayName || buildDefaultDisplayName(deviceId);
  const vehicleLabel = claimedProfile?.vehicle_label?.trim() || mergedVehicleLabel || '';
  const driverPhone = claimedProfile?.driver_phone?.trim() || mergedDriverPhone || '';
  const driverEmail = claimedProfile?.driver_email?.trim() || mergedDriverEmail || '';

  await Promise.all([
    setMeta(META_DEVICE_ID, deviceId),
    setMeta(META_DEVICE_DISPLAY_NAME, displayName),
    setMeta(META_DEVICE_VEHICLE_LABEL, vehicleLabel),
    setMeta(META_DRIVER_PHONE, driverPhone || null),
    setMeta(META_DRIVER_EMAIL, driverEmail || null),
    setMeta(META_REMOTE_AUTH_INITIALIZED, 'true'),
  ]);

  return {
    configured: true,
    deviceId,
    displayName,
    vehicleLabel,
    phone: driverPhone,
    email: driverEmail || null,
    authInitialized: true,
    profileComplete: isDriverProfileComplete({
      displayName,
      vehicleLabel,
      email: driverEmail || normalizeText(user.email),
      phone: driverPhone,
      requireContactInfo: true,
    }),
  };
}

export async function setDriverProfileLocal(input: {
  displayName: string;
  vehicleLabel?: string;
  phone?: string;
  email?: string;
}) {
  const trimmedDisplayName = input.displayName.trim();
  if (!trimmedDisplayName) {
    throw new Error('表示名を入力してください');
  }
  const trimmedVehicleLabel = input.vehicleLabel?.trim() ?? '';
  if (!trimmedVehicleLabel) {
    throw new Error('車番・識別名を入力してください');
  }
  const trimmedPhone = input.phone?.trim() ?? '';
  const trimmedEmail = normalizeEmail(input.email);
  if (!trimmedPhone) {
    throw new Error('電話番号を入力してください');
  }
  if (!trimmedEmail) {
    throw new Error('メールアドレスを入力してください');
  }

  const [
    confirmed,
    savedEmail,
    sessionProfile,
    savedDisplayName,
    savedVehicleLabel,
    savedDriverPhone,
  ] = await Promise.all([
    getMeta(META_REMOTE_AUTH_INITIALIZED),
    getMeta(META_DRIVER_EMAIL),
    getProfileIdentity(),
    getMeta(META_DEVICE_DISPLAY_NAME),
    getMeta(META_DEVICE_VEHICLE_LABEL),
    getMeta(META_DRIVER_PHONE),
  ]);
  const lockedEmail = normalizeEmail(sessionProfile?.email) || (confirmed === 'true' ? normalizeEmail(savedEmail) : '');
  if (lockedEmail && trimmedEmail !== lockedEmail) {
    throw new Error(`この端末は ${lockedEmail} のアカウントに紐づいています。別メールで使う場合は管理者に切替を依頼してください。`);
  }

  const profileLocked =
    confirmed === 'true' &&
    isDriverProfileComplete({
      displayName: savedDisplayName,
      vehicleLabel: savedVehicleLabel,
      email: lockedEmail || savedEmail,
      phone: savedDriverPhone,
      requireContactInfo: true,
    });
  if (
    profileLocked &&
    (trimmedDisplayName !== normalizeText(savedDisplayName) ||
      trimmedVehicleLabel !== normalizeText(savedVehicleLabel) ||
      trimmedPhone !== normalizeText(savedDriverPhone))
  ) {
    throw new Error('登録済みの端末プロフィールは変更できません。変更が必要な場合は管理者に依頼してください。');
  }

  await Promise.all([
    setMeta(META_DEVICE_DISPLAY_NAME, trimmedDisplayName),
    setMeta(META_DEVICE_VEHICLE_LABEL, trimmedVehicleLabel),
    setMeta(META_DRIVER_PHONE, trimmedPhone),
    setMeta(META_DRIVER_EMAIL, trimmedEmail),
  ]);

  const identity = await getDriverIdentity();
  if (identity.configured && identity.authInitialized && identity.deviceId) {
    await claimTracklogDeviceProfile({
      deviceId: identity.deviceId,
      displayName: trimmedDisplayName,
      vehicleLabel: trimmedVehicleLabel,
      driverPhone: trimmedPhone,
      driverEmail: trimmedEmail,
    });
  }
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

export { claimTracklogDeviceProfile };

export function getAdminRedirectUrl(override?: string) {
  if (override?.trim()) return override.trim();
  if (Capacitor.isNativePlatform()) return NATIVE_ADMIN_REDIRECT;
  return `${window.location.origin}/admin`;
}

export function getDriverRedirectUrl(override?: string) {
  if (override?.trim()) return override.trim();
  if (Capacitor.isNativePlatform()) return NATIVE_DRIVER_REDIRECT;
  return `${window.location.origin}/settings`;
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

export async function sendDriverMagicLink(email: string, redirectTo?: string): Promise<void> {
  if (!SUPABASE_CONFIGURED || !driverSupabase) {
    throw new Error('Supabase が未設定です');
  }
  const normalized = normalizeEmail(email);
  if (!normalized) {
    throw new Error('メールアドレスを入力してください');
  }
  const [confirmed, savedEmail] = await Promise.all([
    getMeta(META_REMOTE_AUTH_INITIALIZED),
    getMeta(META_DRIVER_EMAIL),
  ]);
  const lockedEmail = confirmed === 'true' ? normalizeEmail(savedEmail) : '';
  if (lockedEmail && normalized !== lockedEmail) {
    throw new Error(`この端末は ${lockedEmail} のアカウントに紐づいています。同じメールで再認証してください。`);
  }
  const { error } = await driverSupabase.auth.signInWithOtp({
    email: normalized,
    options: {
      emailRedirectTo: getDriverRedirectUrl(redirectTo),
      shouldCreateUser: !lockedEmail,
    },
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

export function onDriverAuthStateChange(callback: () => void) {
  if (!driverSupabase) return () => undefined;
  const { data } = driverSupabase.auth.onAuthStateChange(() => {
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
  const nextRaw = query.get('next') || '/settings';
  let nextPath = '/settings';
  try {
    nextPath = decodeURIComponent(nextRaw);
  } catch {
    nextPath = nextRaw;
  }
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
  if (parsed.scheme !== 'com.tracklog.assist:' || parsed.host !== 'auth' || !parsed.nextPath.startsWith('/admin')) {
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

export async function handleDriverAuthCallbackUrl(url: string): Promise<{
  handled: boolean;
  nextPath?: string;
}> {
  if (!SUPABASE_CONFIGURED || !driverSupabase) {
    throw new Error('Supabase が未設定です');
  }
  const parsed = parseAuthCallbackUrl(url);
  if (parsed.scheme !== 'com.tracklog.assist:' || parsed.host !== 'auth' || parsed.nextPath.startsWith('/admin')) {
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
  const { error } = await driverSupabase.auth.setSession({
    access_token: parsed.accessToken,
    refresh_token: parsed.refreshToken,
  });
  if (error) throw error;
  const session = (await driverSupabase.auth.getSession()).data.session;
  const email = normalizeEmail(session?.user?.email);
  await Promise.all([
    setMeta(META_REMOTE_AUTH_INITIALIZED, 'true'),
    email ? setMeta(META_DRIVER_EMAIL, email) : Promise.resolve(),
  ]);
  return {
    handled: true,
    nextPath: parsed.nextPath,
  };
}
