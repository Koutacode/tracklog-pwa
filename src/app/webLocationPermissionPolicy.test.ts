import type { RouteTrackingMode } from '../db/repositories';
import {
  applyWebLocationTrackingIntent,
  normalizeWebLocationPermissionState,
  resolveWebLocationTrackingIntent,
} from './webLocationPermissionPolicy';

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

class FakeWebLocationTracking {
  watchPositionCalls = 0;
  clearWatchCalls = 0;
  watcherKey: string | null = null;
  private activeTripId: string | null = null;
  private activeRouteMode: RouteTrackingMode = 'precision';
  private residentEnabled = false;
  private residentMode: RouteTrackingMode = 'battery';

  private reconcile() {
    const nextWatcherKey = this.activeTripId
      ? `route:${this.activeTripId}:${this.activeRouteMode}`
      : this.residentEnabled
        ? `resident:${this.residentMode}`
        : null;
    if (nextWatcherKey === this.watcherKey) return;
    if (this.watcherKey !== null) this.clearWatchCalls += 1;
    this.watcherKey = nextWatcherKey;
    if (nextWatcherKey !== null) this.watchPositionCalls += 1;
  }

  async startResidentLocationUpdates(mode: RouteTrackingMode) {
    this.residentEnabled = true;
    this.residentMode = mode;
    this.reconcile();
  }

  async startRouteTracking(tripId: string, mode: RouteTrackingMode) {
    this.activeTripId = tripId;
    this.activeRouteMode = mode;
    this.reconcile();
  }

  async stopResidentLocationUpdates() {
    this.residentEnabled = false;
    this.reconcile();
  }

  async stopRouteTracking() {
    this.activeTripId = null;
    this.reconcile();
  }
}

async function reconcile(
  tracking: FakeWebLocationTracking,
  permissionState: 'granted' | 'prompt' | 'denied' | 'unknown',
  activeTripId: string | null,
  routePaused = false,
  activeTripResumeAttemptAvailable = false,
) {
  const intent = resolveWebLocationTrackingIntent({
    permissionState,
    activeTripId,
    routePaused,
    mode: 'precision',
    activeTripResumeAttemptAvailable,
  });
  await applyWebLocationTrackingIntent(intent, tracking);
  return intent;
}

async function main() {
  for (const permissionState of ['prompt', 'unknown', 'denied'] as const) {
    const tracking = new FakeWebLocationTracking();
    // Mount/remount/visibility/interval must never request permission while no
    // trip is active, even if the document one-shot remains available.
    for (let syncIndex = 0; syncIndex < 4; syncIndex += 1) {
      await reconcile(tracking, permissionState, null, false, true);
    }
    assertEqual(
      tracking.watchPositionCalls,
      0,
      `${permissionState} idle sync must not call watchPosition`,
    );
  }

  for (const permissionState of ['prompt', 'unknown'] as const) {
    const tracking = new FakeWebLocationTracking();
    const firstIntent = await reconcile(
      tracking,
      permissionState,
      'trip-active',
      false,
      true,
    );
    assertEqual(firstIntent.kind, 'route', `${permissionState} active trip one-shot intent`);
    assertEqual(
      firstIntent.kind === 'route' && firstIntent.consumesActiveTripResumeAttempt,
      true,
      `${permissionState} first resume consumes the document one-shot`,
    );
    assertEqual(tracking.watchPositionCalls, 1, `${permissionState} first resume calls watchPosition`);

    // StrictMode remount, visibility and interval syncs see a consumed module
    // latch and preserve the existing watcher without calling watchPosition.
    for (let syncIndex = 0; syncIndex < 4; syncIndex += 1) {
      const repeatedIntent = await reconcile(
        tracking,
        permissionState,
        'trip-active',
        false,
        false,
      );
      assertEqual(repeatedIntent.kind, 'unchanged', `${permissionState} repeated intent`);
    }
    assertEqual(tracking.watchPositionCalls, 1, `${permissionState} resume is attempted only once`);
  }

  {
    const tracking = new FakeWebLocationTracking();
    await reconcile(tracking, 'denied', 'trip-active', false, true);
    await reconcile(tracking, 'denied', 'trip-active', false, true);
    assertEqual(tracking.watchPositionCalls, 0, 'explicit denial never calls watchPosition');
  }

  {
    const tracking = new FakeWebLocationTracking();
    for (let syncIndex = 0; syncIndex < 4; syncIndex += 1) {
      await reconcile(tracking, 'granted', 'trip-active');
    }
    assertEqual(tracking.watchPositionCalls, 1, 'granted route syncs must reuse one watcher');
    assertEqual(tracking.clearWatchCalls, 0, 'reused route watcher must not be cleared');
    assertEqual(tracking.watcherKey, 'route:trip-active:precision', 'route watcher identity');
  }

  {
    const tracking = new FakeWebLocationTracking();
    await reconcile(tracking, 'denied', 'trip-active');
    assertEqual(tracking.watchPositionCalls, 0, 'denied state before explicit permission');
    await reconcile(tracking, 'granted', 'trip-active');
    assertEqual(tracking.watchPositionCalls, 1, 'sync after explicit grant starts route watcher');
  }

  {
    const tracking = new FakeWebLocationTracking();
    await reconcile(tracking, 'prompt', 'trip-active', true, true);
    assertEqual(tracking.watchPositionCalls, 0, 'paused active trip must not use resume one-shot');
  }

  {
    const tracking = new FakeWebLocationTracking();
    await reconcile(tracking, 'granted', null);
    await reconcile(tracking, 'granted', null);
    assertEqual(tracking.watchPositionCalls, 1, 'resident syncs must reuse one watcher');

    await reconcile(tracking, 'granted', 'trip-active');
    assertEqual(tracking.watchPositionCalls, 2, 'starting a trip switches to one route watcher');
    await reconcile(tracking, 'granted', 'trip-active', true);
    assertEqual(tracking.watchPositionCalls, 3, 'pausing a trip switches back to resident watcher');
    await reconcile(tracking, 'granted', 'trip-active', true);
    assertEqual(tracking.watchPositionCalls, 3, 'paused sync reuses resident watcher');

    await reconcile(tracking, 'denied', 'trip-active');
    assertEqual(tracking.watchPositionCalls, 3, 'revoking permission must not start another watcher');
    assertEqual(tracking.watcherKey, null, 'revoking permission stops the active watcher');
  }

  assertEqual(normalizeWebLocationPermissionState('granted'), 'granted', 'granted normalization');
  assertEqual(normalizeWebLocationPermissionState('prompt'), 'prompt', 'prompt normalization');
  assertEqual(normalizeWebLocationPermissionState('denied'), 'denied', 'denied normalization');
  assertEqual(normalizeWebLocationPermissionState('unsupported'), 'unknown', 'unknown normalization');

  console.log('webLocationPermissionPolicy tests passed');
}

void main();
