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

/** Recheck persisted trip identity and the initiating lifecycle after every await. */
export function guardWebLocationTrackingActions(
  actions: WebLocationTrackingActions,
  guard: {
    expectedTripId: string | null;
    getActiveTripId: () => Promise<string | null>;
    isCurrent: () => boolean;
  },
): WebLocationTrackingActions {
  const runCurrent = async (action: () => Promise<void>, requiresTrip = false) => {
    const activeTripId = await guard.getActiveTripId();
    // This check and invoking the action share one synchronous continuation.
    // A trip-close request invalidates the epoch while the DB read is pending.
    if (!guard.isCurrent() || activeTripId !== guard.expectedTripId || (requiresTrip && !activeTripId)) return;
    await action();
  };
  return {
    startResidentLocationUpdates: mode => runCurrent(() => actions.startResidentLocationUpdates(mode), true),
    startRouteTracking: (tripId, mode) => runCurrent(() => actions.startRouteTracking(tripId, mode), true),
    stopResidentLocationUpdates: () => runCurrent(() => actions.stopResidentLocationUpdates()),
    stopRouteTracking: () => runCurrent(() => actions.stopRouteTracking()),
  };
}

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
  // Permission alone is not tracking intent. No location is acquired between
  // trips, including an already-granted permission after an app restart.
  if (!input.activeTripId) return { kind: 'stopped' };
  if (input.permissionState === 'granted') {
    if (input.routePaused) return { kind: 'resident' };
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

  // Do not arm an idle fallback: ending this route must stop GPS outright.
  // A pause within an active trip can explicitly select resident intent.
  await actions.stopResidentLocationUpdates();
  await actions.startRouteTracking(intent.tripId, intent.mode);
}
