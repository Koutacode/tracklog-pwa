import { createClient } from 'npm:@supabase/supabase-js@2.58.0';

type JsonRecord = Record<string, unknown>;

type TracklogUser = {
  id: string;
  email?: string | null;
  is_anonymous?: boolean;
};

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const DEFAULT_LOCATION_NOTIFICATION_TEXT = '位置記録中';
const LOCATION_NOTIFICATION_TEXT_KEY = 'location_notification_text';
const MAX_NOTIFICATION_TEXT_LENGTH = 40;
const MAX_ADMIN_MESSAGE_BODY_LENGTH = 200;
const ADMIN_MESSAGE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const FIREBASE_PROJECT_ID = Deno.env.get('FIREBASE_PROJECT_ID') ?? '';
const FIREBASE_CLIENT_EMAIL = Deno.env.get('FIREBASE_CLIENT_EMAIL') ?? '';
const FIREBASE_PRIVATE_KEY = (Deno.env.get('FIREBASE_PRIVATE_KEY') ?? '').replace(/\\n/g, '\n');
const FIREBASE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FIREBASE_MESSAGING_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const PUSH_PROVIDER_FCM = 'fcm';
const MAX_PUSH_FAILURES = 3;

let firebaseAccessToken: { token: string; expiresAt: number } | null = null;
let firebasePrivateKey: CryptoKey | null = null;

if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
  console.error('TrackLog Edge Function is missing Supabase environment variables.');
}

const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

function jsonResponse(body: JsonRecord, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Connection': 'keep-alive',
    },
  });
}

function nowIso() {
  return new Date().toISOString();
}

function textValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function nullableText(value: unknown) {
  const text = textValue(value);
  return text.length > 0 ? text : null;
}

function limitCharacters(value: string, maxLength: number) {
  return Array.from(value).slice(0, maxLength).join('');
}

function normalizeLocationNotificationText(value: unknown) {
  const text = textValue(value);
  if (!text) return DEFAULT_LOCATION_NOTIFICATION_TEXT;
  return limitCharacters(text, MAX_NOTIFICATION_TEXT_LENGTH);
}

function booleanValue(value: unknown, fallback: boolean) {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function normalizeAdminMessageBody(value: unknown) {
  const text = textValue(value).replace(/\s+/g, ' ');
  if (!text) throw new HttpError(400, 'body is required');
  return limitCharacters(text, MAX_ADMIN_MESSAGE_BODY_LENGTH);
}

function stringArray(value: unknown, key: string) {
  if (!Array.isArray(value)) throw new HttpError(400, `${key} must be an array`);
  const items = value
    .map(item => textValue(item))
    .filter(item => item.length > 0);
  if (items.length === 0) throw new HttpError(400, `${key} is required`);
  return Array.from(new Set(items)).slice(0, 50);
}

function isFcmConfigured() {
  return !!(FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY);
}

function normalizePushPlatform(value: unknown) {
  const platform = textValue(value).toLowerCase();
  if (platform !== 'android' && platform !== 'web') {
    throw new HttpError(400, 'platform must be android or web');
  }
  return platform;
}

function base64UrlEncode(input: string | ArrayBuffer) {
  const bytes = typeof input === 'string'
    ? new TextEncoder().encode(input)
    : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function pemToArrayBuffer(pem: string) {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function getFirebasePrivateKey() {
  if (!firebasePrivateKey) {
    firebasePrivateKey = await crypto.subtle.importKey(
      'pkcs8',
      pemToArrayBuffer(FIREBASE_PRIVATE_KEY),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  }
  return firebasePrivateKey;
}

async function signFirebaseJwt() {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: FIREBASE_CLIENT_EMAIL,
    sub: FIREBASE_CLIENT_EMAIL,
    aud: FIREBASE_TOKEN_URL,
    scope: FIREBASE_MESSAGING_SCOPE,
    iat: issuedAt,
    exp: issuedAt + 3600,
  };
  const input = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claim))}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    await getFirebasePrivateKey(),
    new TextEncoder().encode(input),
  );
  return `${input}.${base64UrlEncode(signature)}`;
}

async function getFirebaseAccessToken() {
  if (!isFcmConfigured()) {
    throw new Error('Firebase FCM secrets are not configured');
  }
  if (firebaseAccessToken && firebaseAccessToken.expiresAt - Date.now() > 60_000) {
    return firebaseAccessToken.token;
  }

  const assertion = await signFirebaseJwt();
  const resp = await fetch(FIREBASE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const json = await resp.json().catch(() => ({})) as JsonRecord;
  if (!resp.ok) {
    throw new Error(`Firebase OAuth failed: ${textValue(json.error_description) || textValue(json.error) || resp.status}`);
  }
  const token = textValue(json.access_token);
  if (!token) throw new Error('Firebase OAuth response did not include an access token');
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  firebaseAccessToken = {
    token,
    expiresAt: Date.now() + Math.max(60, expiresIn - 30) * 1000,
  };
  return token;
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function requiredText(payload: JsonRecord, key: string) {
  const value = textValue(payload[key]);
  if (!value) throw new HttpError(400, `${key} is required`);
  return value;
}

function nullableNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requiredNumber(payload: JsonRecord, key: string, min: number, max: number) {
  const value = Number(payload[key]);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new HttpError(400, `${key} is invalid`);
  }
  return value;
}

function requiredIso(payload: JsonRecord, key: string) {
  const value = requiredText(payload, key);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new HttpError(400, `${key} is invalid`);
  return new Date(parsed).toISOString();
}

async function requireUser(req: Request): Promise<TracklogUser> {
  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) {
    throw new HttpError(401, 'Authorization header is required');
  }

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: authorization,
      },
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) {
    throw new HttpError(401, error?.message ?? 'Invalid auth session');
  }
  const user = data.user as TracklogUser;
  if (user.is_anonymous) {
    throw new HttpError(403, 'Anonymous users cannot use TrackLog cloud actions');
  }
  return user;
}

async function isTracklogAdmin(user: TracklogUser) {
  const email = textValue(user.email).toLowerCase();
  if (!email) return false;
  const { data, error } = await adminClient
    .from('admin_users')
    .select('email')
    .eq('enabled', true)
    .ilike('email', email)
    .limit(1);
  if (error) throw new HttpError(500, `Admin check failed: ${error.message}`);
  return (data ?? []).length > 0;
}

async function getDeviceProfile(deviceId: string) {
  const { data, error } = await adminClient
    .from('device_profiles')
    .select('*')
    .eq('device_id', deviceId)
    .maybeSingle();
  if (error) throw new HttpError(500, `Device profile lookup failed: ${error.message}`);
  return data as JsonRecord | null;
}

function ensureDeviceOwner(profile: JsonRecord | null, user: TracklogUser, admin: boolean, label: string) {
  const owner = textValue(profile?.auth_user_id);
  if (owner && owner !== user.id && !admin) {
    throw new HttpError(403, `${label} is assigned to another account`);
  }
}

async function claimDeviceProfile(payload: JsonRecord, user: TracklogUser, admin: boolean) {
  const deviceId = requiredText(payload, 'deviceId');
  const existing = await getDeviceProfile(deviceId);
  ensureDeviceOwner(existing, user, admin, 'Device profile');

  const approvalStatus = textValue(existing?.approval_status) || 'pending';
  const approvalRequestedAt = textValue(existing?.approval_requested_at) || nowIso();
  const row = {
    device_id: deviceId,
    auth_user_id: user.id,
    display_name:
      nullableText(payload.displayName) ??
      nullableText(existing?.display_name) ??
      `端末-${deviceId.replace(/[^a-zA-Z0-9]/g, '').slice(-8)}`,
    vehicle_label: nullableText(payload.vehicleLabel) ?? nullableText(existing?.vehicle_label),
    driver_phone: nullableText(payload.driverPhone) ?? nullableText(existing?.driver_phone),
    driver_email: nullableText(payload.driverEmail) ?? nullableText(existing?.driver_email) ?? nullableText(user.email),
    platform: nullableText(payload.platform) ?? nullableText(existing?.platform) ?? 'unknown',
    app_version: nullableText(payload.appVersion) ?? nullableText(existing?.app_version),
    latest_status: nullableText(payload.latestStatus) ?? nullableText(existing?.latest_status),
    latest_trip_id: nullableText(payload.latestTripId) ?? nullableText(existing?.latest_trip_id),
    latest_lat: nullableNumber(payload.latestLat) ?? nullableNumber(existing?.latest_lat),
    latest_lng: nullableNumber(payload.latestLng) ?? nullableNumber(existing?.latest_lng),
    latest_accuracy: nullableNumber(payload.latestAccuracy) ?? nullableNumber(existing?.latest_accuracy),
    latest_location_at:
      nullableText(payload.latestLocationAt) ??
      nullableText(existing?.latest_location_at) ??
      (nullableNumber(payload.latestLat) != null && nullableNumber(payload.latestLng) != null ? nowIso() : null),
    last_seen_at: nullableText(payload.lastSeenAt) ?? nowIso(),
    approval_status: approvalStatus,
    approval_requested_at: approvalRequestedAt,
    approval_decided_at: nullableText(existing?.approval_decided_at),
    approval_decided_by: nullableText(existing?.approval_decided_by),
  };

  const { data, error } = await adminClient
    .from('device_profiles')
    .upsert(row, { onConflict: 'device_id' })
    .select('*')
    .single();
  if (error) throw new HttpError(500, `Device profile claim failed: ${error.message}`);
  return data;
}

async function updateDeviceLocation(payload: JsonRecord, user: TracklogUser, admin: boolean) {
  const deviceId = requiredText(payload, 'deviceId');
  const existing = await getDeviceProfile(deviceId);
  if (!existing) throw new HttpError(404, 'Device profile not found');
  ensureDeviceOwner(existing, user, admin, 'Device profile');
  if (!textValue(existing.auth_user_id) && !admin) {
    throw new HttpError(403, 'Device profile is not assigned to this account');
  }
  if (textValue(existing.approval_status) !== 'approved') {
    throw new HttpError(403, 'Device profile is not approved');
  }

  const lat = requiredNumber(payload, 'latestLat', -90, 90);
  const lng = requiredNumber(payload, 'latestLng', -180, 180);
  const accuracy = nullableNumber(payload.latestAccuracy);
  const latestLocationAt = requiredIso(payload, 'latestLocationAt');
  const lastSeenAt = requiredIso(payload, 'lastSeenAt');

  const { data, error } = await adminClient
    .from('device_profiles')
    .update({
      latest_status: nullableText(payload.latestStatus) ?? nullableText(existing.latest_status),
      latest_trip_id: nullableText(payload.latestTripId),
      latest_lat: lat,
      latest_lng: lng,
      latest_accuracy: accuracy != null && accuracy >= 0 ? accuracy : null,
      latest_location_at: latestLocationAt,
      last_seen_at: lastSeenAt,
    })
    .eq('device_id', deviceId)
    .select('*')
    .single();
  if (error) throw new HttpError(500, `Device location update failed: ${error.message}`);
  return data;
}

function resolveMigrationApprovalStatus(oldProfile: JsonRecord, newProfile: JsonRecord | null) {
  const oldStatus = textValue(oldProfile.approval_status);
  const newStatus = textValue(newProfile?.approval_status);
  if (oldStatus === 'approved' || newStatus === 'approved') return 'approved';
  if (newStatus === 'rejected') return 'rejected';
  return oldStatus || newStatus || 'pending';
}

async function migrateDeviceRecords(payload: JsonRecord, user: TracklogUser, admin: boolean) {
  const oldDeviceId = textValue(payload.oldDeviceId);
  const newDeviceId = textValue(payload.newDeviceId);
  if (!oldDeviceId || !newDeviceId || oldDeviceId === newDeviceId) return { migrated: false };

  const oldProfile = await getDeviceProfile(oldDeviceId);
  if (!oldProfile) return { migrated: false };
  ensureDeviceOwner(oldProfile, user, admin, 'Old device profile');

  const newProfile = await getDeviceProfile(newDeviceId);
  ensureDeviceOwner(newProfile, user, admin, 'New device profile');

  const nextProfile = {
    device_id: newDeviceId,
    auth_user_id: user.id,
    display_name: nullableText(newProfile?.display_name) ?? nullableText(oldProfile.display_name),
    vehicle_label: nullableText(newProfile?.vehicle_label) ?? nullableText(oldProfile.vehicle_label),
    driver_phone: nullableText(newProfile?.driver_phone) ?? nullableText(oldProfile.driver_phone),
    driver_email: nullableText(newProfile?.driver_email) ?? nullableText(oldProfile.driver_email),
    platform: nullableText(newProfile?.platform) ?? nullableText(oldProfile.platform) ?? 'unknown',
    app_version: nullableText(newProfile?.app_version) ?? nullableText(oldProfile.app_version),
    latest_status: nullableText(newProfile?.latest_status) ?? nullableText(oldProfile.latest_status),
    latest_trip_id: nullableText(newProfile?.latest_trip_id) ?? nullableText(oldProfile.latest_trip_id),
    latest_lat: nullableNumber(newProfile?.latest_lat) ?? nullableNumber(oldProfile.latest_lat),
    latest_lng: nullableNumber(newProfile?.latest_lng) ?? nullableNumber(oldProfile.latest_lng),
    latest_accuracy: nullableNumber(newProfile?.latest_accuracy) ?? nullableNumber(oldProfile.latest_accuracy),
    latest_location_at:
      nullableText(newProfile?.latest_location_at) ??
      nullableText(oldProfile.latest_location_at),
    last_seen_at: nullableText(newProfile?.last_seen_at) ?? nullableText(oldProfile.last_seen_at) ?? nowIso(),
    approval_status: resolveMigrationApprovalStatus(oldProfile, newProfile),
    approval_requested_at:
      nullableText(newProfile?.approval_requested_at) ?? nullableText(oldProfile.approval_requested_at) ?? nowIso(),
    approval_decided_at: nullableText(newProfile?.approval_decided_at) ?? nullableText(oldProfile.approval_decided_at),
    approval_decided_by: nullableText(newProfile?.approval_decided_by) ?? nullableText(oldProfile.approval_decided_by),
  };

  const { error: upsertError } = await adminClient
    .from('device_profiles')
    .upsert(nextProfile, { onConflict: 'device_id' });
  if (upsertError) throw new HttpError(500, `Device profile migration failed: ${upsertError.message}`);

  for (const table of ['trip_headers', 'trip_events', 'trip_route_points', 'report_snapshots']) {
    const { error } = await adminClient
      .from(table)
      .update({ device_id: newDeviceId })
      .eq('device_id', oldDeviceId);
    if (error) throw new HttpError(500, `${table} migration failed: ${error.message}`);
  }

  const { error: deleteError } = await adminClient
    .from('device_profiles')
    .delete()
    .eq('device_id', oldDeviceId);
  if (deleteError) throw new HttpError(500, `Old device cleanup failed: ${deleteError.message}`);
  return { migrated: true };
}

async function requireAdmin(user: TracklogUser, admin: boolean) {
  if (!admin) {
    throw new HttpError(403, `Admin privileges required for ${textValue(user.email) || user.id}`);
  }
}

async function getRuntimeConfig() {
  const { data, error } = await adminClient
    .from('tracklog_runtime_config')
    .select('key, value, updated_at')
    .eq('key', LOCATION_NOTIFICATION_TEXT_KEY)
    .maybeSingle();
  if (error) throw new HttpError(500, `Runtime config lookup failed: ${error.message}`);
  return {
    locationNotificationText: normalizeLocationNotificationText((data as JsonRecord | null)?.value),
    updatedAt: nullableText((data as JsonRecord | null)?.updated_at),
  };
}

async function updateRuntimeConfig(payload: JsonRecord, user: TracklogUser, admin: boolean) {
  await requireAdmin(user, admin);
  const locationNotificationText = normalizeLocationNotificationText(payload.locationNotificationText);
  const { error } = await adminClient
    .from('tracklog_runtime_config')
    .upsert({
      key: LOCATION_NOTIFICATION_TEXT_KEY,
      value: locationNotificationText,
      updated_at: nowIso(),
      updated_by: user.id,
    }, { onConflict: 'key' });
  if (error) throw new HttpError(500, `Runtime config update failed: ${error.message}`);
  return getRuntimeConfig();
}

async function registerPushToken(payload: JsonRecord, user: TracklogUser, admin: boolean) {
  const deviceId = requiredText(payload, 'deviceId');
  const token = requiredText(payload, 'token');
  const platform = normalizePushPlatform(payload.platform);
  const profile = await getDeviceProfile(deviceId);
  if (!profile) throw new HttpError(404, 'Device profile not found');
  ensureDeviceOwner(profile, user, admin, 'Device profile');
  if (!admin && textValue(profile.auth_user_id) !== user.id) {
    throw new HttpError(403, 'Device profile is not assigned to this account');
  }
  if (textValue(profile.approval_status) !== 'approved') {
    throw new HttpError(403, 'Device profile is not approved');
  }

  const now = nowIso();
  const tokenHash = await sha256Hex(token);
  const { data, error } = await adminClient
    .from('tracklog_push_registrations')
    .upsert({
      device_id: deviceId,
      auth_user_id: user.id,
      provider: PUSH_PROVIDER_FCM,
      platform,
      token,
      token_hash: tokenHash,
      enabled: true,
      failure_count: 0,
      last_error: null,
      updated_at: now,
      last_seen_at: now,
    }, { onConflict: 'provider,token_hash' })
    .select('id, device_id, platform, enabled, updated_at, last_seen_at')
    .single();
  if (error) throw new HttpError(500, `Push token registration failed: ${error.message}`);
  return {
    ...data,
    pushConfigured: isFcmConfigured(),
  };
}

async function unregisterPushToken(payload: JsonRecord, user: TracklogUser, admin: boolean) {
  const deviceId = requiredText(payload, 'deviceId');
  const token = requiredText(payload, 'token');
  const profile = await getDeviceProfile(deviceId);
  if (!profile) throw new HttpError(404, 'Device profile not found');
  ensureDeviceOwner(profile, user, admin, 'Device profile');
  if (!admin && textValue(profile.auth_user_id) !== user.id) {
    throw new HttpError(403, 'Device profile is not assigned to this account');
  }

  const tokenHash = await sha256Hex(token);
  const { error, count } = await adminClient
    .from('tracklog_push_registrations')
    .update({
      enabled: false,
      updated_at: nowIso(),
    }, { count: 'exact' })
    .eq('provider', PUSH_PROVIDER_FCM)
    .eq('token_hash', tokenHash)
    .eq('device_id', deviceId);
  if (error) throw new HttpError(500, `Push token unregister failed: ${error.message}`);
  return { disabledCount: count ?? 0 };
}

function getAdminPushData(message: JsonRecord) {
  const requestLocation = booleanValue(message.request_location, true);
  return {
    kind: 'tracklog_admin_message_v1',
    messageId: textValue(message.id),
    requestLocation: requestLocation ? 'true' : 'false',
    sentAt: textValue(message.sent_at),
  };
}

function getPwaLinkForMessage(message: JsonRecord) {
  const params = new URLSearchParams({
    tracklogPushMessageId: textValue(message.id),
    tracklogRequestLocation: booleanValue(message.request_location, true) ? '1' : '0',
  });
  return `https://tracklog-assist.pages.dev/?${params.toString()}`;
}

async function sendFcmMessage(registration: JsonRecord, message: JsonRecord) {
  const token = textValue(registration.token);
  const platform = textValue(registration.platform);
  if (!token) throw new Error('Push token is empty');
  const accessToken = await getFirebaseAccessToken();
  const data = getAdminPushData(message);
  const body = textValue(message.body);
  const resp = await fetch(`https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token,
        notification: {
          title: 'TrackLog',
          body,
        },
        data,
        android: {
          priority: 'HIGH',
          notification: {
            channel_id: 'tracklog_admin_messages',
            title: 'TrackLog',
            body,
            click_action: 'TRACKLOG_ADMIN_MESSAGE',
          },
        },
        webpush: {
          headers: {
            TTL: '3600',
            Urgency: 'high',
          },
          notification: {
            title: 'TrackLog',
            body,
            tag: `tracklog-admin-${textValue(message.id)}`,
            renotify: true,
            data,
            actions: booleanValue(message.request_location, true)
              ? [{ action: 'update_location', title: '現在地更新' }]
              : [],
          },
          fcm_options: {
            link: getPwaLinkForMessage(message),
          },
        },
      },
    }),
  });
  const json = await resp.json().catch(() => ({})) as JsonRecord;
  if (!resp.ok) {
    const error = json.error as JsonRecord | undefined;
    const status = textValue(error?.status) || textValue(json.error) || String(resp.status);
    const details = typeof error?.message === 'string' ? error.message : '';
    const permanent =
      resp.status === 404 ||
      status === 'UNREGISTERED' ||
      (resp.status === 400 && (status === 'INVALID_ARGUMENT' || details.includes('registration token')));
    throw Object.assign(new Error(`${status}${details ? `: ${details}` : ''}`), {
      permanent,
      responseStatus: resp.status,
      platform,
    });
  }
  return textValue(json.name) || 'sent';
}

async function markPushDelivered(registrationId: string) {
  const { error } = await adminClient
    .from('tracklog_push_registrations')
    .update({
      failure_count: 0,
      last_error: null,
      updated_at: nowIso(),
      last_seen_at: nowIso(),
    })
    .eq('id', registrationId);
  if (error) console.error('[tracklog-privileged] push delivery state update failed', error.message);
}

async function markPushFailed(registration: JsonRecord, error: unknown) {
  const registrationId = textValue(registration.id);
  if (!registrationId) return;
  const message = error instanceof Error ? error.message : 'Push delivery failed';
  const nextFailureCount = (typeof registration.failure_count === 'number' ? registration.failure_count : 0) + 1;
  const permanent = error instanceof Error && (error as Error & { permanent?: boolean }).permanent === true;
  const { error: updateError } = await adminClient
    .from('tracklog_push_registrations')
    .update({
      enabled: permanent || nextFailureCount >= MAX_PUSH_FAILURES ? false : true,
      failure_count: nextFailureCount,
      last_error: limitCharacters(message, 500),
      updated_at: nowIso(),
    })
    .eq('id', registrationId);
  if (updateError) console.error('[tracklog-privileged] push failure state update failed', updateError.message);
}

async function getPushTargetDeviceIds(targetDeviceId: string | null) {
  if (targetDeviceId) return [targetDeviceId];
  const { data, error } = await adminClient
    .from('device_profiles')
    .select('device_id')
    .eq('approval_status', 'approved')
    .limit(500);
  if (error) throw new Error(`Push target lookup failed: ${error.message}`);
  return (data ?? [])
    .map(row => textValue((row as JsonRecord).device_id))
    .filter(deviceId => deviceId.length > 0);
}

async function sendPushForAdminMessage(message: JsonRecord) {
  if (!isFcmConfigured()) {
    console.warn('[tracklog-privileged] Firebase FCM secrets are not configured; admin message will be delivered by polling only.');
    return { configured: false, attempted: 0, sent: 0, failed: 0 };
  }

  const targetDeviceIds = await getPushTargetDeviceIds(nullableText(message.target_device_id));
  if (targetDeviceIds.length === 0) return { configured: true, attempted: 0, sent: 0, failed: 0 };

  const { data, error } = await adminClient
    .from('tracklog_push_registrations')
    .select('id, device_id, platform, token, failure_count')
    .eq('provider', PUSH_PROVIDER_FCM)
    .eq('enabled', true)
    .in('device_id', targetDeviceIds)
    .limit(1000);
  if (error) throw new Error(`Push token lookup failed: ${error.message}`);

  let sent = 0;
  let failed = 0;
  for (const registration of (data ?? []) as JsonRecord[]) {
    try {
      await sendFcmMessage(registration, message);
      sent += 1;
      await markPushDelivered(textValue(registration.id));
    } catch (pushError) {
      failed += 1;
      console.error('[tracklog-privileged] FCM delivery failed', pushError);
      await markPushFailed(registration, pushError);
    }
  }
  return { configured: true, attempted: (data ?? []).length, sent, failed };
}

async function sendAdminMessage(payload: JsonRecord, user: TracklogUser, admin: boolean) {
  await requireAdmin(user, admin);
  const targetDeviceId = nullableText(payload.targetDeviceId);
  if (targetDeviceId) {
    const profile = await getDeviceProfile(targetDeviceId);
    if (!profile) throw new HttpError(404, 'Target device profile not found');
  }

  const { data, error } = await adminClient
    .from('tracklog_admin_messages')
    .insert({
      target_device_id: targetDeviceId,
      body: normalizeAdminMessageBody(payload.body),
      request_location: booleanValue(payload.requestLocation, true),
      sent_by: user.id,
    })
    .select('*')
    .single();
  if (error) throw new HttpError(500, `Admin message send failed: ${error.message}`);
  const pushDelivery = await sendPushForAdminMessage(data as JsonRecord).catch(pushError => {
    console.error('[tracklog-privileged] Admin message push delivery failed', pushError);
    return { configured: isFcmConfigured(), attempted: 0, sent: 0, failed: 1, error: 'push delivery failed' };
  });
  return {
    ...(data as JsonRecord),
    push_delivery: pushDelivery,
  };
}

async function listPendingAdminMessages(payload: JsonRecord, user: TracklogUser, admin: boolean) {
  const deviceId = requiredText(payload, 'deviceId');
  const profile = await getDeviceProfile(deviceId);
  if (!profile) throw new HttpError(404, 'Device profile not found');
  ensureDeviceOwner(profile, user, admin, 'Device profile');
  if (!admin && textValue(profile.auth_user_id) !== user.id) {
    throw new HttpError(403, 'Device profile is not assigned to this account');
  }
  if (textValue(profile.approval_status) !== 'approved') {
    throw new HttpError(403, 'Device profile is not approved');
  }

  const since = new Date(Date.now() - ADMIN_MESSAGE_LOOKBACK_MS).toISOString();
  const [broadcastResult, targetedResult, receiptResult] = await Promise.all([
    adminClient
      .from('tracklog_admin_messages')
      .select('*')
      .is('target_device_id', null)
      .gte('sent_at', since)
      .order('sent_at', { ascending: false })
      .limit(50),
    adminClient
      .from('tracklog_admin_messages')
      .select('*')
      .eq('target_device_id', deviceId)
      .gte('sent_at', since)
      .order('sent_at', { ascending: false })
      .limit(50),
    adminClient
      .from('tracklog_admin_message_receipts')
      .select('message_id')
      .eq('device_id', deviceId)
      .gte('received_at', since),
  ]);
  if (broadcastResult.error) throw new HttpError(500, `Admin message lookup failed: ${broadcastResult.error.message}`);
  if (targetedResult.error) throw new HttpError(500, `Admin message lookup failed: ${targetedResult.error.message}`);
  if (receiptResult.error) throw new HttpError(500, `Admin message receipt lookup failed: ${receiptResult.error.message}`);

  const received = new Set((receiptResult.data ?? []).map(row => textValue((row as JsonRecord).message_id)));
  const merged = new Map<string, JsonRecord>();
  for (const row of [...(broadcastResult.data ?? []), ...(targetedResult.data ?? [])] as JsonRecord[]) {
    const id = textValue(row.id);
    if (id && !received.has(id)) merged.set(id, row);
  }
  return Array.from(merged.values())
    .sort((a, b) => textValue(a.sent_at).localeCompare(textValue(b.sent_at)))
    .slice(0, 20);
}

async function ackAdminMessages(payload: JsonRecord, user: TracklogUser, admin: boolean) {
  const deviceId = requiredText(payload, 'deviceId');
  const messageIds = stringArray(payload.messageIds, 'messageIds');
  const profile = await getDeviceProfile(deviceId);
  if (!profile) throw new HttpError(404, 'Device profile not found');
  ensureDeviceOwner(profile, user, admin, 'Device profile');
  if (!admin && textValue(profile.auth_user_id) !== user.id) {
    throw new HttpError(403, 'Device profile is not assigned to this account');
  }
  if (textValue(profile.approval_status) !== 'approved') {
    throw new HttpError(403, 'Device profile is not approved');
  }
  const locationRequestedAt = nullableText(payload.locationRequestedAt);
  const receivedAt = nowIso();
  const rows = messageIds.map(messageId => ({
    message_id: messageId,
    device_id: deviceId,
    received_at: receivedAt,
    location_requested_at: locationRequestedAt,
  }));
  const { error } = await adminClient
    .from('tracklog_admin_message_receipts')
    .upsert(rows, { onConflict: 'message_id,device_id' });
  if (error) throw new HttpError(500, `Admin message ack failed: ${error.message}`);
  return { acknowledged: rows.length };
}

async function setDeviceApproval(payload: JsonRecord, user: TracklogUser, admin: boolean) {
  await requireAdmin(user, admin);
  const deviceId = requiredText(payload, 'deviceId');
  const approvalStatus = textValue(payload.approvalStatus).toLowerCase();
  if (approvalStatus !== 'approved' && approvalStatus !== 'rejected') {
    throw new HttpError(400, 'approvalStatus must be approved or rejected');
  }
  const { data, error } = await adminClient
    .from('device_profiles')
    .update({
      approval_status: approvalStatus,
      approval_decided_at: nowIso(),
      approval_decided_by: user.id,
    })
    .eq('device_id', deviceId)
    .select('*')
    .single();
  if (error) throw new HttpError(500, `Approval update failed: ${error.message}`);
  return data;
}

async function deleteDevice(payload: JsonRecord, user: TracklogUser, admin: boolean) {
  await requireAdmin(user, admin);
  const deviceId = requiredText(payload, 'deviceId');
  const { error, count } = await adminClient
    .from('device_profiles')
    .delete({ count: 'exact' })
    .eq('device_id', deviceId);
  if (error) throw new HttpError(500, `Device delete failed: ${error.message}`);
  return { deletedCount: count ?? 0 };
}

async function getTripHeader(tripId: string) {
  const { data, error } = await adminClient
    .from('trip_headers')
    .select('trip_id, device_id')
    .eq('trip_id', tripId)
    .maybeSingle();
  if (error) throw new HttpError(500, `Trip lookup failed: ${error.message}`);
  return data as { trip_id: string; device_id: string } | null;
}

async function upsertTripTombstone(tripId: string, deviceId: string, userId: string) {
  const { error } = await adminClient
    .from('deleted_trip_tombstones')
    .upsert({
      trip_id: tripId,
      device_id: deviceId,
      deleted_by: userId,
      deleted_at: nowIso(),
    }, { onConflict: 'trip_id' });
  if (error) throw new HttpError(500, `Trip tombstone write failed: ${error.message}`);
}

async function deleteTrip(payload: JsonRecord, user: TracklogUser, admin: boolean) {
  await requireAdmin(user, admin);
  const tripId = requiredText(payload, 'tripId');
  const header = await getTripHeader(tripId);
  if (!header) return { deletedCount: 0 };
  await upsertTripTombstone(tripId, header.device_id, user.id);
  const { error, count } = await adminClient
    .from('trip_headers')
    .delete({ count: 'exact' })
    .eq('trip_id', tripId);
  if (error) throw new HttpError(500, `Trip delete failed: ${error.message}`);
  return { deletedCount: count ?? 0 };
}

async function deleteOwnTrip(payload: JsonRecord, user: TracklogUser, admin: boolean) {
  const tripId = requiredText(payload, 'tripId');
  const header = await getTripHeader(tripId);
  if (!header) return { deletedCount: 0 };

  if (!admin) {
    const profile = await getDeviceProfile(header.device_id);
    if (textValue(profile?.auth_user_id) !== user.id) {
      return { deletedCount: 0 };
    }
  }

  await upsertTripTombstone(tripId, header.device_id, user.id);
  const { error, count } = await adminClient
    .from('trip_headers')
    .delete({ count: 'exact' })
    .eq('trip_id', tripId)
    .eq('device_id', header.device_id);
  if (error) throw new HttpError(500, `Own trip delete failed: ${error.message}`);
  return { deletedCount: count ?? 0 };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
  }

  try {
    const payload = await req.json() as JsonRecord;
    const action = textValue(payload.action);
    const user = await requireUser(req);
    const admin = await isTracklogAdmin(user);

    let data: unknown;
    if (action === 'getRuntimeConfig') data = await getRuntimeConfig();
    else if (action === 'updateRuntimeConfig') data = await updateRuntimeConfig(payload, user, admin);
    else if (action === 'registerPushToken') data = await registerPushToken(payload, user, admin);
    else if (action === 'unregisterPushToken') data = await unregisterPushToken(payload, user, admin);
    else if (action === 'sendAdminMessage') data = await sendAdminMessage(payload, user, admin);
    else if (action === 'listPendingAdminMessages') data = await listPendingAdminMessages(payload, user, admin);
    else if (action === 'ackAdminMessages') data = await ackAdminMessages(payload, user, admin);
    else if (action === 'claimDeviceProfile') data = await claimDeviceProfile(payload, user, admin);
    else if (action === 'updateDeviceLocation') data = await updateDeviceLocation(payload, user, admin);
    else if (action === 'migrateDeviceRecords') data = await migrateDeviceRecords(payload, user, admin);
    else if (action === 'setDeviceApproval') data = await setDeviceApproval(payload, user, admin);
    else if (action === 'deleteDevice') data = await deleteDevice(payload, user, admin);
    else if (action === 'deleteTrip') data = await deleteTrip(payload, user, admin);
    else if (action === 'deleteOwnTrip') data = await deleteOwnTrip(payload, user, admin);
    else throw new HttpError(400, 'Unknown action');

    return jsonResponse({ ok: true, data });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : 'Unexpected function error';
    console.error('[tracklog-privileged]', status, message);
    return jsonResponse({ ok: false, error: message }, status);
  }
});
