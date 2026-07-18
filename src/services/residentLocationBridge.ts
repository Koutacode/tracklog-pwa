import { registerPlugin } from '@capacitor/core';

export type NativeResidentLocationPoint = {
  id: string;
  tripId: string;
  ts: string;
  lat: number;
  lng: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  source: 'background';
  provider: string | null;
};

export type NativeResidentLocationSettings = {
  foregroundLocation: boolean;
  backgroundLocation: boolean;
  notifications: boolean;
  batteryOptimization: boolean;
  exactAlarm: boolean;
  locationEnabled: boolean;
};

export type NativeResidentLocationStatus = {
  approved: boolean;
  setupComplete: boolean;
  enabled: boolean;
  eligible: boolean;
  ready: boolean;
  running: boolean;
  startRequested: boolean;
  activeTripId: string;
  routePauseAtMs: number;
  queuedPointCount: number;
  authorizationConfigured: boolean;
  authorizationBlocked: boolean;
  lastUploadAt: number;
  settings: NativeResidentLocationSettings;
};

export type NativeResidentLocationAuthorization = {
  configured: boolean;
  accessToken: string;
  refreshToken: string;
  updatedAt: number;
  blocked: boolean;
};

type ResidentLocationPlugin = {
  reconcile(options: {
    approved: boolean;
    setupComplete: boolean;
    activeTripId: string;
    routePauseAtMs: number;
  }): Promise<NativeResidentLocationStatus>;
  installAuthorization(options: {
    supabaseUrl: string;
    anonKey: string;
    accessToken: string;
    refreshToken: string;
    deviceId: string;
  }): Promise<NativeResidentLocationStatus>;
  stop(options: {
    clearAuthorization: boolean;
    clearActiveTrip: boolean;
  }): Promise<NativeResidentLocationStatus>;
  getStatus(): Promise<NativeResidentLocationStatus>;
  getAuthorization(): Promise<NativeResidentLocationAuthorization>;
  refreshAuthorization(options?: { force?: boolean }): Promise<NativeResidentLocationAuthorization>;
  blockAuthorization(): Promise<NativeResidentLocationAuthorization>;
  peek(options: { limit: number }): Promise<{
    points: NativeResidentLocationPoint[];
    remaining: number;
  }>;
  acknowledge(options: { ids: string[] }): Promise<{ remaining: number }>;
};

export const ResidentLocation = registerPlugin<ResidentLocationPlugin>('ResidentLocation');
