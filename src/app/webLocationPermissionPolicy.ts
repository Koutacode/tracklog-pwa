import type { RouteTrackingMode } from '../db/repositories';

export type WebLocationPermissionState = PermissionState | 'unknown';

export type WebLocationTrackingIntent =
  | { kind: 'unchanged' }
  | { kind: 'stopped' }
  | { kind: 'resident' }
  | {
      kind: 'route';
      tripId: string;
      mode: RouteTrackingMode;
      consumesActiveTripResumeAttempt: boolean;
    };

export type WebLocationTrackingActions = {
  startResidentLocationUpdates(mode: RouteTrackingMode): Promise<void>;
  startRouteTracking(tripId: string, mode: RouteTrackingMode): Promise<void>;
  stopResidentLocationUpdates(): Promise<void>;
  stopRouteTracking(): Promise<void>;
};

export function normalizeWebLocationPermissionState(
  state: string | null | undefined,
): WebLocationPermissionState {
  if (state === 'granted' || state === 'prompt' || state === 'denied') return state;
  return 'unknown';
}

export function resolveWebLocationTrackingIntent(input: {
  permissionState: WebLocationPermissionState;
  activeTripId: string | null;
  routePaused: boolean;
  mode?: RouteTrackingMode;
  activeTripResumeAttemptAvailable?: boolean;
}): WebLocationTrackingIntent {
  if (input.permissionState === 'granted') {
    if (!input.activeTripId || input.routePaused) return { kind: 'resident' };
    return {
      kind: 'route',
      tripId: input.activeTripId,
      mode: input.mode ?? 'precision',
      consumesActiveTripResumeAttempt: false,
    };
  }
  if (input.permissionState === 'denied' || !input.activeTripId || input.routePaused) {
    return { kind: 'stopped' };
  }
  if (input.activeTripResumeAttemptAvailable) {
    return {
      kind: 'route',
      tripId: input.activeTripId,
      mode: input.mode ?? 'precision',
      consumesActiveTripResumeAttempt: true,
    };
  }
  // WebKit can report `prompt` after a reload even when the user granted a
  // temporary permission. Once the one document-lifetime resume attempt has
  // been made, preserve that watcher without calling watchPosition again.
  return { kind: 'unchanged' };
}

/**
 * Apply the desired PWA watcher state in an order that lets routeTracking reuse
 * its existing watcher. Policy resolution is responsible for limiting the one
 * WebKit active-trip resume probe; this function never retries on its own.
 */
export async function applyWebLocationTrackingIntent(
  intent: WebLocationTrackingIntent,
  actions: WebLocationTrackingActions,
) {
  if (intent.kind === 'unchanged') return;

  if (intent.kind === 'stopped') {
    await actions.stopResidentLocationUpdates();
    await actions.stopRouteTracking();
    return;
  }

  if (intent.kind === 'resident') {
    await actions.startResidentLocationUpdates('battery');
    await actions.stopRouteTracking();
    return;
  }

  await actions.startRouteTracking(intent.tripId, intent.mode);
  // Keep resident tracking enabled so ending/pausing the trip can reuse the
  // same watcher while changing purpose instead of briefly stopping it.
  await actions.startResidentLocationUpdates('battery');
}
