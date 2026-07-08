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

function requiredText(payload: JsonRecord, key: string) {
  const value = textValue(payload[key]);
  if (!value) throw new HttpError(400, `${key} is required`);
  return value;
}

function nullableNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
    if (action === 'claimDeviceProfile') data = await claimDeviceProfile(payload, user, admin);
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
