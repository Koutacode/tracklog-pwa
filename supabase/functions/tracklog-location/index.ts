import { createClient } from 'npm:@supabase/supabase-js@2.58.0';
import {
  isLocationUploadThrottled,
  isValidCoordinate,
  LOCATION_UPLOAD_INTERVAL_MS,
} from './policy.ts';

type JsonRecord = Record<string, unknown>;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const adminClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function response(body: JsonRecord, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function requiredText(value: unknown, maxLength: number) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maxLength) throw new HttpError(400, 'Invalid deviceId');
  return normalized;
}

function optionalAccuracy(value: unknown) {
  if (value == null) return null;
  const accuracy = Number(value);
  if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100_000) {
    throw new HttpError(400, 'Invalid accuracy');
  }
  return accuracy;
}

async function requireUser(req: Request) {
  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) {
    throw new HttpError(401, 'Authorization header is required');
  }
  const token = authorization.slice(7).trim();
  const { data, error } = await adminClient.auth.getUser(token);
  if (error || !data.user || data.user.is_anonymous) {
    throw new HttpError(401, 'Authenticated user is required');
  }
  return data.user;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return response({ ok: false, error: 'Method not allowed' }, 405);
  if (!supabaseUrl || !serviceRoleKey) {
    return response({ ok: false, error: 'Function environment is not configured' }, 500);
  }

  try {
    const user = await requireUser(req);
    const payload = record(await req.json());
    const deviceId = requiredText(payload.deviceId, 200);
    if (!isValidCoordinate(payload.lat, -90, 90) || !isValidCoordinate(payload.lng, -180, 180)) {
      throw new HttpError(400, 'Invalid coordinates');
    }
    const lat = Number(payload.lat);
    const lng = Number(payload.lng);
    const accuracy = optionalAccuracy(payload.accuracy);

    const { data: profile, error: profileError } = await adminClient
      .from('device_profiles')
      .select('device_id, auth_user_id, approval_status, latest_location_at')
      .eq('device_id', deviceId)
      .maybeSingle();
    if (profileError) throw new HttpError(500, profileError.message);
    if (!profile || profile.auth_user_id !== user.id) {
      throw new HttpError(403, 'Device is not assigned to this account');
    }
    if (profile.approval_status !== 'approved') {
      throw new HttpError(403, 'Device is not approved');
    }

    const now = new Date();
    if (isLocationUploadThrottled(profile.latest_location_at, now.getTime())) {
      return response({ ok: true, throttled: true, retryAfterMs: LOCATION_UPLOAD_INTERVAL_MS });
    }
    const cutoff = new Date(now.getTime() - LOCATION_UPLOAD_INTERVAL_MS).toISOString();
    const timestamp = now.toISOString();
    const { data: updated, error: updateError } = await adminClient
      .from('device_profiles')
      .update({
        latest_lat: lat,
        latest_lng: lng,
        latest_accuracy: accuracy,
        latest_location_at: timestamp,
        last_seen_at: timestamp,
      })
      .eq('device_id', deviceId)
      .eq('auth_user_id', user.id)
      .eq('approval_status', 'approved')
      .or(`latest_location_at.is.null,latest_location_at.lt.${cutoff}`)
      .select('device_id, latest_location_at')
      .maybeSingle();
    if (updateError) throw new HttpError(500, updateError.message);
    if (!updated) {
      return response({ ok: true, throttled: true, retryAfterMs: LOCATION_UPLOAD_INTERVAL_MS });
    }
    return response({ ok: true, throttled: false, latestLocationAt: updated.latest_location_at });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : 'Latest location update failed';
    console.error('[tracklog-location]', status, message);
    return response({ ok: false, error: message }, status);
  }
});
