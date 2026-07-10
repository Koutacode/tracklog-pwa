import { createClient } from 'npm:@supabase/supabase-js@2.58.0';
import { normalizeRadiusM, OverpassUnavailableError, resolveExpresswayFromOverpass } from './resolver.ts';

type JsonRecord = Record<string, unknown>;

type TracklogUser = {
  id: string;
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
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function requiredText(payload: JsonRecord, key: string) {
  const value = typeof payload[key] === 'string' ? payload[key].trim() : '';
  if (!value || value.length > 200) throw new HttpError(400, `${key} is invalid`);
  return value;
}

function requiredCoordinate(payload: JsonRecord, key: string, min: number, max: number) {
  const value = Number(payload[key]);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new HttpError(400, `${key} is invalid`);
  }
  return value;
}

async function requireUser(req: Request): Promise<TracklogUser> {
  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) {
    throw new HttpError(401, 'Authorization header is required');
  }
  const token = authorization.slice(7).trim();
  if (!token) throw new HttpError(401, 'Bearer token is required');

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authorization } },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data.user) {
    throw new HttpError(401, error?.message ?? 'Invalid auth session');
  }
  const user = data.user as TracklogUser;
  if (user.is_anonymous) {
    throw new HttpError(403, 'Anonymous users cannot resolve IC names');
  }
  return user;
}

async function requireApprovedDevice(deviceId: string, user: TracklogUser) {
  const { data, error } = await adminClient
    .from('device_profiles')
    .select('device_id, auth_user_id, approval_status')
    .eq('device_id', deviceId)
    .maybeSingle();
  if (error) {
    console.error('[tracklog-ic-resolver] device approval lookup failed', error.message);
    throw new HttpError(500, 'Device approval lookup failed');
  }
  if (!data || data.auth_user_id !== user.id) {
    throw new HttpError(403, 'Device is not assigned to this account');
  }
  if (data.approval_status !== 'approved') {
    throw new HttpError(403, 'Device is not approved');
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
  }
  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    return jsonResponse({ ok: false, error: 'Function environment is not configured' }, 500);
  }

  try {
    const payload = await req.json() as JsonRecord;
    const user = await requireUser(req);
    const deviceId = requiredText(payload, 'deviceId');
    await requireApprovedDevice(deviceId, user);

    const lat = requiredCoordinate(payload, 'lat', -90, 90);
    const lon = requiredCoordinate(payload, 'lon', -180, 180);
    const radiusM = normalizeRadiusM(Number(payload.radiusM));
    const data = await resolveExpresswayFromOverpass(lat, lon, radiusM);
    return jsonResponse({ ok: true, data });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : error instanceof OverpassUnavailableError ? 502 : 500;
    const message = error instanceof Error ? error.message : 'Unexpected function error';
    console.error('[tracklog-ic-resolver]', status, message);
    return jsonResponse({ ok: false, error: message }, status);
  }
});
