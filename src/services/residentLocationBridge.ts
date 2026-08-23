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
  monotonicSessionId?: string;
  elapsedRealtimeMs?: number;
};

export type NativeResidentExpresswayEvent = {
  id: string;
  tripId: string;
  kind: 'start' | 'end_prompt' | 'decision_end' | 'decision_keep';
  generation: number;
  detectedAt: string;
  decidedAt?: string;
  promptId?: string;
  geo: {
    lat: number;
    lon: number;
    accuracy?: number;
  };
  speedKmh: number;
  monotonicSessionId?: string;
  elapsedRealtimeMs?: number;
  reason: Record<string, unknown>;
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
  expresswayPendingEventCount: number;
  expresswayStorageHealthy: boolean;
  expresswayOpen: boolean;
  expresswayPromptPending: boolean;
  expresswayProbePending: boolean;
  expresswayProbeAttemptCount: number;
  expresswayProbeLastFailureCategory: string;
  expresswayProbeFailureUpdatedAt: number;
  expresswayGeneration: number;
  queuedStorageBytes: number;
  queueSegmentCount: number;
  quarantinedStorageBytes: number;
  quarantineSegmentCount: number;
  queueStorageHealthy: boolean;
  authorizationConfigured: boolean;
  authorizationBlocked: boolean;
  lastUploadAt: number;
  lastAcceptedLocationAt: number;
  locationQualitySessionStartedAt: number;
  locationQualityUpdatedAt: number;
  locationRejectCounts: Record<string, number>;
  lastQueueWriteAt: number;
  queueWriteFailureCount: number;
  lastQueueWriteFailureAt: number;
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
    expresswayOpen: boolean;
    expresswayConfig: {
      speedKmh: number;
      durationSec: number;
      endSpeedKmh: number;
      endDurationSec: number;
    };
  }): Promise<NativeResidentLocationStatus>;
  applyTrackingState(options: {
    activeTripId: string;
    routePauseAtMs: number;
    expresswayOpen: boolean;
    expresswayConfig: {
      speedKmh: number;
      durationSec: number;
      endSpeedKmh: number;
      endDurationSec: number;
    };
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
    clearExpresswayData: boolean;
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
  peekExpresswayEvents(options: { limit: number }): Promise<{
    events: NativeResidentExpresswayEvent[];
    remaining: number;
  }>;
  acknowledgeExpresswayEvents(options: { ids: string[] }): Promise<{ remaining: number }>;
  resolveExpresswayPrompt(options: {
    promptId: string;
    action: 'end' | 'keep';
  }): Promise<{
    stored: true;
    eventId: string;
    generation: number;
  }>;
};

export const ResidentLocation = registerPlugin<ResidentLocationPlugin>('ResidentLocation');
