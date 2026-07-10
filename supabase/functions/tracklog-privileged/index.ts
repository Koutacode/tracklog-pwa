import { createClient } from 'npm:@supabase/supabase-js@2.58.0';
// @ts-types="npm:@types/web-push@3.6.4"
import webPush from 'npm:web-push@3.6.7';

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
const FIREBASE_PROJECT_ID_ENV = Deno.env.get('FIREBASE_PROJECT_ID') ?? '';
const FIREBASE_CLIENT_EMAIL_ENV = Deno.env.get('FIREBASE_CLIENT_EMAIL') ?? '';
const FIREBASE_PRIVATE_KEY_ENV = (Deno.env.get('FIREBASE_PRIVATE_KEY') ?? '').replace(/\\n/g, '\n');
const FIREBASE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FIREBASE_MESSAGING_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const FIREBASE_PROJECT_ID_SECRET_KEY = 'firebase_project_id';
const FIREBASE_CLIENT_EMAIL_SECRET_KEY = 'firebase_client_email';
const FIREBASE_PRIVATE_KEY_SECRET_KEY = 'firebase_private_key';
const FIREBASE_CREDENTIALS_CACHE_MS = 5 * 60 * 1000;
const WEB_PUSH_VAPID_PUBLIC_KEY_SECRET_KEY = 'web_push_vapid_public_key';
const WEB_PUSH_VAPID_PRIVATE_KEY_SECRET_KEY = 'web_push_vapid_private_key';
const WEB_PUSH_VAPID_SUBJECT = 'https://tracklog-assist.pages.dev';
const WEB_PUSH_CREDENTIALS_CACHE_MS = 5 * 60 * 1000;
const PUSH_PROVIDER_FCM = 'fcm';
const PUSH_PROVIDER_WEBPUSH = 'webpush';
const MAX_PUSH_FAILURES = 3;
const FULLWIDTH_DIGIT_OFFSET = '０'.charCodeAt(0) - '0'.charCodeAt(0);
const VEHICLE_LABEL_PATTERN = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z]{1,8}[0-9]{2,3}[ぁ-んA-Za-z][0-9]{1,4}$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type FirebaseCredentials = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
};

type WebPushCredentials = {
  publicKey: string;
  privateKey: string;
};

type StandardWebPushSubscription = {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    auth: string;
    p256dh: string;
  };
};

let firebaseCredentialsCache: { credentials: FirebaseCredentials | null; loadedAt: number } | null = null;
let firebaseAccessToken: { token: string; expiresAt: number; cacheKey: string } | null = null;
let firebasePrivateKey: { key: CryptoKey; cacheKey: string } | null = null;
let webPushCredentialsCache: { credentials: WebPushCredentials | null; loadedAt: number } | null = null;

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

function toHalfWidthDigits(value: string) {
  return value.replace(/[０-９]/g, digit =>
    String.fromCharCode(digit.charCodeAt(0) - FULLWIDTH_DIGIT_OFFSET),
  );
}

function normalizeDisplayName(value: unknown) {
  return textValue(value).replace(/\s+/g, ' ');
}

function normalizeEmail(value: unknown) {
  return textValue(value);
}

function sameEmailAddress(left: unknown, right: unknown) {
  return normalizeEmail(left).toLowerCase() === normalizeEmail(right).toLowerCase();
}

function normalizePhone(value: unknown) {
  return toHalfWidthDigits(textValue(value))
    .replace(/[＋]/g, '+')
    .replace(/[ー－―‐]/g, '-')
    .replace(/[　]/g, ' ');
}

function normalizeVehicleLabel(value: unknown) {
  return toHalfWidthDigits(textValue(value))
    .replace(/[　\s\-ー－―‐]/g, '');
}

function compactPhone(value: string) {
  return value.replace(/[()\s.-]/g, '');
}

function validateDriverProfileFields(input: {
  displayName: string;
  vehicleLabel: string;
  driverPhone: string;
  driverEmail: string;
  userEmail: string;
}) {
  if (!input.displayName || input.displayName.length > 40) {
    throw new HttpError(400, '名前を確認してください');
  }
  if (!input.driverEmail || input.driverEmail.length > 254 || !EMAIL_PATTERN.test(input.driverEmail)) {
    throw new HttpError(400, 'メールアドレスの形式を確認してください');
  }
  if (!sameEmailAddress(input.driverEmail, input.userEmail)) {
    throw new HttpError(403, 'メール認証済みのアドレスと登録メールが一致しません');
  }
  const phone = compactPhone(input.driverPhone);
  if (!(/^0\d{9,10}$/.test(phone) || /^\+81\d{9,10}$/.test(phone))) {
    throw new HttpError(400, '電話番号を確認してください');
  }
  if (!input.vehicleLabel || input.vehicleLabel.length > 24 || !VEHICLE_LABEL_PATTERN.test(input.vehicleLabel)) {
    throw new HttpError(400, '車番は 札幌101か8916 の形式で入力してください');
  }
}

function stringArray(value: unknown, key: string) {
  if (!Array.isArray(value)) throw new HttpError(400, `${key} must be an array`);
  const items = value
    .map(item => textValue(item))
    .filter(item => item.length > 0);
  if (items.length === 0) throw new HttpError(400, `${key} is required`);
  return Array.from(new Set(items)).slice(0, 50);
}

function isCompleteFirebaseCredentials(credentials: FirebaseCredentials | null | undefined): credentials is FirebaseCredentials {
  return !!(credentials?.projectId && credentials.clientEmail && credentials.privateKey);
}

function getEnvFirebaseCredentials(): FirebaseCredentials | null {
  const credentials = {
    projectId: FIREBASE_PROJECT_ID_ENV,
    clientEmail: FIREBASE_CLIENT_EMAIL_ENV,
    privateKey: FIREBASE_PRIVATE_KEY_ENV,
  };
  return isCompleteFirebaseCredentials(credentials) ? credentials : null;
}

function firebaseCredentialsCacheKey(credentials: FirebaseCredentials) {
  return `${credentials.projectId}|${credentials.clientEmail}|${credentials.privateKey}`;
}

async function getFirebaseCredentials(): Promise<FirebaseCredentials | null> {
  const envCredentials = getEnvFirebaseCredentials();
  if (envCredentials) return envCredentials;

  if (firebaseCredentialsCache && Date.now() - firebaseCredentialsCache.loadedAt < FIREBASE_CREDENTIALS_CACHE_MS) {
    return firebaseCredentialsCache.credentials;
  }

  const { data, error } = await adminClient
    .from('tracklog_server_secrets')
    .select('key, value')
    .in('key', [
      FIREBASE_PROJECT_ID_SECRET_KEY,
      FIREBASE_CLIENT_EMAIL_SECRET_KEY,
      FIREBASE_PRIVATE_KEY_SECRET_KEY,
    ]);
  if (error) {
    console.warn('[tracklog-privileged] Firebase FCM server secret lookup failed', error.message);
    firebaseCredentialsCache = { credentials: null, loadedAt: Date.now() };
    return null;
  }

  const values = new Map(
    ((data ?? []) as JsonRecord[]).map(row => [textValue(row.key), textValue(row.value)]),
  );
  const credentials = {
    projectId: values.get(FIREBASE_PROJECT_ID_SECRET_KEY) ?? '',
    clientEmail: values.get(FIREBASE_CLIENT_EMAIL_SECRET_KEY) ?? '',
    privateKey: (values.get(FIREBASE_PRIVATE_KEY_SECRET_KEY) ?? '').replace(/\\n/g, '\n'),
  };
  firebaseCredentialsCache = {
    credentials: isCompleteFirebaseCredentials(credentials) ? credentials : null,
    loadedAt: Date.now(),
  };
  return firebaseCredentialsCache.credentials;
}

async function isFcmConfigured() {
  return isCompleteFirebaseCredentials(await getFirebaseCredentials());
}

function isCompleteWebPushCredentials(
  credentials: WebPushCredentials | null | undefined,
): credentials is WebPushCredentials {
  return !!(credentials?.publicKey && credentials.privateKey);
}

async function getWebPushCredentials(): Promise<WebPushCredentials | null> {
  if (
    webPushCredentialsCache &&
    Date.now() - webPushCredentialsCache.loadedAt < WEB_PUSH_CREDENTIALS_CACHE_MS
  ) {
    return webPushCredentialsCache.credentials;
  }

  const { data, error } = await adminClient
    .from('tracklog_server_secrets')
    .select('key, value')
    .in('key', [
      WEB_PUSH_VAPID_PUBLIC_KEY_SECRET_KEY,
      WEB_PUSH_VAPID_PRIVATE_KEY_SECRET_KEY,
    ]);
  if (error) {
    console.warn('[tracklog-privileged] Web Push server secret lookup failed', error.message);
    webPushCredentialsCache = { credentials: null, loadedAt: Date.now() };
    return null;
  }

  const values = new Map(
    ((data ?? []) as JsonRecord[]).map(row => [textValue(row.key), textValue(row.value)]),
  );
  const credentials = {
    publicKey: values.get(WEB_PUSH_VAPID_PUBLIC_KEY_SECRET_KEY) ?? '',
    privateKey: values.get(WEB_PUSH_VAPID_PRIVATE_KEY_SECRET_KEY) ?? '',
  };
  webPushCredentialsCache = {
    credentials: isCompleteWebPushCredentials(credentials) ? credentials : null,
    loadedAt: Date.now(),
  };
  return webPushCredentialsCache.credentials;
}

async function isWebPushConfigured() {
  return isCompleteWebPushCredentials(await getWebPushCredentials());
}

function normalizePushProvider(value: unknown) {
  const provider = textValue(value).toLowerCase() || PUSH_PROVIDER_FCM;
  if (provider !== PUSH_PROVIDER_FCM && provider !== PUSH_PROVIDER_WEBPUSH) {
    throw new HttpError(400, 'provider must be fcm or webpush');
  }
  return provider;
}

function normalizePushPlatform(value: unknown) {
  const platform = textValue(value).toLowerCase();
  if (platform !== 'android' && platform !== 'web') {
    throw new HttpError(400, 'platform must be android or web');
  }
  return platform;
}

function parseCanonicalIpv4Literal(hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(part => Number(part));
  return octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
}

function isBlockedIpv4Literal(octets: number[]) {
  const [first, second] = octets;
  return first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

function parseIpv6Literal(hostname: string): number[] | null {
  const literal = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (!literal.includes(':') || literal.includes('%')) return null;

  const compressionIndex = literal.indexOf('::');
  if (compressionIndex !== -1 && compressionIndex !== literal.lastIndexOf('::')) return null;
  const leftText = compressionIndex === -1 ? literal : literal.slice(0, compressionIndex);
  const rightText = compressionIndex === -1 ? '' : literal.slice(compressionIndex + 2);
  const parseSide = (value: string) => {
    if (!value) return [] as number[];
    const parts = value.split(':');
    if (parts.some(part => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
    return parts.map(part => Number.parseInt(part, 16));
  };
  const left = parseSide(leftText);
  const right = parseSide(rightText);
  if (!left || !right) return null;

  if (compressionIndex === -1) return left.length === 8 ? left : null;
  const omittedCount = 8 - left.length - right.length;
  if (omittedCount < 1) return null;
  return [...left, ...Array<number>(omittedCount).fill(0), ...right];
}

function isBlockedIpv6Literal(segments: number[]) {
  const isUnspecified = segments.every(segment => segment === 0);
  const isLoopback = segments.slice(0, 7).every(segment => segment === 0) && segments[7] === 1;
  const isLinkLocal = (segments[0] & 0xffc0) === 0xfe80;
  const isUniqueLocal = (segments[0] & 0xfe00) === 0xfc00;
  if (isUnspecified || isLoopback || isLinkLocal || isUniqueLocal) return true;

  const hasMappedIpv4 = segments.slice(0, 5).every(segment => segment === 0) &&
    segments[5] === 0xffff;
  const hasCompatibleIpv4 = segments.slice(0, 6).every(segment => segment === 0);
  if (!hasMappedIpv4 && !hasCompatibleIpv4) return false;
  return isBlockedIpv4Literal([
    segments[6] >> 8,
    segments[6] & 0xff,
    segments[7] >> 8,
    segments[7] & 0xff,
  ]);
}

function validateWebPushEndpoint(endpoint: string) {
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new HttpError(400, 'subscription endpoint must be a valid HTTPS URL');
  }
  if (endpointUrl.protocol !== 'https:') {
    throw new HttpError(400, 'subscription endpoint must use HTTPS');
  }
  const authority = endpoint.match(/^https:\/\/([^/?#]*)/i)?.[1] ?? '';
  if (endpointUrl.username || endpointUrl.password || authority.includes('@')) {
    throw new HttpError(400, 'subscription endpoint must not include user information');
  }
  if (endpointUrl.port) {
    throw new HttpError(400, 'subscription endpoint must use the standard HTTPS port');
  }

  const hostname = endpointUrl.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
  if (!hostname) throw new HttpError(400, 'subscription endpoint host is invalid');

  const ipv4 = parseCanonicalIpv4Literal(hostname);
  if (ipv4) {
    if (isBlockedIpv4Literal(ipv4)) {
      throw new HttpError(400, 'subscription endpoint must not target a private network');
    }
    return;
  }

  if (hostname.includes(':')) {
    const ipv6 = parseIpv6Literal(hostname);
    if (!ipv6) throw new HttpError(400, 'subscription endpoint host is invalid');
    if (isBlockedIpv6Literal(ipv6)) {
      throw new HttpError(400, 'subscription endpoint must not target a private network');
    }
    return;
  }

  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    !hostname.includes('.') ||
    hostname.endsWith('.local')
  ) {
    throw new HttpError(400, 'subscription endpoint must use a public host');
  }
}

function normalizeWebPushSubscription(value: unknown): StandardWebPushSubscription {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'subscription must be an object');
  }
  const raw = value as JsonRecord;
  const endpoint = textValue(raw.endpoint);
  if (!endpoint || endpoint.length > 4096) {
    throw new HttpError(400, 'subscription endpoint is invalid');
  }
  validateWebPushEndpoint(endpoint);

  const rawKeys = raw.keys;
  if (!rawKeys || typeof rawKeys !== 'object' || Array.isArray(rawKeys)) {
    throw new HttpError(400, 'subscription keys are required');
  }
  const keys = rawKeys as JsonRecord;
  const auth = textValue(keys.auth);
  const p256dh = textValue(keys.p256dh);
  const base64UrlPattern = /^[A-Za-z0-9_-]+={0,2}$/;
  if (!auth || auth.length > 512 || !base64UrlPattern.test(auth)) {
    throw new HttpError(400, 'subscription auth key is invalid');
  }
  if (!p256dh || p256dh.length > 1024 || !base64UrlPattern.test(p256dh)) {
    throw new HttpError(400, 'subscription p256dh key is invalid');
  }

  const rawExpirationTime = raw.expirationTime;
  const expirationTime = rawExpirationTime == null
    ? null
    : typeof rawExpirationTime === 'number' && Number.isFinite(rawExpirationTime) && rawExpirationTime >= 0
      ? rawExpirationTime
      : null;
  if (rawExpirationTime != null && expirationTime == null) {
    throw new HttpError(400, 'subscription expirationTime is invalid');
  }

  return {
    endpoint,
    expirationTime,
    keys: { auth, p256dh },
  };
}

function webPushSubscriptionToken(subscription: StandardWebPushSubscription) {
  return JSON.stringify(subscription);
}

function parseStoredWebPushSubscription(value: unknown) {
  try {
    return normalizeWebPushSubscription(JSON.parse(textValue(value)));
  } catch {
    throw Object.assign(new Error('Stored Web Push subscription is invalid'), { permanent: true });
  }
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

async function getFirebasePrivateKey(credentials: FirebaseCredentials) {
  const cacheKey = firebaseCredentialsCacheKey(credentials);
  if (!firebasePrivateKey || firebasePrivateKey.cacheKey !== cacheKey) {
    const key = await crypto.subtle.importKey(
      'pkcs8',
      pemToArrayBuffer(credentials.privateKey),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    firebasePrivateKey = { key, cacheKey };
  }
  return firebasePrivateKey.key;
}

async function signFirebaseJwt(credentials: FirebaseCredentials) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: credentials.clientEmail,
    sub: credentials.clientEmail,
    aud: FIREBASE_TOKEN_URL,
    scope: FIREBASE_MESSAGING_SCOPE,
    iat: issuedAt,
    exp: issuedAt + 3600,
  };
  const input = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claim))}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    await getFirebasePrivateKey(credentials),
    new TextEncoder().encode(input),
  );
  return `${input}.${base64UrlEncode(signature)}`;
}

async function getFirebaseAccessToken(credentials: FirebaseCredentials) {
  if (!isCompleteFirebaseCredentials(credentials)) {
    throw new Error('Firebase FCM secrets are not configured');
  }
  const cacheKey = firebaseCredentialsCacheKey(credentials);
  if (
    firebaseAccessToken &&
    firebaseAccessToken.cacheKey === cacheKey &&
    firebaseAccessToken.expiresAt - Date.now() > 60_000
  ) {
    return firebaseAccessToken.token;
  }

  const assertion = await signFirebaseJwt(credentials);
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
    cacheKey,
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
  const email = normalizeEmail(user.email);
  if (!email) return false;
  const { data, error } = await adminClient
    .from('admin_users')
    .select('email')
    .eq('enabled', true);
  if (error) throw new HttpError(500, `Admin check failed: ${error.message}`);
  return (data ?? []).some(row => sameEmailAddress((row as JsonRecord).email, email));
}

function getAdminAccessState(user: TracklogUser, admin: boolean) {
  return {
    email: nullableText(user.email),
    isAdmin: admin,
  };
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
  const nextDisplayName =
    normalizeDisplayName(payload.displayName) ||
    normalizeDisplayName(existing?.display_name) ||
    `端末-${deviceId.replace(/[^a-zA-Z0-9]/g, '').slice(-8)}`;
  const nextVehicleLabel = normalizeVehicleLabel(payload.vehicleLabel) || normalizeVehicleLabel(existing?.vehicle_label);
  const nextDriverPhone = normalizePhone(payload.driverPhone) || normalizePhone(existing?.driver_phone);
  const nextDriverEmail = normalizeEmail(payload.driverEmail) || normalizeEmail(existing?.driver_email) || normalizeEmail(user.email);
  if (approvalStatus !== 'approved') {
    validateDriverProfileFields({
      displayName: nextDisplayName,
      vehicleLabel: nextVehicleLabel,
      driverPhone: nextDriverPhone,
      driverEmail: nextDriverEmail,
      userEmail: normalizeEmail(user.email),
    });
  }
  const row = {
    device_id: deviceId,
    auth_user_id: user.id,
    display_name: nextDisplayName,
    vehicle_label: nextVehicleLabel || null,
    driver_phone: nextDriverPhone || null,
    driver_email: nextDriverEmail || null,
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

async function migrateDeviceRecords(payload: JsonRecord, user: TracklogUser, _admin: boolean) {
  const oldDeviceId = textValue(payload.oldDeviceId);
  const newDeviceId = textValue(payload.newDeviceId);
  if (!oldDeviceId || !newDeviceId || oldDeviceId === newDeviceId) return { migrated: false };

  const { error } = await adminClient.rpc('tracklog_migrate_device_v2', {
    _actor_user_id: user.id,
    _old_device_id: oldDeviceId,
    _new_device_id: newDeviceId,
  });
  if (error) {
    const status = error.code === '42501' ? 403 : 500;
    throw new HttpError(status, `Device migration failed: ${error.message}`);
  }
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

async function requireApprovedPushDevice(
  payload: JsonRecord,
  user: TracklogUser,
  admin: boolean,
) {
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
  return deviceId;
}

async function getWebPushConfig(payload: JsonRecord, user: TracklogUser, admin: boolean) {
  await requireApprovedPushDevice(payload, user, admin);
  const credentials = await getWebPushCredentials();
  if (!isCompleteWebPushCredentials(credentials)) {
    throw new HttpError(503, 'Standard Web Push is not configured');
  }
  return { publicVapidKey: credentials.publicKey };
}

async function registerPushToken(payload: JsonRecord, user: TracklogUser, admin: boolean) {
  const deviceId = await requireApprovedPushDevice(payload, user, admin);
  const provider = normalizePushProvider(payload.provider);
  const platform = normalizePushPlatform(payload.platform);
  if (provider === PUSH_PROVIDER_WEBPUSH && platform !== 'web') {
    throw new HttpError(400, 'webpush registrations must use the web platform');
  }
  const token = provider === PUSH_PROVIDER_WEBPUSH
    ? webPushSubscriptionToken(normalizeWebPushSubscription(payload.subscription))
    : requiredText(payload, 'token');

  const now = nowIso();
  const tokenHash = await sha256Hex(token);
  const { data, error } = await adminClient
    .from('tracklog_push_registrations')
    .upsert({
      device_id: deviceId,
      auth_user_id: user.id,
      provider,
      platform,
      token,
      token_hash: tokenHash,
      enabled: true,
      failure_count: 0,
      last_error: null,
      updated_at: now,
      last_seen_at: now,
    }, { onConflict: 'provider,token_hash' })
    .select('id, device_id, platform, provider, enabled, updated_at, last_seen_at')
    .single();
  if (error) throw new HttpError(500, `Push token registration failed: ${error.message}`);
  return {
    ...data,
    pushConfigured: provider === PUSH_PROVIDER_WEBPUSH
      ? await isWebPushConfigured()
      : await isFcmConfigured(),
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
    body: textValue(message.body),
    requestLocation: requestLocation ? 'true' : 'false',
    sentAt: textValue(message.sent_at),
  };
}

function getPwaLinkForMessage(message: JsonRecord) {
  const params = new URLSearchParams({
    messageId: textValue(message.id),
    tracklogPushMessageId: textValue(message.id),
    tracklogRequestLocation: booleanValue(message.request_location, true) ? '1' : '0',
    tracklogPushBody: textValue(message.body),
    tracklogPushSentAt: textValue(message.sent_at),
  });
  return `https://tracklog-assist.pages.dev/messages?${params.toString()}`;
}

async function sendFcmMessage(registration: JsonRecord, message: JsonRecord, credentials: FirebaseCredentials) {
  const token = textValue(registration.token);
  const platform = textValue(registration.platform);
  if (!token) throw new Error('Push token is empty');
  const accessToken = await getFirebaseAccessToken(credentials);
  const data = getAdminPushData(message);
  const body = textValue(message.body);
  const resp = await fetch(`https://fcm.googleapis.com/v1/projects/${credentials.projectId}/messages:send`, {
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

async function sendWebPushMessage(
  registration: JsonRecord,
  message: JsonRecord,
  credentials: WebPushCredentials,
) {
  const subscription = parseStoredWebPushSubscription(registration.token);
  const data = getAdminPushData(message);
  const payload = JSON.stringify({
    notification: {
      title: 'TrackLog',
      body: textValue(message.body),
      data,
    },
  });

  try {
    const response = await webPush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: subscription.keys,
      },
      payload,
      {
        TTL: 3600,
        urgency: 'high',
        vapidDetails: {
          subject: WEB_PUSH_VAPID_SUBJECT,
          publicKey: credentials.publicKey,
          privateKey: credentials.privateKey,
        },
      },
    );
    return response.statusCode;
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : null;
    throw Object.assign(
      new Error(statusCode == null ? 'Web Push delivery failed' : `Web Push HTTP ${statusCode}`),
      {
        permanent: statusCode === 404 || statusCode === 410,
        responseStatus: statusCode,
      },
    );
  }
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
  const [firebaseCredentials, webPushCredentials] = await Promise.all([
    getFirebaseCredentials(),
    getWebPushCredentials(),
  ]);
  const fcmConfigured = isCompleteFirebaseCredentials(firebaseCredentials);
  const webPushConfigured = isCompleteWebPushCredentials(webPushCredentials);
  const configured = fcmConfigured || webPushConfigured;
  if (!configured) {
    console.warn('[tracklog-privileged] Push server secrets are not configured; admin message will be delivered by polling only.');
    return { configured: false, attempted: 0, sent: 0, failed: 0 };
  }

  const targetDeviceIds = await getPushTargetDeviceIds(nullableText(message.target_device_id));
  if (targetDeviceIds.length === 0) return { configured, attempted: 0, sent: 0, failed: 0 };

  const { data, error } = await adminClient
    .from('tracklog_push_registrations')
    .select('id, device_id, provider, platform, token, failure_count')
    .in('provider', [PUSH_PROVIDER_FCM, PUSH_PROVIDER_WEBPUSH])
    .eq('enabled', true)
    .in('device_id', targetDeviceIds)
    .limit(1000);
  if (error) throw new Error(`Push token lookup failed: ${error.message}`);

  let attempted = 0;
  let sent = 0;
  let failed = 0;
  for (const registration of (data ?? []) as JsonRecord[]) {
    const provider = textValue(registration.provider);
    if (provider === PUSH_PROVIDER_FCM && !fcmConfigured) continue;
    if (provider === PUSH_PROVIDER_WEBPUSH && !webPushConfigured) continue;
    try {
      attempted += 1;
      if (provider === PUSH_PROVIDER_FCM && firebaseCredentials) {
        await sendFcmMessage(registration, message, firebaseCredentials);
      } else if (provider === PUSH_PROVIDER_WEBPUSH && webPushCredentials) {
        await sendWebPushMessage(registration, message, webPushCredentials);
      } else {
        continue;
      }
      sent += 1;
      await markPushDelivered(textValue(registration.id));
    } catch (pushError) {
      failed += 1;
      const errorMessage = pushError instanceof Error ? pushError.message : 'Push delivery failed';
      console.error(`[tracklog-privileged] ${provider || 'unknown'} delivery failed`, errorMessage);
      await markPushFailed(registration, pushError);
    }
  }
  return { configured, attempted, sent, failed };
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
  const pushDelivery = await sendPushForAdminMessage(data as JsonRecord).catch(async pushError => {
    console.error('[tracklog-privileged] Admin message push delivery failed', pushError);
    const [firebaseCredentials, webPushCredentials] = await Promise.all([
      getFirebaseCredentials().catch(() => null),
      getWebPushCredentials().catch(() => null),
    ]);
    return {
      configured:
        isCompleteFirebaseCredentials(firebaseCredentials) ||
        isCompleteWebPushCredentials(webPushCredentials),
      attempted: 0,
      sent: 0,
      failed: 1,
      error: 'push delivery failed',
    };
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
  if (error?.code === '23503') {
    const hiddenAt = nowIso();
    const { error: hideError } = await adminClient
      .from('device_profiles')
      .update({
        platform: 'admin_hidden',
        latest_status: '管理画面で非表示',
        latest_trip_id: null,
        latest_lat: null,
        latest_lng: null,
        latest_accuracy: null,
        latest_location_at: null,
        approval_status: 'rejected',
        approval_decided_at: hiddenAt,
        approval_decided_by: user.id,
        last_seen_at: hiddenAt,
      })
      .eq('device_id', deviceId);
    if (hideError) throw new HttpError(500, `Device hide failed: ${hideError.message}`);
    const { error: pushError } = await adminClient
      .from('tracklog_push_registrations')
      .update({ enabled: false, updated_at: hiddenAt })
      .eq('device_id', deviceId);
    if (pushError) throw new HttpError(500, `Device push disable failed: ${pushError.message}`);
    return { deletedCount: 0, hidden: true };
  }
  if (error) throw new HttpError(500, `Device delete failed: ${error.message}`);
  return { deletedCount: count ?? 0, hidden: false };
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
  const { data, error } = await adminClient.rpc('tracklog_admin_delete_trip_v2', {
    _actor_user_id: user.id,
    _trip_id: tripId,
  });
  if (error) throw new HttpError(500, `Trip delete failed: ${error.message}`);
  return { deletedCount: Number(data ?? 0) };
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
  return { deletedCount: 1 };
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
    if (action === 'getAdminAccessState') data = getAdminAccessState(user, admin);
    else if (action === 'getRuntimeConfig') data = await getRuntimeConfig();
    else if (action === 'getWebPushConfig') data = await getWebPushConfig(payload, user, admin);
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
