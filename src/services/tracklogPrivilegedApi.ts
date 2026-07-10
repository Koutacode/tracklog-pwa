import type { SupabaseClient } from '@supabase/supabase-js';
import type { RemoteDeviceProfile, TracklogAdminMessage, TracklogRuntimeConfig } from '../domain/remoteTypes';
import { SUPABASE_CONFIGURED, adminSupabase, driverSupabase } from './supabase';

type FunctionResponse<T> = {
  ok?: boolean;
  data?: T;
  error?: string;
};

export type TracklogWebPushSubscription = {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    auth: string;
    p256dh: string;
  };
};

type PrivilegedAction =
  | 'getAdminAccessState'
  | 'getRuntimeConfig'
  | 'getWebPushConfig'
  | 'updateRuntimeConfig'
  | 'registerPushToken'
  | 'unregisterPushToken'
  | 'sendAdminMessage'
  | 'listPendingAdminMessages'
  | 'ackAdminMessages'
  | 'claimDeviceProfile'
  | 'updateDeviceLocation'
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

export async function getTracklogAdminAccessStateViaFunction(): Promise<{
  email: string | null;
  isAdmin: boolean;
}> {
  const client = requireClient(adminSupabase);
  return invokeTracklogPrivileged<{
    email: string | null;
    isAdmin: boolean;
  }>(client, 'getAdminAccessState', {});
}

export async function getTracklogRuntimeConfigViaFunction(options?: {
  admin?: boolean;
}): Promise<TracklogRuntimeConfig> {
  const client = requireClient(options?.admin ? adminSupabase : driverSupabase);
  return invokeTracklogPrivileged<TracklogRuntimeConfig>(client, 'getRuntimeConfig', {});
}

export async function updateTracklogRuntimeConfigViaFunction(input: {
  locationNotificationText: string;
}): Promise<TracklogRuntimeConfig> {
  const client = requireClient(adminSupabase);
  return invokeTracklogPrivileged<TracklogRuntimeConfig>(client, 'updateRuntimeConfig', input);
}

export async function getTracklogWebPushConfigViaFunction(input: {
  deviceId: string;
}): Promise<{
  publicVapidKey: string;
}> {
  const client = requireClient(driverSupabase);
  return invokeTracklogPrivileged<{ publicVapidKey: string }>(client, 'getWebPushConfig', input);
}

export async function sendTracklogAdminMessageViaFunction(input: {
  targetDeviceId?: string | null;
  body: string;
  requestLocation?: boolean;
}): Promise<TracklogAdminMessage> {
  const client = requireClient(adminSupabase);
  return invokeTracklogPrivileged<TracklogAdminMessage>(client, 'sendAdminMessage', input);
}

export async function registerTracklogPushTokenViaFunction(input: {
  deviceId: string;
  platform: 'android' | 'web';
  provider?: 'fcm';
  token: string;
} | {
  deviceId: string;
  platform: 'web';
  provider: 'webpush';
  subscription: TracklogWebPushSubscription;
}): Promise<{
  id: string;
  device_id: string;
  platform: 'android' | 'web';
  provider: 'fcm' | 'webpush';
  enabled: boolean;
  pushConfigured: boolean;
  updated_at?: string | null;
  last_seen_at?: string | null;
}> {
  const client = requireClient(driverSupabase);
  return invokeTracklogPrivileged<{
    id: string;
    device_id: string;
    platform: 'android' | 'web';
    provider: 'fcm' | 'webpush';
    enabled: boolean;
    pushConfigured: boolean;
    updated_at?: string | null;
    last_seen_at?: string | null;
  }>(client, 'registerPushToken', input);
}

export async function unregisterTracklogPushTokenViaFunction(input: {
  deviceId: string;
  token: string;
}): Promise<number> {
  const client = requireClient(driverSupabase);
  const result = await invokeTracklogPrivileged<{ disabledCount: number }>(client, 'unregisterPushToken', input);
  return result.disabledCount;
}

export async function listPendingTracklogAdminMessagesViaFunction(input: {
  deviceId: string;
}): Promise<TracklogAdminMessage[]> {
  const client = requireClient(driverSupabase);
  return invokeTracklogPrivileged<TracklogAdminMessage[]>(client, 'listPendingAdminMessages', input);
}

export async function ackTracklogAdminMessagesViaFunction(input: {
  deviceId: string;
  messageIds: string[];
  locationRequestedAt?: string | null;
}): Promise<number> {
  const client = requireClient(driverSupabase);
  const result = await invokeTracklogPrivileged<{ acknowledged: number }>(client, 'ackAdminMessages', input);
  return result.acknowledged;
}

export async function migrateTracklogDeviceRecordsViaFunction(input: {
  oldDeviceId: string;
  newDeviceId: string;
}): Promise<void> {
  const client = requireClient(driverSupabase);
  await invokeTracklogPrivileged<{ migrated: boolean }>(client, 'migrateDeviceRecords', input);
}

export async function updateTracklogDeviceLocationViaFunction(input: {
  deviceId: string;
  latestStatus?: string | null;
  latestTripId?: string | null;
  latestLat: number;
  latestLng: number;
  latestAccuracy?: number | null;
  latestLocationAt: string;
  lastSeenAt: string;
}): Promise<RemoteDeviceProfile> {
  const client = requireClient(driverSupabase);
  return invokeTracklogPrivileged<RemoteDeviceProfile>(client, 'updateDeviceLocation', input);
}

export async function setTracklogDeviceApprovalViaFunction(input: {
  deviceId: string;
  approvalStatus: 'approved' | 'rejected';
}): Promise<RemoteDeviceProfile> {
  const client = requireClient(adminSupabase);
  return invokeTracklogPrivileged<RemoteDeviceProfile>(client, 'setDeviceApproval', input);
}

export async function deleteTracklogDeviceViaFunction(deviceId: string): Promise<{
  deletedCount: number;
  hidden: boolean;
}> {
  const client = requireClient(adminSupabase);
  return invokeTracklogPrivileged<{ deletedCount: number; hidden: boolean }>(client, 'deleteDevice', { deviceId });
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
