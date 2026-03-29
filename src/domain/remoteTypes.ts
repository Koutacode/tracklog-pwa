export type DriverIdentity = {
  configured: boolean;
  deviceId: string | null;
  displayName: string;
  vehicleLabel: string;
  authInitialized: boolean;
  profileComplete: boolean;
};

export type AdminSession = {
  configured: boolean;
  authenticated: boolean;
  email: string | null;
};

export type RemoteSyncState = {
  configured: boolean;
  enabled: boolean;
  syncing: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  deviceId: string | null;
  displayName: string;
  vehicleLabel: string;
  authInitialized: boolean;
  profileComplete: boolean;
};

export type RemoteDeviceProfile = {
  device_id: string;
  display_name: string;
  vehicle_label: string | null;
  platform: string;
  app_version: string | null;
  latest_status: string | null;
  latest_trip_id: string | null;
  latest_lat: number | null;
  latest_lng: number | null;
  latest_accuracy: number | null;
  last_seen_at: string;
  updated_at?: string;
};

export type RemoteTripHeader = {
  trip_id: string;
  device_id: string;
  start_ts: string;
  end_ts: string | null;
  odo_start: number;
  odo_end: number | null;
  total_km: number | null;
  last_leg_km: number | null;
  status: 'active' | 'closed';
  updated_at: string;
};

export type RemoteTripEvent = {
  id: string;
  trip_id: string;
  device_id: string;
  type: string;
  ts: string;
  address: string | null;
  geo: Record<string, unknown> | null;
  extras: Record<string, unknown> | null;
  sync_status: 'pending' | 'synced' | 'error';
  updated_at: string;
};

export type RemoteRoutePoint = {
  id: string;
  trip_id: string;
  device_id: string;
  ts: string;
  lat: number;
  lng: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  source: string | null;
  updated_at: string;
};

export type RemoteReportSnapshot = {
  trip_id: string;
  device_id: string;
  created_at: string;
  label: string;
  payload_json: unknown;
  updated_at: string;
};
