import { Capacitor } from '@capacitor/core';
import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js';
import { APP_VERSION } from '../app/version';
import { requestImmediateRemoteSync } from '../app/remoteSyncSignal';
import { db } from '../db/db';
import type { AdminSession, DriverApprovalStatus, DriverIdentity } from '../domain/remoteTypes';
import { getStableDeviceKey } from './deviceIdentity';
import {
  clearPersistedDriverAuthSession,
  clearAuthCodeVerifier,
  adminAccessSupabase,
  adminAccessUsesDriverSession,
  adminSupabase,
  driverAuthSupabase,
  driverSupabase,
  getNativeDriverAdminAccessToken,
  restoreAuthCodeVerifier,
  snapshotAuthCodeVerifier,
  SUPABASE_CONFIGURED,
} from './supabase';
import {
  beginNativeAuthAttempt,
  clearNativeAuthAttempt,
  clearNativeAuthCallbackUrl,
  getNativeAuthAttempt,
  getPendingNativeAuthCallback,
  markNativeAuthCallbackExchangeStarted,
  markNativeAuthCallbackSessionEstablished,
  peekNativeAuthAttemptRecord,
  type NativeAuthAttempt,
  type NativeAuthCallbackIntent,
} from './nativeAuthCallbackPersistence';
import {
  installNativeResidentLocationAuthorization,
  invalidateNativeResidentLocationSessionRestore,
  restoreNativeResidentLocationSession,
  stopNativeResidentLocation,
} from './nativeResidentLocation';
import {
  clearDriverExplicitSignOut,
  isDriverExplicitSignOutRequested,
  markDriverExplicitSignOut,
} from './authStorageKeys';
import { isPermanentDriverAuthFailure as isPermanentDriverAuthFailureDirect } from './driverAuthFailurePolicy';
import {
  beginDriverAuthIntent,
  getDriverAuthIntentGeneration,
  isCurrentDriverAuthIntent,
  withDriverAuthMutation,
} from './driverAuthMutationLock';
import {
  claimTracklogDeviceProfileViaFunction,
  getTracklogAdminAccessStateViaFunction,
  migrateTracklogDeviceRecordsViaFunction,
} from './tracklogPrivilegedApi';
import { classifyAdminValidationFailure, resolveAdminSession } from './adminSessionPolicy';
import {
  assertValidDriverProfile,
  normalizeEmailInput,
  normalizePhoneInput,
  toHalfWidthDigits,
  normalizeVehicleLabelInput,
  sameEmailAddress,
  validateDriverProfile,
} from './driverProfileValidation';
import { ResidentLocation } from './residentLocationBridge';
import { getNativeAuthorizationEmail, resolveNativeStartupIdentity } from '../app/driverIdentityStartup';

const META_DEVICE_ID = 'device_id';
const META_DEVICE_DISPLAY_NAME = 'device_display_name';
const META_DEVICE_VEHICLE_LABEL = 'vehicle_label';
const META_DRIVER_PHONE = 'driver_phone';
const META_DRIVER_EMAIL = 'driver_email';
const META_REMOTE_LAST_SYNC_AT = 'remote_last_sync_at';
const META_REMOTE_AUTH_INITIALIZED = 'remote_auth_initialized';
const META_DRIVER_APPROVAL_STATUS = 'driver_approval_status';
const NATIVE_ADMIN_REDIRECT = 'com.tracklog.assist://auth?next=%2Fadmin';
const NATIVE_DRIVER_REDIRECT = 'com.tracklog.assist://auth?next=%2Fsettings';
const WEB_ADMIN_CALLBACK_PATH = '/auth/admin/callback';
const WEB_DRIVER_CALLBACK_PATH = '/auth/driver/callback';
const EMAIL_OTP_PATTERN = /^\d{6,10}$/;
const EMAIL_OTP_ERROR_MESSAGE = 'メール本文に表示された認証コードをそのまま入力してください';

export type DriverAuthWorkflowErrorCode =
  | 'driver_otp_session_invalid'
  | 'driver_auth_email_mismatch'
  | 'driver_auth_session_refresh_failed'
  | 'driver_enrollment_session_changed'
  | 'driver_native_credentials_update_failed'
  | 'driver_profile_enrollment_failed';

class DriverAuthWorkflowError extends Error {
  readonly code: DriverAuthWorkflowErrorCode;
  readonly cause: unknown;

  constructor(
    name: string,
    code: DriverAuthWorkflowErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = name;
    this.code = code;
    this.cause = cause;
  }
}

export class DriverOtpSessionError extends DriverAuthWorkflowError {
  constructor(cause?: unknown) {
    super(
      'DriverOtpSessionError',
      'driver_otp_session_invalid',
      'メール認証後のセッションを取得できませんでした。最新の認証メールからもう一度お試しください。',
      cause,
    );
  }
}

export class DriverAuthEmailMismatchError extends DriverAuthWorkflowError {
  constructor(lockedEmail?: string) {
    super(
      'DriverAuthEmailMismatchError',
      'driver_auth_email_mismatch',
      lockedEmail
        ? `この端末は ${lockedEmail} のアカウントに紐づいています。同じメールで再認証してください。`
        : '認証したメールアドレスが登録内容と一致しません。登録中のメールアドレスを確認してください。',
    );
  }
}

export class DriverAuthSessionRefreshError extends DriverAuthWorkflowError {
  constructor(cause?: unknown) {
    super(
      'DriverAuthSessionRefreshError',
      'driver_auth_session_refresh_failed',
      'ログイン状態を更新できませんでした。通信状態を確認して、もう一度お試しください。',
      cause,
    );
  }
}

export class DriverEnrollmentSessionChangedError extends DriverAuthWorkflowError {
  constructor() {
    super(
      'DriverEnrollmentSessionChangedError',
      'driver_enrollment_session_changed',
      '認証セッションが更新されたため、端末登録をやり直してください。',
    );
  }
}

export class DriverNativeCredentialUpdateError extends DriverAuthWorkflowError {
  constructor(cause?: unknown) {
    super(
      'DriverNativeCredentialUpdateError',
      'driver_native_credentials_update_failed',
      'メール認証は完了しましたが、端末のバックグラウンド認証情報を保存できませんでした。通信状態を確認して、認証状態を更新してください。',
      cause,
    );
  }
}

export class DriverProfileEnrollmentError extends DriverAuthWorkflowError {
  constructor(cause?: unknown) {
    super(
      'DriverProfileEnrollmentError',
      'driver_profile_enrollment_failed',
      'メール認証は完了しましたが、端末の承認申請を送信できませんでした。通信状態を確認して、承認申請を再送してください。',
      cause,
    );
  }
}

export async function ensureNativeDriverCredentialInstallation(input: {
  required: boolean;
  install: () => Promise<boolean>;
}): Promise<void> {
  if (!input.required) return;
  try {
    if (await input.install()) return;
  } catch (error) {
    if (error instanceof DriverAuthWorkflowError) throw error;
    throw new DriverNativeCredentialUpdateError(error);
  }
  throw new DriverNativeCredentialUpdateError(
    new Error('Native credential installation returned false'),
  );
}

export function getDriverAuthWorkflowErrorCode(error: unknown): DriverAuthWorkflowErrorCode | null {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : null;
  return code === 'driver_otp_session_invalid'
    || code === 'driver_auth_email_mismatch'
    || code === 'driver_auth_session_refresh_failed'
    || code === 'driver_enrollment_session_changed'
    || code === 'driver_native_credentials_update_failed'
    || code === 'driver_profile_enrollment_failed'
    ? code
    : null;
}

export function isPermanentDriverAuthFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 5; depth += 1) {
    if (isPermanentDriverAuthFailureDirect(current)) return true;
    current = typeof current === 'object' && 'cause' in current
      ? (current as { cause?: unknown }).cause
      : null;
  }
  return false;
}

export type NativeAuthStartOptions = {
  restartNativeAttempt?: boolean;
};

export class NativeAuthOperationInProgressError extends Error {
  readonly code = 'native_auth_operation_in_progress';

  constructor() {
    super('ログイン処理中です。完了後にもう一度お試しください。');
    this.name = 'NativeAuthOperationInProgressError';
  }
}

let nativeAuthStartInProgress = false;
let nativeAuthExchangeInProgress = false;

function acquireNativeAuthStartLock() {
  if (nativeAuthStartInProgress || nativeAuthExchangeInProgress) {
    throw new NativeAuthOperationInProgressError();
  }
  nativeAuthStartInProgress = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    nativeAuthStartInProgress = false;
  };
}

function acquireNativeAuthExchangeLock() {
  if (nativeAuthStartInProgress || nativeAuthExchangeInProgress) {
    throw new NativeAuthOperationInProgressError();
  }
  nativeAuthExchangeInProgress = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    nativeAuthExchangeInProgress = false;
  };
}

export type NormalizedNativeAuthNext = {
  nextPath: string;
  role: NativeAuthCallbackIntent;
};

const NATIVE_AUTH_NEXT_ROUTES = new Map<string, NativeAuthCallbackIntent>([
  ['/admin', 'admin'],
  ['/settings', 'driver'],
  ['/', 'driver'],
]);

type DriverProfileSeed = {
  displayName: string;
  vehicleLabel: string;
  driverPhone: string;
  driverEmail: string;
  approvalStatus: DriverApprovalStatus;
};

type ClaimedDeviceProfile = {
  device_id: string;
  display_name: string;
  vehicle_label: string | null;
  driver_phone: string | null;
  driver_email: string | null;
  approval_status: DriverApprovalStatus | null;
  approval_requested_at?: string | null;
  approval_decided_at?: string | null;
};

function nowIso() {
  return new Date().toISOString();
}

function isAndroidNativePlatform() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

function normalizeText(value: string | null | undefined) {
  return value?.trim() ?? '';
}

function normalizeEmail(value: string | null | undefined) {
  return normalizeEmailInput(value);
}

export function validateVerifiedDriverOtpSession(
  session: Session | null,
  expectedEmail: string,
): Session {
  if (!session?.access_token || !session.refresh_token || !session.user) {
    throw new DriverOtpSessionError();
  }
  if (!sameEmailAddress(normalizeEmail(session.user.email), normalizeEmail(expectedEmail))) {
    throw new DriverAuthEmailMismatchError();
  }
  return session;
}

export function selectDriverEnrollmentAccessToken(input: {
  expectedAccessToken?: string | null;
  currentAccessToken: string;
  approvalStatus: DriverApprovalStatus;
}) {
  const expectedAccessToken = input.expectedAccessToken?.trim() || '';
  if (expectedAccessToken && expectedAccessToken !== input.currentAccessToken) {
    throw new DriverEnrollmentSessionChangedError();
  }
  if (
    expectedAccessToken
    || input.approvalStatus === 'unregistered'
    || input.approvalStatus === 'pending'
  ) {
    return expectedAccessToken || input.currentAccessToken;
  }
  return '';
}

function normalizeApprovalStatus(value: string | null | undefined): DriverApprovalStatus {
  if (value === 'pending' || value === 'approved' || value === 'rejected') return value;
  return 'unregistered';
}

function isAppApproved(status: DriverApprovalStatus) {
  return status === 'approved';
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
  return validateDriverProfile({ displayName, vehicleLabel, email, phone }).valid;
}

export function deriveDriverIdentityFromPersistence(input: {
  configured: boolean;
  deviceId: string;
  displayName?: string | null;
  vehicleLabel?: string | null;
  driverPhone?: string | null;
  driverEmail?: string | null;
  remoteAuthInitialized?: string | null;
  approvalStatus?: string | null;
  sessionEmail?: string | null;
  sessionPhone?: string | null;
  allowPersistedAuth?: boolean;
}): DriverIdentity {
  const displayName = normalizeText(input.displayName);
  const vehicleLabel = normalizeText(input.vehicleLabel);
  const phone = normalizeText(input.driverPhone) || normalizeText(input.sessionPhone);
  const sessionEmail = normalizeText(input.sessionEmail);
  const savedEmail = normalizeText(input.driverEmail);
  const email = sessionEmail || savedEmail || null;
  const authInitialized = !!sessionEmail
    || (input.allowPersistedAuth === true && input.remoteAuthInitialized === 'true');

  return {
    configured: input.configured,
    deviceId: input.deviceId,
    displayName,
    vehicleLabel,
    phone,
    email,
    authInitialized,
    approvalStatus: authInitialized
      ? normalizeApprovalStatus(input.approvalStatus)
      : 'unregistered',
    profileComplete: isDriverProfileComplete({
      displayName,
      vehicleLabel,
      email,
      phone,
      requireContactInfo: input.configured,
    }),
  };
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
}, options?: {
  client?: SupabaseClient | null;
  accessToken?: string | null;
}) {
  const client = options?.client ?? driverSupabase;
  if (!client) return null;
  return claimTracklogDeviceProfileViaFunction({
    deviceId: input.deviceId,
    displayName: input.displayName?.trim() || null,
    vehicleLabel: input.vehicleLabel?.trim() || null,
    driverPhone: input.driverPhone?.trim() || null,
    driverEmail: input.driverEmail?.trim() || null,
    platform: Capacitor.getPlatform(),
    appVersion: APP_VERSION,
    latestStatus: input.latestStatus ?? null,
    latestTripId: input.latestTripId ?? null,
    latestLat: input.latestLat ?? null,
    latestLng: input.latestLng ?? null,
    latestAccuracy: input.latestAccuracy ?? null,
    lastSeenAt: nowIso(),
  }, {
    client,
    accessToken: options?.accessToken,
  }) as Promise<ClaimedDeviceProfile | null>;
}

async function getCurrentCloudProfile(
  userId: string,
  client: SupabaseClient | null = driverSupabase,
): Promise<DriverProfileSeed | null> {
  if (!client) return null;
  const { data, error } = await client
    .from('device_profiles')
    .select('display_name, vehicle_label, driver_phone, driver_email, approval_status')
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
    approvalStatus: normalizeApprovalStatus(data.approval_status),
  };
}

async function getPersistedDriverIdentity(
  stableDeviceKey: string,
  sessionProfile?: { email?: string | null; phone?: string | null } | null,
  options?: { allowPersistedAuth?: boolean },
): Promise<DriverIdentity> {
  const [
    displayName,
    vehicleLabel,
    driverPhone,
    localEmail,
    remoteAuthInitialized,
    localApprovalStatus,
  ] = await Promise.all([
    getMeta(META_DEVICE_DISPLAY_NAME),
    getMeta(META_DEVICE_VEHICLE_LABEL),
    getMeta(META_DRIVER_PHONE),
    getMeta(META_DRIVER_EMAIL),
    getMeta(META_REMOTE_AUTH_INITIALIZED),
    getMeta(META_DRIVER_APPROVAL_STATUS),
  ]);

  return deriveDriverIdentityFromPersistence({
    configured: SUPABASE_CONFIGURED,
    deviceId: stableDeviceKey,
    displayName,
    vehicleLabel,
    driverPhone,
    driverEmail: localEmail,
    remoteAuthInitialized,
    approvalStatus: localApprovalStatus,
    sessionEmail: sessionProfile?.email,
    sessionPhone: sessionProfile?.phone,
    allowPersistedAuth: options?.allowPersistedAuth,
  });
}

export async function getDriverIdentity(): Promise<DriverIdentity> {
  const { stableDeviceKey } = await getStableDeviceKey();
  try {
    const profile = await getProfileIdentity();
    return getPersistedDriverIdentity(stableDeviceKey, profile, {
      allowPersistedAuth: false,
    });
  } catch (error) {
    // Persisted registration and approval remain available while Auth is temporarily unreachable.
    return getPersistedDriverIdentity(stableDeviceKey, null, {
      allowPersistedAuth: !isPermanentDriverAuthFailure(error),
    });
  }
}

/** Reads the Android enrollment without token refresh or any cloud request. */
export async function getDriverStartupIdentity(): Promise<DriverIdentity | null> {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return null;
  const authIntent = getDriverAuthIntentGeneration();
  const [{ stableDeviceKey }, authorization] = await Promise.all([
    getStableDeviceKey(),
    ResidentLocation.getAuthorization(),
  ]);
  const identity = await getPersistedDriverIdentity(stableDeviceKey, null, {
    allowPersistedAuth: true,
  });
  if (!isCurrentDriverAuthIntent(authIntent)) return null;
  return resolveNativeStartupIdentity({
    identity,
    authorizationConfigured: authorization.configured,
    authorizationBlocked: authorization.blocked,
    authorizationEmail: getNativeAuthorizationEmail(authorization.accessToken),
    explicitSignOut: isDriverExplicitSignOutRequested(),
  });
}

async function getProfileIdentity() {
  if (!SUPABASE_CONFIGURED || !driverAuthSupabase) return null;
  let result: Awaited<ReturnType<typeof driverAuthSupabase.auth.getSession>>;
  try {
    await restoreNativeResidentLocationSession();
    result = await driverAuthSupabase.auth.getSession();
  } catch (error) {
    throw new DriverAuthSessionRefreshError(error);
  }
  const { data, error } = result;
  if (error) throw new DriverAuthSessionRefreshError(error);
  const session = data.session;
  if (!session?.user) return null;
  return {
    email: normalizeText(session.user.email),
    phone: normalizeText(session.user.phone),
    accessToken: session.access_token,
  };
}

export type InitializeDriverIdentityOptions = {
  enrollmentAccessToken?: string | null;
  expectedAuthIntent?: number;
  skipNativeSessionRestore?: boolean;
};

export async function initializeDriverIdentity(
  options?: InitializeDriverIdentityOptions,
): Promise<DriverIdentity> {
  if (!SUPABASE_CONFIGURED || !driverAuthSupabase) {
    return getDriverIdentity();
  }

  const assertCurrentAuthIntent = () => {
    if (
      options?.expectedAuthIntent != null
      && !isCurrentDriverAuthIntent(options.expectedAuthIntent)
    ) {
      throw new Error('認証処理は新しい操作により中止されました');
    }
  };
  assertCurrentAuthIntent();
  const { stableDeviceKey } = await getStableDeviceKey();
  const persistedIdentity = await getPersistedDriverIdentity(stableDeviceKey, null, {
    allowPersistedAuth: true,
  });
  let session: Session | null;
  try {
    if (!options?.skipNativeSessionRestore) {
      await restoreNativeResidentLocationSession();
    }
    assertCurrentAuthIntent();
    const { data, error } = await driverAuthSupabase.auth.getSession();
    if (error) throw error;
    session = data.session;
  } catch (error) {
    if (options?.enrollmentAccessToken || options?.expectedAuthIntent != null) {
      throw new DriverAuthSessionRefreshError(error);
    }
    if (isPermanentDriverAuthFailure(error)) {
      return getPersistedDriverIdentity(stableDeviceKey, null, {
        allowPersistedAuth: false,
      });
    }
    return persistedIdentity;
  }

  if (!session) {
    if (options?.enrollmentAccessToken || options?.expectedAuthIntent != null) {
      throw new DriverAuthSessionRefreshError(new Error('Driver session was not persisted'));
    }
    await setMeta(META_DEVICE_ID, stableDeviceKey);
    return getPersistedDriverIdentity(stableDeviceKey, null, {
      allowPersistedAuth: false,
    });
  }

  const user = session.user;
  if (!user) {
    throw new Error('ユーザー情報の初期化に失敗しました');
  }
  const enrollmentAccessToken = selectDriverEnrollmentAccessToken({
    expectedAccessToken: options?.enrollmentAccessToken,
    currentAccessToken: session.access_token,
    approvalStatus: persistedIdentity.approvalStatus,
  });
  const enrollmentClient = enrollmentAccessToken ? driverAuthSupabase : driverSupabase;

  const [savedDisplayName, savedVehicleLabel, currentDeviceId, savedDriverPhone, savedDriverEmail] = await Promise.all([
    getMeta(META_DEVICE_DISPLAY_NAME),
    getMeta(META_DEVICE_VEHICLE_LABEL),
    getMeta(META_DEVICE_ID),
    getMeta(META_DRIVER_PHONE),
    getMeta(META_DRIVER_EMAIL),
  ]);
  const cloudProfile = await getCurrentCloudProfile(user.id, enrollmentClient);
  assertCurrentAuthIntent();
  const deviceId = stableDeviceKey;
  if (currentDeviceId && currentDeviceId !== deviceId && isLegacyAnonymousDeviceId(currentDeviceId)) {
    await migrateTracklogDeviceRecordsViaFunction({
      oldDeviceId: currentDeviceId,
      newDeviceId: deviceId,
    }, {
      client: enrollmentClient,
      accessToken: enrollmentAccessToken,
    });
    assertCurrentAuthIntent();
  }

  const mergedDisplayName = normalizeText(savedDisplayName) || cloudProfile?.displayName || getDriverDisplayNameFallback(user) || '';
  const mergedVehicleLabel = normalizeText(savedVehicleLabel) || cloudProfile?.vehicleLabel || '';
  const mergedDriverPhone =
    normalizeText(savedDriverPhone) || cloudProfile?.driverPhone || normalizeText(user.phone) || '';
  const mergedDriverEmail = normalizeText(savedDriverEmail) || cloudProfile?.driverEmail || normalizeText(user.email) || '';

  const mergedProfileComplete = isDriverProfileComplete({
    displayName: mergedDisplayName,
    vehicleLabel: mergedVehicleLabel,
    email: mergedDriverEmail,
    phone: mergedDriverPhone,
    requireContactInfo: true,
  });
  if (!mergedProfileComplete) {
    await Promise.all([
      setMeta(META_DEVICE_ID, deviceId),
      setMeta(META_DEVICE_DISPLAY_NAME, mergedDisplayName || null),
      setMeta(META_DEVICE_VEHICLE_LABEL, mergedVehicleLabel || null),
      setMeta(META_DRIVER_PHONE, mergedDriverPhone || null),
      setMeta(META_DRIVER_EMAIL, mergedDriverEmail || null),
      setMeta(META_REMOTE_AUTH_INITIALIZED, 'true'),
      setMeta(META_DRIVER_APPROVAL_STATUS, 'unregistered'),
    ]);
    return {
      configured: true,
      deviceId,
      displayName: mergedDisplayName,
      vehicleLabel: mergedVehicleLabel,
      phone: mergedDriverPhone,
      email: mergedDriverEmail || null,
      authInitialized: true,
      profileComplete: false,
      approvalStatus: 'unregistered',
    };
  }

  const claimedProfile = await claimTracklogDeviceProfile({
    deviceId,
    displayName: mergedDisplayName,
    vehicleLabel: mergedVehicleLabel,
    driverPhone: mergedDriverPhone,
    driverEmail: mergedDriverEmail,
  }, {
    client: enrollmentClient,
    accessToken: enrollmentAccessToken,
  });
  assertCurrentAuthIntent();
  const displayName = claimedProfile?.display_name?.trim() || mergedDisplayName || buildDefaultDisplayName(deviceId);
  const vehicleLabel = claimedProfile?.vehicle_label?.trim() || mergedVehicleLabel || '';
  const driverPhone = claimedProfile?.driver_phone?.trim() || mergedDriverPhone || '';
  const driverEmail = claimedProfile?.driver_email?.trim() || mergedDriverEmail || '';
  const approvalStatus = normalizeApprovalStatus(claimedProfile?.approval_status ?? cloudProfile?.approvalStatus);

  await Promise.all([
    setMeta(META_DEVICE_ID, deviceId),
    setMeta(META_DEVICE_DISPLAY_NAME, displayName),
    setMeta(META_DEVICE_VEHICLE_LABEL, vehicleLabel),
    setMeta(META_DRIVER_PHONE, driverPhone || null),
    setMeta(META_DRIVER_EMAIL, driverEmail || null),
    setMeta(META_REMOTE_AUTH_INITIALIZED, 'true'),
    setMeta(META_DRIVER_APPROVAL_STATUS, approvalStatus),
  ]);

  return {
    configured: true,
    deviceId,
    displayName,
    vehicleLabel,
    phone: driverPhone,
    email: driverEmail || null,
    authInitialized: true,
    approvalStatus,
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
  const normalized = assertValidDriverProfile({
    displayName: input.displayName,
    vehicleLabel: input.vehicleLabel,
    phone: input.phone,
    email: input.email,
  });

  const [
    confirmed,
    savedEmail,
    savedApprovalStatus,
    sessionProfile,
    savedDisplayName,
    savedVehicleLabel,
    savedDriverPhone,
  ] = await Promise.all([
    getMeta(META_REMOTE_AUTH_INITIALIZED),
    getMeta(META_DRIVER_EMAIL),
    getMeta(META_DRIVER_APPROVAL_STATUS),
    getProfileIdentity(),
    getMeta(META_DEVICE_DISPLAY_NAME),
    getMeta(META_DEVICE_VEHICLE_LABEL),
    getMeta(META_DRIVER_PHONE),
  ]);
  const lockedEmail = normalizeEmail(sessionProfile?.email) || (confirmed === 'true' ? normalizeEmail(savedEmail) : '');
  if (lockedEmail && !sameEmailAddress(normalized.email, lockedEmail)) {
    throw new Error(`この端末は ${lockedEmail} のアカウントに紐づいています。別メールで使う場合は管理者に切替を依頼してください。`);
  }

  const profileLocked =
    confirmed === 'true' &&
    isAppApproved(normalizeApprovalStatus(savedApprovalStatus)) &&
    isDriverProfileComplete({
      displayName: savedDisplayName,
      vehicleLabel: savedVehicleLabel,
      email: lockedEmail || savedEmail,
      phone: savedDriverPhone,
      requireContactInfo: true,
    });
  if (
    profileLocked &&
    (normalized.displayName !== normalizeText(savedDisplayName) ||
      normalized.vehicleLabel !== normalizeVehicleLabelInput(savedVehicleLabel) ||
      normalized.phone !== normalizePhoneInput(savedDriverPhone))
  ) {
    throw new Error('登録済みの端末プロフィールは変更できません。変更が必要な場合は管理者に依頼してください。');
  }

  await Promise.all([
    setMeta(META_DEVICE_DISPLAY_NAME, normalized.displayName),
    setMeta(META_DEVICE_VEHICLE_LABEL, normalized.vehicleLabel),
    setMeta(META_DRIVER_PHONE, normalized.phone),
    setMeta(META_DRIVER_EMAIL, normalized.email),
  ]);

  const identity = await getDriverIdentity();
  if (identity.configured && identity.authInitialized && identity.deviceId) {
    const deviceId = identity.deviceId;
    const nativeCredentialInstallRequired = isAndroidNativePlatform() && Boolean(sessionProfile?.accessToken);
    const enrollmentAuthIntent = nativeCredentialInstallRequired ? beginDriverAuthIntent() : null;
    if (enrollmentAuthIntent != null) {
      invalidateNativeResidentLocationSessionRestore();
    }
    const assertCurrentEnrollmentIntent = () => {
      if (
        enrollmentAuthIntent != null
        && !isCurrentDriverAuthIntent(enrollmentAuthIntent)
      ) {
        throw new Error('認証処理は新しい操作により中止されました');
      }
    };
    try {
      await withDriverAuthMutation(async () => {
        assertCurrentEnrollmentIntent();
        await ensureNativeDriverCredentialInstallation({
          required: nativeCredentialInstallRequired,
          install: async () => {
            const installed = await installNativeResidentLocationAuthorization(
              enrollmentAuthIntent ?? undefined,
            );
            assertCurrentEnrollmentIntent();
            return installed;
          },
        });
        assertCurrentEnrollmentIntent();
        const claimedProfile = await claimTracklogDeviceProfile({
          deviceId,
          displayName: normalized.displayName,
          vehicleLabel: normalized.vehicleLabel,
          driverPhone: normalized.phone,
          driverEmail: normalized.email,
        }, {
          client: sessionProfile?.accessToken ? driverAuthSupabase : driverSupabase,
          accessToken: sessionProfile?.accessToken,
        });
        assertCurrentEnrollmentIntent();
        await setMeta(META_DRIVER_APPROVAL_STATUS, normalizeApprovalStatus(claimedProfile?.approval_status));
      });
    } catch (error) {
      throw error instanceof DriverAuthWorkflowError
        ? error
        : new DriverProfileEnrollmentError(error);
    }
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

function decodeNativeNext(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeNativeAuthNextPath(value: string | null | undefined): NormalizedNativeAuthNext | null {
  if (!value) return null;
  const decoded = decodeNativeNext(value).trim();
  if (
    !decoded.startsWith('/') ||
    decoded.startsWith('//') ||
    decoded.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(decoded) ||
    /(?:^|\/)(?:\.{1,2}|%2e(?:%2e)?)(?:\/|$)/i.test(decoded)
  ) {
    return null;
  }
  try {
    const parsed = new URL(decoded, 'https://tracklog.local');
    if (parsed.origin !== 'https://tracklog.local') return null;
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    const role = NATIVE_AUTH_NEXT_ROUTES.get(pathname);
    if (!role) return null;
    return { nextPath: `${pathname}${parsed.search}`, role };
  } catch {
    return null;
  }
}

type BuildAuthRedirectOptions = {
  role: NativeAuthCallbackIntent;
  native: boolean;
  currentOrigin: string;
  override?: string;
  attemptId?: string;
};

export function buildAuthRedirectUrl({
  role,
  native,
  currentOrigin,
  override,
  attemptId,
}: BuildAuthRedirectOptions) {
  const expectedWebPath = role === 'admin' ? WEB_ADMIN_CALLBACK_PATH : WEB_DRIVER_CALLBACK_PATH;
  const defaultNative = role === 'admin' ? NATIVE_ADMIN_REDIRECT : NATIVE_DRIVER_REDIRECT;
  const raw = override?.trim() || (native ? defaultNative : `${currentOrigin}${expectedWebPath}`);
  const parsed = native ? new URL(raw) : new URL(raw, currentOrigin);

  if (native) {
    if (
      parsed.protocol !== 'com.tracklog.assist:' ||
      parsed.host !== 'auth' ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      (parsed.pathname !== '' && parsed.pathname !== '/')
    ) {
      throw new Error('Android認証の戻り先が許可されていません。');
    }
    const requestedNext = normalizeNativeAuthNextPath(parsed.searchParams.get('next'));
    if (override?.trim() && !requestedNext) {
      throw new Error('Android認証後の画面が許可されていません。');
    }
    const fallbackNext = role === 'admin' ? '/admin' : '/settings';
    const normalizedNext = requestedNext ?? normalizeNativeAuthNextPath(fallbackNext);
    if (!normalizedNext || normalizedNext.role !== role) {
      throw new Error('認証後の画面がログインの種類と一致しません。');
    }
    const result = new URL('com.tracklog.assist://auth');
    result.searchParams.set('next', normalizedNext.nextPath);
    if (attemptId) result.searchParams.set('attempt', attemptId);
    return result.toString();
  }

  const origin = new URL(currentOrigin).origin;
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.origin !== origin ||
    parsed.username ||
    parsed.password ||
    normalizeCallbackPath(parsed.pathname) !== expectedWebPath
  ) {
    throw new Error('Web認証の戻り先が許可されていません。');
  }
  return `${origin}${expectedWebPath}`;
}

function getCurrentOrigin() {
  if (typeof window === 'undefined') return 'https://tracklog.local';
  return window.location.origin;
}

export function getAdminRedirectUrl(override?: string, attemptId?: string) {
  return buildAuthRedirectUrl({
    role: 'admin',
    native: Capacitor.isNativePlatform(),
    currentOrigin: getCurrentOrigin(),
    override,
    attemptId,
  });
}

export function getDriverRedirectUrl(override?: string, attemptId?: string) {
  return buildAuthRedirectUrl({
    role: 'driver',
    native: Capacitor.isNativePlatform(),
    currentOrigin: getCurrentOrigin(),
    override,
    attemptId,
  });
}

export async function withNativeAuthStartForNative<T>(
  intent: NativeAuthCallbackIntent,
  options: NativeAuthStartOptions,
  start: (attempt: NativeAuthAttempt) => Promise<T>,
): Promise<T> {
  // Acquire synchronously, before verifier cleanup yields. This prevents a
  // second start from claiming/replacing the attempt while cleanup or the
  // provider request that writes the new verifier is pending.
  const releaseStartLock = acquireNativeAuthStartLock();
  try {
    const storedAttempt = peekNativeAuthAttemptRecord();
    const activeAttempt = getNativeAuthAttempt();
    if (storedAttempt && !activeAttempt) {
      await clearAuthCodeVerifier(storedAttempt.intent);
    }
    if (options.restartNativeAttempt === true) {
      let previousIntent = activeAttempt?.intent ?? null;
      if (!previousIntent) {
        const pending = getPendingNativeAuthCallback();
        try {
          previousIntent = pending ? parseAuthCallbackUrl(pending.url).callbackRole : null;
        } catch {
          previousIntent = null;
        }
      }
      await clearAuthCodeVerifier(previousIntent ?? intent);
    }
    const attempt = beginNativeAuthAttempt(intent, { restart: options.restartNativeAttempt === true });
    return await start(attempt);
  } finally {
    releaseStartLock();
  }
}

async function withNativeAuthStart<T>(
  intent: NativeAuthCallbackIntent,
  options: NativeAuthStartOptions,
  start: (attempt: NativeAuthAttempt | null) => Promise<T>,
): Promise<T> {
  if (!Capacitor.isNativePlatform()) return start(null);
  return withNativeAuthStartForNative(intent, options, start);
}

function getErrorStatus(error: unknown) {
  if (typeof error !== 'object' || error == null) return null;
  const value = (error as { status?: unknown }).status;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export type AuthExchangeFailureKind = 'transient' | 'permanent';

export function classifyAuthExchangeFailure(error: unknown): AuthExchangeFailureKind {
  const status = getErrorStatus(error);
  if (status != null) {
    if (status === 0 || status === 408 || status === 425 || status === 429 || status >= 500) {
      return 'transient';
    }
    if (status >= 400 && status < 500) return 'permanent';
  }
  const details = typeof error === 'object' && error != null
    ? `${(error as { code?: unknown }).code ?? ''} ${(error as { message?: unknown }).message ?? ''}`
    : `${error ?? ''}`;
  const normalized = details.toLowerCase();
  if (
    normalized.includes('failed to fetch') ||
    normalized.includes('network') ||
    normalized.includes('timeout') ||
    normalized.includes('temporar') ||
    normalized.includes('connection') ||
    normalized.includes('rate limit')
  ) {
    return 'transient';
  }
  if (
    normalized.includes('invalid_grant') ||
    normalized.includes('bad_code_verifier') ||
    normalized.includes('code verifier') ||
    normalized.includes('pkce') ||
    normalized.includes('access_denied') ||
    normalized.includes('cancel') ||
    normalized.includes('expired') ||
    normalized.includes('already used') ||
    normalized.includes('code has been used') ||
    normalized.includes('invalid code') ||
    normalized.includes('invalid') ||
    normalized.includes('not enabled') ||
    normalized.includes('unsupported provider') ||
    normalized.includes('bad request')
  ) {
    return 'permanent';
  }
  return 'transient';
}

async function clearNativeAttemptAfterStartFailure(attempt: NativeAuthAttempt | null, error: unknown) {
  if (attempt && classifyAuthExchangeFailure(error) === 'permanent') {
    if (clearNativeAuthAttempt(attempt.id)) {
      await clearAuthCodeVerifier(attempt.intent);
    }
  }
}

export async function clearNativeAuthStartStateForRole(
  intent: NativeAuthCallbackIntent,
  clearVerifier: (role: NativeAuthCallbackIntent) => Promise<void> = clearAuthCodeVerifier,
) {
  const attempt = getNativeAuthAttempt();
  const pending = getPendingNativeAuthCallback();
  let mayClearVerifier = true;
  if (attempt?.intent === intent) {
    const cleared = clearNativeAuthAttempt(attempt.id);
    mayClearVerifier = cleared;
    if (cleared && pending?.attemptId === attempt.id) clearNativeAuthCallbackUrl(pending.url);
  } else if (!attempt && pending && pending.attemptId == null) {
    try {
      if (parseAuthCallbackUrl(pending.url).callbackRole === intent) {
        clearNativeAuthCallbackUrl(pending.url);
      }
    } catch {
      // An invalid callback is left for the bridge's permanent-failure policy.
    }
  }
  if (mayClearVerifier) await clearVerifier(intent);
}

async function discardNativeAuthAttempt(attempt: NativeAuthAttempt | null) {
  if (!attempt) return;
  if (clearNativeAuthAttempt(attempt.id)) {
    await clearAuthCodeVerifier(attempt.intent);
  }
}

export async function getAdminSession(): Promise<AdminSession> {
  let validatedNativeAccessToken = '';
  try {
    return await resolveAdminSession({
      configured: SUPABASE_CONFIGURED && !!adminAccessSupabase,
      validateUser: async () => {
        if (!adminAccessSupabase) return null;

        if (adminAccessUsesDriverSession) {
          const accessToken = await getNativeDriverAdminAccessToken();
          if (!accessToken) return null;
          // driverSupabase is configured with Supabase's accessToken callback,
          // which deliberately disables its auth API. Validate the native token
          // with the normal auth client, then reuse that exact token for the
          // server-side admin allowlist check below.
          if (!driverAuthSupabase) return null;
          const { data, error } = await driverAuthSupabase.auth.getUser(accessToken);
          if (error) throw error;
          validatedNativeAccessToken = accessToken;
          return data.user ? { email: data.user.email ?? null } : null;
        }

        if (!adminSupabase) return null;
        const { data: sessionData, error: sessionError } = await adminSupabase.auth.getSession();
        if (sessionError) throw sessionError;
        if (!sessionData.session?.access_token) return null;
        const { data, error } = await adminSupabase.auth.getUser(sessionData.session.access_token);
        if (error) throw error;
        return data.user ? { email: data.user.email ?? null } : null;
      },
      getServerAccessState: () => getTracklogAdminAccessStateViaFunction(
        validatedNativeAccessToken ? { accessToken: validatedNativeAccessToken } : undefined,
      ),
    });
  } catch (error) {
    if (classifyAdminValidationFailure(error) === 'definitive') {
      return {
        configured: SUPABASE_CONFIGURED,
        authenticated: false,
        isAdmin: false,
        email: null,
      };
    }
    throw error;
  }
}

export async function sendAdminMagicLink(
  email: string,
  redirectTo?: string,
  options: NativeAuthStartOptions = {},
): Promise<void> {
  const client = adminSupabase;
  if (!SUPABASE_CONFIGURED || !client) {
    throw new Error('Supabase が未設定です');
  }
  const normalized = normalizeEmail(email);
  if (!normalized) {
    throw new Error('メールアドレスを入力してください');
  }
  await withNativeAuthStart('admin', options, async attempt => {
    let callbackUrl: string;
    try {
      callbackUrl = getAdminRedirectUrl(redirectTo, attempt?.id);
    } catch (error) {
      await discardNativeAuthAttempt(attempt);
      throw error;
    }
    try {
      const { error } = await client.auth.signInWithOtp({
        email: normalized,
        options: { emailRedirectTo: callbackUrl },
      });
      if (error) throw error;
    } catch (error) {
      await clearNativeAttemptAfterStartFailure(attempt, error);
      throw error;
    }
  });
}

export async function verifyAdminEmailOtp(email: string, token: string): Promise<AdminSession> {
  if (!SUPABASE_CONFIGURED || !adminSupabase) {
    throw new Error('Supabase が未設定です');
  }
  const normalized = normalizeEmail(email);
  if (!normalized) {
    throw new Error('メールアドレスを入力してください');
  }
  const normalizedToken = toHalfWidthDigits(token).replace(/\D/g, '').trim();
  if (!EMAIL_OTP_PATTERN.test(normalizedToken)) {
    throw new Error(EMAIL_OTP_ERROR_MESSAGE);
  }
  const { error } = await adminSupabase.auth.verifyOtp({
    email: normalized,
    token: normalizedToken,
    type: 'email',
  });
  if (error) throw error;
  if (Capacitor.isNativePlatform()) await clearNativeAuthStartStateForRole('admin');
  return getAdminSession();
}

export async function sendDriverMagicLink(
  email: string,
  redirectTo?: string,
  options: NativeAuthStartOptions = {},
): Promise<void> {
  const client = driverAuthSupabase;
  if (!SUPABASE_CONFIGURED || !client) {
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
  if (lockedEmail && !sameEmailAddress(normalized, lockedEmail)) {
    throw new Error(`この端末は ${lockedEmail} のアカウントに紐づいています。同じメールで再認証してください。`);
  }
  await withNativeAuthStart('driver', options, async attempt => {
    let callbackUrl: string;
    try {
      callbackUrl = getDriverRedirectUrl(redirectTo, attempt?.id);
    } catch (error) {
      await discardNativeAuthAttempt(attempt);
      throw error;
    }
    try {
      const { error } = await client.auth.signInWithOtp({
        email: normalized,
        options: {
          emailRedirectTo: callbackUrl,
          shouldCreateUser: !lockedEmail,
        },
      });
      if (error) throw error;
    } catch (error) {
      await clearNativeAttemptAfterStartFailure(attempt, error);
      throw error;
    }
  });
}

export async function sendDriverLoginLink(
  email: string,
  redirectTo?: string,
  options: NativeAuthStartOptions = {},
): Promise<void> {
  const client = driverAuthSupabase;
  if (!SUPABASE_CONFIGURED || !client) {
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
  if (lockedEmail && !sameEmailAddress(normalized, lockedEmail)) {
    throw new Error(`この端末は ${lockedEmail} のアカウントに紐づいています。同じメールで再認証してください。`);
  }
  await withNativeAuthStart('driver', options, async attempt => {
    let callbackUrl: string;
    try {
      callbackUrl = getDriverRedirectUrl(redirectTo, attempt?.id);
    } catch (error) {
      await discardNativeAuthAttempt(attempt);
      throw error;
    }
    try {
      const { error } = await client.auth.signInWithOtp({
        email: normalized,
        options: {
          emailRedirectTo: callbackUrl,
          shouldCreateUser: false,
        },
      });
      if (error) throw error;
    } catch (error) {
      await clearNativeAttemptAfterStartFailure(attempt, error);
      throw error;
    }
  });
}

export async function verifyDriverEmailOtp(email: string, token: string): Promise<DriverIdentity> {
  const client = driverAuthSupabase;
  if (!SUPABASE_CONFIGURED || !client) {
    throw new Error('Supabase が未設定です');
  }
  const normalized = normalizeEmail(email);
  if (!normalized) {
    throw new Error('メールアドレスを入力してください');
  }
  const normalizedToken = toHalfWidthDigits(token).replace(/\D/g, '').trim();
  if (!EMAIL_OTP_PATTERN.test(normalizedToken)) {
    throw new Error(EMAIL_OTP_ERROR_MESSAGE);
  }
  const [confirmed, savedEmail] = await Promise.all([
    getMeta(META_REMOTE_AUTH_INITIALIZED),
    getMeta(META_DRIVER_EMAIL),
  ]);
  const lockedEmail = confirmed === 'true' ? normalizeEmail(savedEmail) : '';
  if (lockedEmail && !sameEmailAddress(normalized, lockedEmail)) {
    throw new DriverAuthEmailMismatchError(lockedEmail);
  }
  const authIntent = beginDriverAuthIntent();
  invalidateNativeResidentLocationSessionRestore();
  const verifiedSession = await withDriverAuthMutation(async (): Promise<Session> => {
    const { data, error } = await client.auth.verifyOtp({
      email: normalized,
      token: normalizedToken,
      type: 'email',
    });
    if (error) throw error;
    const session = validateVerifiedDriverOtpSession(data.session, normalized);
    if (!isCurrentDriverAuthIntent(authIntent)) {
      throw new Error('認証処理は新しい操作により中止されました');
    }
    await Promise.all([
      setMeta(META_REMOTE_AUTH_INITIALIZED, 'true'),
      setMeta(META_DRIVER_EMAIL, normalized),
    ]);
    if (!isCurrentDriverAuthIntent(authIntent)) {
      throw new Error('認証処理は新しい操作により中止されました');
    }
    clearDriverExplicitSignOut();
    await ensureNativeDriverCredentialInstallation({
      required: isAndroidNativePlatform(),
      install: async () => {
        const installed = await installNativeResidentLocationAuthorization(authIntent);
        if (!isCurrentDriverAuthIntent(authIntent)) {
          throw new Error('認証処理は新しい操作により中止されました');
        }
        return installed;
      },
    });
    if (!isCurrentDriverAuthIntent(authIntent)) {
      throw new Error('認証処理は新しい操作により中止されました');
    }
    return session;
  });
  if (Capacitor.isNativePlatform()) await clearNativeAuthStartStateForRole('driver');
  let identity: DriverIdentity;
  try {
    identity = await initializeDriverIdentity({
      enrollmentAccessToken: verifiedSession.access_token,
      expectedAuthIntent: authIntent,
      skipNativeSessionRestore: true,
    });
  } catch (error) {
    if (error instanceof DriverAuthWorkflowError) throw error;
    throw new DriverProfileEnrollmentError(error);
  }
  return identity;
}

export async function signOutDriver(): Promise<void> {
  const client = driverAuthSupabase;
  if (!client) return;
  if (Capacitor.isNativePlatform()) await clearNativeAuthStartStateForRole('driver');
  const authIntent = beginDriverAuthIntent();
  markDriverExplicitSignOut();
  invalidateNativeResidentLocationSessionRestore();
  await withDriverAuthMutation(async () => {
    if (!isCurrentDriverAuthIntent(authIntent)) return;
    let nativeError: unknown = null;
    try {
      await stopNativeResidentLocation({ reason: 'signed-out' });
    } catch (error) {
      nativeError = error;
    }
    await clearPersistedDriverAuthSession();
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) throw error;
    if (nativeError) throw nativeError;
  });
}

export async function getAdminGoogleSignInUrl(
  redirectTo?: string,
  options: NativeAuthStartOptions = {},
): Promise<string> {
  const client = adminSupabase;
  if (!SUPABASE_CONFIGURED || !client) {
    throw new Error('Supabase が未設定です');
  }
  return withNativeAuthStart('admin', options, async attempt => {
    let callbackUrl: string;
    try {
      callbackUrl = getAdminRedirectUrl(redirectTo, attempt?.id);
    } catch (error) {
      await discardNativeAuthAttempt(attempt);
      throw error;
    }
    try {
      const { data, error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: callbackUrl,
          queryParams: {
            access_type: 'offline',
            prompt: 'select_account',
          },
          skipBrowserRedirect: true,
        },
      });
      if (error) throw error;
      if (!data.url) {
        await discardNativeAuthAttempt(attempt);
        throw new Error('GoogleログインURLの取得に失敗しました');
      }
      return data.url;
    } catch (error) {
      await clearNativeAttemptAfterStartFailure(attempt, error);
      throw error;
    }
  });
}

export async function signOutAdmin(): Promise<void> {
  if (!adminSupabase) return;
  if (Capacitor.isNativePlatform()) await clearNativeAuthStartStateForRole('admin');
  const { error } = await adminSupabase.auth.signOut({ scope: 'local' });
  if (error) throw error;
}

export function onAdminAuthStateChange(callback: () => void) {
  const client = adminAccessUsesDriverSession ? driverAuthSupabase : adminSupabase;
  if (!client) return () => undefined;
  const { data } = client.auth.onAuthStateChange(() => callback());
  return () => {
    data.subscription.unsubscribe();
  };
}

export function onDriverAuthStateChange(callback: (event: AuthChangeEvent) => void) {
  if (!driverAuthSupabase) return () => undefined;
  const { data } = driverAuthSupabase.auth.onAuthStateChange(event => {
    callback(event);
  });
  return () => {
    data.subscription.unsubscribe();
  };
}

type ParsedWebAuthCallback = {
  code: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  errorCode: string | null;
  errorDescription: string | null;
};

function normalizeCallbackPath(pathname: string) {
  const normalized = pathname.replace(/\/+$/, '');
  return normalized || '/';
}

function parseWebAuthCallbackUrl(url: string, expectedPath: string): ParsedWebAuthCallback | null {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (typeof window !== 'undefined' && parsed.origin !== window.location.origin) return null;
  if (normalizeCallbackPath(parsed.pathname) !== expectedPath) return null;

  const query = parsed.searchParams;
  const hash = new URLSearchParams(parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash);
  return {
    code: query.get('code'),
    accessToken: hash.get('access_token'),
    refreshToken: hash.get('refresh_token'),
    errorCode: query.get('error_code') ?? query.get('error') ?? hash.get('error_code') ?? hash.get('error'),
    errorDescription: query.get('error_description') ?? hash.get('error_description'),
  };
}

function throwWebAuthCallbackError(parsed: ParsedWebAuthCallback) {
  if (parsed.errorCode) {
    throw new Error(parsed.errorDescription || parsed.errorCode);
  }
}

type NativeCodeExchangeProtectionOptions = {
  role: NativeAuthCallbackIntent;
  callbackUrl: string;
  attemptId: string | null;
  exchange(): Promise<void>;
};

function callbackStillOwnsVerifier(callbackUrl: string, attemptId: string | null) {
  const activeAttempt = getNativeAuthAttempt();
  const pending = getPendingNativeAuthCallback();
  if (!pending || pending.url !== callbackUrl || pending.attemptId !== attemptId) return false;
  if (attemptId) return activeAttempt?.id === attemptId;
  return activeAttempt == null;
}

export async function exchangeNativeAuthCodeWithRetryProtection({
  role,
  callbackUrl,
  attemptId,
  exchange,
}: NativeCodeExchangeProtectionOptions) {
  // Supabase auth-js removes the PKCE verifier when a response arrives, even
  // for retryable failures. Do not let a restart write a new verifier until
  // this entire exchange (including any restore) has settled.
  const releaseExchangeLock = acquireNativeAuthExchangeLock();
  try {
    const verifierSnapshot = await snapshotAuthCodeVerifier(role);
    try {
      await exchange();
      markNativeAuthCallbackSessionEstablished(callbackUrl);
    } catch (error) {
      if (
        verifierSnapshot &&
        classifyAuthExchangeFailure(error) === 'transient' &&
        callbackStillOwnsVerifier(callbackUrl, attemptId)
      ) {
        await restoreAuthCodeVerifier(role, verifierSnapshot);
      }
      throw error;
    }
  } finally {
    releaseExchangeLock();
  }
}

export async function exchangeWebAuthCodeWithRetryProtection(
  role: NativeAuthCallbackIntent,
  exchange: () => Promise<void>,
) {
  const releaseExchangeLock = acquireNativeAuthExchangeLock();
  try {
    const verifierSnapshot = await snapshotAuthCodeVerifier(role);
    try {
      await exchange();
    } catch (error) {
      if (verifierSnapshot && classifyAuthExchangeFailure(error) === 'transient') {
        await restoreAuthCodeVerifier(role, verifierSnapshot);
        throw Object.assign(
          new Error('通信の問題で認証コードを確認できませんでした。'),
          { cause: error, webAuthCodeRetryable: true as const },
        );
      }
      throw error;
    }
  } finally {
    releaseExchangeLock();
  }
}

function getSessionIssuedAtMs(session: Session) {
  if (
    typeof session.expires_at === 'number' &&
    Number.isFinite(session.expires_at) &&
    typeof session.expires_in === 'number' &&
    Number.isFinite(session.expires_in)
  ) {
    return (session.expires_at - session.expires_in) * 1_000;
  }
  return null;
}

function getJwtSessionId(accessToken: unknown): string | null {
  if (typeof accessToken !== 'string') return null;
  const payload = accessToken.split('.')[1];
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const decoded = globalThis.atob(padded);
    const sessionId = (JSON.parse(decoded) as { session_id?: unknown }).session_id;
    return typeof sessionId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(sessionId)
      ? sessionId
      : null;
  } catch {
    return null;
  }
}

function fallbackSessionFingerprint(material: string) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < material.length; index += 1) {
    const code = material.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `local:${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

async function getSessionFingerprint(session: Session | null): Promise<string | null> {
  if (!session?.user) return null;
  const accessToken = (session as { access_token?: unknown }).access_token;
  const sessionId = getJwtSessionId(accessToken);
  if (sessionId) return `sid:${sessionId}`;

  // Persist only an irreversible digest/fallback fingerprint, never a token.
  const material = typeof accessToken === 'string' && accessToken
    ? accessToken
    : `${session.user.id}:${getSessionIssuedAtMs(session) ?? ''}:${session.expires_at ?? ''}`;
  try {
    const digest = await globalThis.crypto?.subtle?.digest(
      'SHA-256',
      new TextEncoder().encode(material),
    );
    if (digest) {
      const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      return `sha256:${hex}`;
    }
  } catch {
    // Older WebViews still get a bounded, non-secret comparison fingerprint.
  }
  return fallbackSessionFingerprint(material);
}

async function hasEstablishedNativeCallbackSession(
  callbackUrl: string,
  attemptId: string | null,
  session: Session | null,
) {
  const pending = getPendingNativeAuthCallback();
  if (!pending || pending.url !== callbackUrl || pending.attemptId !== attemptId) {
    return false;
  }
  const attempt = getNativeAuthAttempt();
  if (attemptId && attempt?.id !== attemptId) return false;
  if (!attemptId && attempt) return false;
  if (!session?.user) return false;
  const issuedAt = getSessionIssuedAtMs(session);
  const earliestExpectedSession = Math.max(
    attempt?.startedAt ?? 0,
    pending.exchangeStartedAt ?? pending.receivedAt,
  ) - 60_000;
  if (issuedAt != null && issuedAt < earliestExpectedSession) return false;

  if (pending.sessionEstablishedAt) {
    if (attempt && pending.sessionEstablishedAt < attempt.startedAt) return false;
    return attempt == null || issuedAt != null;
  }

  // Process-death recovery: auth-js persists the new session before its
  // exchange promise resolves. If the WebView dies in that small gap, the
  // changed session proves the single-use code was already consumed.
  if (!pending.exchangeStartedAt) return false;
  const currentFingerprint = await getSessionFingerprint(session);
  if (!currentFingerprint || currentFingerprint === pending.priorSessionFingerprint) return false;
  markNativeAuthCallbackSessionEstablished(callbackUrl);
  return true;
}

type ResumeOrExchangeNativeAuthOptions = NativeCodeExchangeProtectionOptions & {
  getSession(): Promise<Session | null>;
};

export async function resumeOrExchangeNativeAuthCodeSession(
  options: ResumeOrExchangeNativeAuthOptions,
): Promise<'resumed' | 'exchanged'> {
  const sessionBeforeExchange = await options.getSession();
  if (await hasEstablishedNativeCallbackSession(
    options.callbackUrl,
    options.attemptId,
    sessionBeforeExchange,
  )) {
    return 'resumed';
  }
  const priorSessionFingerprint = await getSessionFingerprint(sessionBeforeExchange);
  if (!markNativeAuthCallbackExchangeStarted(
    options.callbackUrl,
    options.attemptId,
    priorSessionFingerprint,
  )) {
    throw Object.assign(
      new Error('ログイン試行が更新されています。最新のログインからやり直してください。'),
      { status: 400, code: 'native_auth_callback_state_mismatch' },
    );
  }
  await exchangeNativeAuthCodeWithRetryProtection(options);
  return 'exchanged';
}

async function establishNativeAuthSession(
  client: NonNullable<typeof driverAuthSupabase>,
  parsed: ParsedWebAuthCallback & { attemptId?: string | null },
  role: NativeAuthCallbackIntent,
  callbackUrl: string,
) {
  if (!parsed.code) {
    throw new Error('安全な認証コードが見つかりません。ログインを最初からやり直してください。');
  }
  const attemptId = parsed.attemptId ?? null;
  await resumeOrExchangeNativeAuthCodeSession({
    role,
    callbackUrl,
    attemptId,
    getSession: async () => {
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      return data.session;
    },
    exchange: async () => {
      const { error } = await client.auth.exchangeCodeForSession(parsed.code!);
      if (error) throw error;
    },
  });
}

async function establishWebAuthSession(
  client: NonNullable<typeof driverAuthSupabase>,
  parsed: ParsedWebAuthCallback,
  role: NativeAuthCallbackIntent,
) {
  if (parsed.code) {
    await exchangeWebAuthCodeWithRetryProtection(role, async () => {
      const { error } = await client.auth.exchangeCodeForSession(parsed.code!);
      if (error) throw error;
    });
    return;
  }

  if (parsed.accessToken || parsed.refreshToken) {
    if (!parsed.accessToken || !parsed.refreshToken) {
      throw new Error('認証情報が不足しています。最新のログインメールからやり直してください。');
    }
    const { error } = await client.auth.setSession({
      access_token: parsed.accessToken,
      refresh_token: parsed.refreshToken,
    });
    if (error) throw error;
    return;
  }

  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    throw new Error('認証情報が見つかりません。最新のログインメールからやり直してください。');
  }
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  if (!data.session) {
    throw new Error('認証情報が見つかりません。最新のログインメールからやり直してください。');
  }
}

async function persistCurrentDriverSessionMetadata() {
  if (!driverAuthSupabase) return;
  const { data, error } = await driverAuthSupabase.auth.getSession();
  if (error) throw error;
  if (!data.session?.user) {
    throw new Error('運転者のログイン状態を確認できませんでした。');
  }
  const email = normalizeEmail(data.session.user.email);
  await Promise.all([
    setMeta(META_REMOTE_AUTH_INITIALIZED, 'true'),
    email ? setMeta(META_DRIVER_EMAIL, email) : Promise.resolve(),
  ]);
}

export async function handleAdminWebAuthCallbackUrl(url: string): Promise<{
  handled: boolean;
}> {
  if (!SUPABASE_CONFIGURED || !adminSupabase) {
    throw new Error('Supabase が未設定です');
  }
  const parsed = parseWebAuthCallbackUrl(url, WEB_ADMIN_CALLBACK_PATH);
  if (!parsed) return { handled: false };
  throwWebAuthCallbackError(parsed);
  await establishWebAuthSession(adminSupabase, parsed, 'admin');
  return { handled: true };
}

export async function handleDriverWebAuthCallbackUrl(url: string): Promise<{
  handled: boolean;
  identity?: DriverIdentity;
}> {
  const client = driverAuthSupabase;
  if (!SUPABASE_CONFIGURED || !client) {
    throw new Error('Supabase が未設定です');
  }
  const parsed = parseWebAuthCallbackUrl(url, WEB_DRIVER_CALLBACK_PATH);
  if (!parsed) return { handled: false };
  throwWebAuthCallbackError(parsed);
  const authIntent = beginDriverAuthIntent();
  invalidateNativeResidentLocationSessionRestore();
  await withDriverAuthMutation(async () => {
    await establishWebAuthSession(client, parsed, 'driver');
    if (!isCurrentDriverAuthIntent(authIntent)) {
      throw new Error('認証処理は新しい操作により中止されました');
    }
    await persistCurrentDriverSessionMetadata();
    if (!isCurrentDriverAuthIntent(authIntent)) {
      throw new Error('認証処理は新しい操作により中止されました');
    }
    clearDriverExplicitSignOut();
    await installNativeResidentLocationAuthorization(authIntent).catch(error => {
      console.warn('[resident-location] confirmed login could not be installed natively', error);
    });
    if (!isCurrentDriverAuthIntent(authIntent)) {
      throw new Error('認証処理は新しい操作により中止されました');
    }
  });
  return {
    handled: true,
    identity: await initializeDriverIdentity(),
  };
}

export function parseAuthCallbackUrl(url: string) {
  const parsed = new URL(url);
  const query = new URLSearchParams(parsed.search);
  const hash = new URLSearchParams(parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash);
  const code = query.get('code') ?? hash.get('code');
  const accessToken = hash.get('access_token') ?? query.get('access_token');
  const refreshToken = hash.get('refresh_token') ?? query.get('refresh_token');
  const errorCode =
    hash.get('error_code') ??
    query.get('error_code') ??
    hash.get('error') ??
    query.get('error');
  const errorDescription = hash.get('error_description') ?? query.get('error_description');
  const nextRaw = query.get('next') ?? hash.get('next');
  const normalizedNext = normalizeNativeAuthNextPath(nextRaw);
  const attemptRaw = query.get('attempt') ?? hash.get('attempt');
  const attemptId = attemptRaw && /^[A-Za-z0-9_-]{8,128}$/.test(attemptRaw)
    ? attemptRaw
    : null;
  return {
    scheme: parsed.protocol,
    host: parsed.host,
    pathname: parsed.pathname,
    code,
    accessToken,
    refreshToken,
    errorCode,
    errorDescription,
    nextPath: normalizedNext?.nextPath ?? '/settings',
    callbackRole: normalizedNext?.role ?? null,
    nextProvided: nextRaw != null,
    nextAllowed: normalizedNext != null,
    attemptProvided: attemptRaw != null,
    attemptId,
  };
}

function throwNativeAuthCallbackError(errorCode: string, description: string | null) {
  const error = Object.assign(new Error(description || errorCode), {
    code: errorCode,
    status: 400,
    nativeAuthPermanent: true,
  });
  throw error;
}

export async function handleAdminAuthCallbackUrl(url: string, forceAdmin = false): Promise<{
  handled: boolean;
  nextPath?: string;
}> {
  if (!SUPABASE_CONFIGURED || !adminSupabase) {
    throw new Error('Supabase が未設定です');
  }
  const parsed = parseAuthCallbackUrl(url);
  if (
    parsed.scheme !== 'com.tracklog.assist:' ||
    parsed.host !== 'auth' ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    (parsed.callbackRole !== 'admin' && !(forceAdmin && !parsed.nextProvided))
  ) {
    return { handled: false };
  }
  if (parsed.errorCode) {
    throwNativeAuthCallbackError(parsed.errorCode, parsed.errorDescription);
  }
  if (!parsed.code) {
    return { handled: false };
  }
  await establishNativeAuthSession(adminSupabase, parsed, 'admin', url);
  return {
    handled: true,
    nextPath: parsed.callbackRole === 'admin' ? parsed.nextPath : '/admin',
  };
}
export async function handleDriverAuthCallbackUrl(url: string, forceDriver = false): Promise<{
  handled: boolean;
  nextPath?: string;
}> {
  const client = driverAuthSupabase;
  if (!SUPABASE_CONFIGURED || !client) {
    throw new Error('Supabase が未設定です');
  }
  const parsed = parseAuthCallbackUrl(url);
  if (
    parsed.scheme !== 'com.tracklog.assist:' ||
    parsed.host !== 'auth' ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    (parsed.callbackRole !== 'driver' && !(forceDriver && !parsed.nextProvided))
  ) {
    return { handled: false };
  }
  if (parsed.errorCode) {
    throwNativeAuthCallbackError(parsed.errorCode, parsed.errorDescription);
  }
  if (!parsed.code) {
    return {
      handled: false,
      nextPath: parsed.nextPath,
    };
  }
  const authIntent = beginDriverAuthIntent();
  invalidateNativeResidentLocationSessionRestore();
  await withDriverAuthMutation(async () => {
    await establishNativeAuthSession(client, parsed, 'driver', url);
    if (!isCurrentDriverAuthIntent(authIntent)) {
      throw new Error('認証処理は新しい操作により中止されました');
    }
    await persistCurrentDriverSessionMetadata();
    if (!isCurrentDriverAuthIntent(authIntent)) {
      throw new Error('認証処理は新しい操作により中止されました');
    }
    clearDriverExplicitSignOut();
    await installNativeResidentLocationAuthorization(authIntent).catch(error => {
      console.warn('[resident-location] confirmed login could not be installed natively', error);
    });
    if (!isCurrentDriverAuthIntent(authIntent)) {
      throw new Error('認証処理は新しい操作により中止されました');
    }
  });
  return {
    handled: true,
    nextPath: parsed.callbackRole === 'driver' ? parsed.nextPath : '/settings',
  };
}
