import type { SupabaseClient } from '@supabase/supabase-js';
import type { RemoteDeviceProfile } from '../domain/remoteTypes';
import { SUPABASE_CONFIGURED, adminSupabase, driverSupabase } from './supabase';

type FunctionResponse<T> = {
  ok?: boolean;
  data?: T;
  error?: string;
};

type PrivilegedAction =
  | 'claimDeviceProfile'
  | 'migrateDeviceRecords'
  | 'setDeviceApproval'
  | 'deleteDevice'
  | 'deleteTrip'
  | 'deleteOwnTrip';

function requireClient(client: SupabaseClient | null) {
  if (!SUPABASE_CONFIGURED || !client) {
    throw new Error('Supabase が未設定です');
  }
  return client;
}

async function invokeTracklogPrivileged<T>(
  client: SupabaseClient,
  action: PrivilegedAction,
  payload: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await client.functions.invoke<FunctionResponse<T>>('tracklog-privileged', {
    body: {
      action,
      ...payload,
    },
  });
  if (error) {
    throw new Error(error.message || 'TrackLog サーバー処理に失敗しました');
  }
  if (!data?.ok) {
    throw new Error(data?.error || 'TrackLog サーバー処理に失敗しました');
  }
  return data.data as T;
}

export async function claimTracklogDeviceProfileViaFunction(input: {
  deviceId: string;
  displayName?: string | null;
  vehicleLabel?: string | null;
  driverPhone?: string | null;
  driverEmail?: string | null;
  platform: string;
  appVersion: string;
  latestStatus?: string | null;
  latestTripId?: string | null;
  latestLat?: number | null;
  latestLng?: number | null;
  latestAccuracy?: number | null;
  lastSeenAt: string;
}): Promise<RemoteDeviceProfile> {
  const client = requireClient(driverSupabase);
  return invokeTracklogPrivileged<RemoteDeviceProfile>(client, 'claimDeviceProfile', input);
}

export async function migrateTracklogDeviceRecordsViaFunction(input: {
  oldDeviceId: string;
  newDeviceId: string;
}): Promise<void> {
  const client = requireClient(driverSupabase);
  await invokeTracklogPrivileged<{ migrated: boolean }>(client, 'migrateDeviceRecords', input);
}

export async function setTracklogDeviceApprovalViaFunction(input: {
  deviceId: string;
  approvalStatus: 'approved' | 'rejected';
}): Promise<RemoteDeviceProfile> {
  const client = requireClient(adminSupabase);
  return invokeTracklogPrivileged<RemoteDeviceProfile>(client, 'setDeviceApproval', input);
}

export async function deleteTracklogDeviceViaFunction(deviceId: string): Promise<number> {
  const client = requireClient(adminSupabase);
  const result = await invokeTracklogPrivileged<{ deletedCount: number }>(client, 'deleteDevice', { deviceId });
  return result.deletedCount;
}

export async function deleteTracklogTripViaFunction(tripId: string): Promise<number> {
  const client = requireClient(adminSupabase);
  const result = await invokeTracklogPrivileged<{ deletedCount: number }>(client, 'deleteTrip', { tripId });
  return result.deletedCount;
}

export async function deleteOwnTracklogTripViaFunction(tripId: string): Promise<number> {
  const client = requireClient(driverSupabase);
  const result = await invokeTracklogPrivileged<{ deletedCount: number }>(client, 'deleteOwnTrip', { tripId });
  return result.deletedCount;
}
