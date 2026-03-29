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

function assertAdminConfigured() {
  if (!SUPABASE_CONFIGURED || !adminSupabase) {
    throw new Error('Supabase が未設定です');
  }
  return adminSupabase;
}

export async function listAdminDevices(): Promise<RemoteDeviceProfile[]> {
  const client = assertAdminConfigured();
  const { data, error } = await client
    .from('device_profiles')
    .select('*')
    .order('last_seen_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as RemoteDeviceProfile[];
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

