import type {
  RemoteDeviceProfile,
  RemoteReportSnapshot,
  RemoteRoutePoint,
  RemoteTripEvent,
  RemoteTripHeader,
} from '../domain/remoteTypes';
import { adminSupabase, SUPABASE_CONFIGURED } from './supabase';

export type AdminDeviceBundle = {
  profile: RemoteDeviceProfile | null;
  trips: RemoteTripHeader[];
  recentEvents: RemoteTripEvent[];
  reports: RemoteReportSnapshot[];
};

export type AdminTripBundle = {
  header: RemoteTripHeader | null;
  events: RemoteTripEvent[];
  routePoints: RemoteRoutePoint[];
  report: RemoteReportSnapshot | null;
};

export type DeleteAdminDeviceResult = {
  mode: 'deleted' | 'hidden';
};

const ADMIN_HIDDEN_PLATFORM = 'admin_hidden';
const ADMIN_HIDDEN_STATUS = '管理画面で非表示';

function assertAdminConfigured() {
  if (!SUPABASE_CONFIGURED || !adminSupabase) {
    throw new Error('Supabase が未設定です');
  }
  return adminSupabase;
}

function isMissingDeleteRpc(error: { code?: string; message?: string }) {
  const message = error.message ?? '';
  return error.code === 'PGRST202' || message.includes('delete_tracklog_device');
}

function isHiddenDeviceProfile(profile: RemoteDeviceProfile) {
  return profile.platform === ADMIN_HIDDEN_PLATFORM || profile.latest_status === ADMIN_HIDDEN_STATUS;
}

export async function listAdminDevices(): Promise<RemoteDeviceProfile[]> {
  const client = assertAdminConfigured();
  const { data, error } = await client
    .from('device_profiles')
    .select('*')
    .order('last_seen_at', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as RemoteDeviceProfile[]).filter(profile => !isHiddenDeviceProfile(profile));
}

export async function deleteAdminDevice(deviceId: string): Promise<DeleteAdminDeviceResult> {
  const client = assertAdminConfigured();
  const { error } = await client.rpc('delete_tracklog_device', {
    _device_id: deviceId,
  });
  if (!error) return { mode: 'deleted' };
  if (!isMissingDeleteRpc(error)) throw error;

  const { error: hideError } = await client
    .from('device_profiles')
    .update({
      platform: ADMIN_HIDDEN_PLATFORM,
      latest_status: ADMIN_HIDDEN_STATUS,
      latest_trip_id: null,
      latest_lat: null,
      latest_lng: null,
      latest_accuracy: null,
      last_seen_at: new Date().toISOString(),
    })
    .eq('device_id', deviceId);
  if (hideError) throw hideError;
  return { mode: 'hidden' };
}

export async function getAdminDeviceBundle(deviceId: string): Promise<AdminDeviceBundle> {
  const client = assertAdminConfigured();
  const [profileResult, tripsResult, eventsResult, reportsResult] = await Promise.all([
    client.from('device_profiles').select('*').eq('device_id', deviceId).maybeSingle(),
    client.from('trip_headers').select('*').eq('device_id', deviceId).order('start_ts', { ascending: false }).limit(30),
    client.from('trip_events').select('*').eq('device_id', deviceId).order('ts', { ascending: false }).limit(80),
    client.from('report_snapshots').select('*').eq('device_id', deviceId).order('created_at', { ascending: false }).limit(10),
  ]);
  if (profileResult.error) throw profileResult.error;
  if (tripsResult.error) throw tripsResult.error;
  if (eventsResult.error) throw eventsResult.error;
  if (reportsResult.error) throw reportsResult.error;
  return {
    profile: (profileResult.data as RemoteDeviceProfile | null) ?? null,
    trips: (tripsResult.data ?? []) as RemoteTripHeader[],
    recentEvents: (eventsResult.data ?? []) as RemoteTripEvent[],
    reports: (reportsResult.data ?? []) as RemoteReportSnapshot[],
  };
}

export async function getAdminTripBundle(tripId: string): Promise<AdminTripBundle> {
  const client = assertAdminConfigured();
  const [headerResult, eventsResult, routePointsResult, reportResult] = await Promise.all([
    client.from('trip_headers').select('*').eq('trip_id', tripId).maybeSingle(),
    client.from('trip_events').select('*').eq('trip_id', tripId).order('ts', { ascending: true }),
    client.from('trip_route_points').select('*').eq('trip_id', tripId).order('ts', { ascending: true }),
    client.from('report_snapshots').select('*').eq('trip_id', tripId).maybeSingle(),
  ]);
  if (headerResult.error) throw headerResult.error;
  if (eventsResult.error) throw eventsResult.error;
  if (routePointsResult.error) throw routePointsResult.error;
  if (reportResult.error) throw reportResult.error;
  return {
    header: (headerResult.data as RemoteTripHeader | null) ?? null,
    events: (eventsResult.data ?? []) as RemoteTripEvent[],
    routePoints: (routePointsResult.data ?? []) as RemoteRoutePoint[],
    report: (reportResult.data as RemoteReportSnapshot | null) ?? null,
  };
}
