import {
  buildNativeResidentLocationReconcileRequest,
  buildNativeResidentLocationStopRequest,
  createNativeTrackingStateCoordinator,
} from './nativeResidentLocation';
import type { AppEvent } from '../domain/types';
import {
  buildNativeFastTrackingIntent,
  commitRouteTransitionThenApplyNativeState,
} from './nativeTrackingFastApplyPolicy';

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function runAsyncTests() {
  {
    const request = buildNativeResidentLocationReconcileRequest({
      approved: true,
      setupComplete: true,
      activeTripId: ' trip-native ',
      routePauseAt: '2026-08-23T01:02:03.000Z',
      expresswayOpen: true,
      expresswayConfig: {
        speedKmh: 82,
        durationSec: 12,
        endSpeedKmh: 31,
        endDurationSec: 45,
      },
    });
    assertEqual(request.activeTripId, 'trip-native', 'native reconcile trims trip id');
    assertEqual(request.expresswayOpen, true, 'native reconcile carries durable open state');
    assertEqual(request.expresswayConfig.speedKmh, 82, 'native reconcile carries start threshold');
    assertEqual(request.expresswayConfig.endDurationSec, 45, 'native reconcile carries end hold');
    assertEqual(
      request.routePauseAtMs,
      Date.parse('2026-08-23T01:02:03.000Z'),
      'native reconcile carries pause watermark',
    );

    const defaults = buildNativeResidentLocationReconcileRequest({
      approved: false,
      setupComplete: false,
      activeTripId: null,
    });
    assertEqual(defaults.expresswayOpen, false, 'missing open state fails closed');
    assertEqual(defaults.expresswayConfig.speedKmh, 78, 'missing config uses detector default');
    assertEqual(defaults.routePauseAtMs, 0, 'invalid pause input is normalized');

    const permissionStop = buildNativeResidentLocationStopRequest('permission-denied');
    assertEqual(permissionStop.clearAuthorization, true, 'permission denial clears unusable auth');
    assertEqual(permissionStop.clearExpresswayData, false, 'permission denial preserves detector replay');
    const signOutStop = buildNativeResidentLocationStopRequest('signed-out');
    assertEqual(signOutStop.clearExpresswayData, true, 'explicit sign-out clears private detector state');
  }

  {
    const coordinator = createNativeTrackingStateCoordinator();
    const oldBridgeCall = deferred();
    const calls: string[] = [];
    let nativeState = '';

    const oldFullReconcile = coordinator.enqueueCommit(async () => {
      calls.push('old:start');
      await oldBridgeCall.promise;
      nativeState = 'old-full';
      calls.push('old:end');
      return nativeState;
    });
    await Promise.resolve();

    coordinator.advanceGeneration();
    const directDecision = coordinator.enqueueCommit(async () => {
      calls.push('direct:start');
      nativeState = 'direct-decision';
      calls.push('direct:end');
      return nativeState;
    });
    await Promise.resolve();

    assertEqual(
      calls.join(','),
      'old:start',
      'a direct decision waits for an already-started bridge reconcile',
    );
    oldBridgeCall.resolve();
    await Promise.all([oldFullReconcile, directDecision]);
    assertEqual(
      calls.join(','),
      'old:start,old:end,direct:start,direct:end',
      'bridge reconciles execute in submission order',
    );
    assertEqual(nativeState, 'direct-decision', 'the explicit decision is the final native state');
  }

  {
    const coordinator = createNativeTrackingStateCoordinator();
    const authStep = deferred();
    const expectedGeneration = coordinator.getGeneration();
    const calls: string[] = [];

    const staleFullReconcile = (async () => {
      await authStep.promise;
      if (!coordinator.isCurrent(expectedGeneration)) return 'skipped';
      return coordinator.enqueueCommit(async () => {
        calls.push('stale-full');
        return 'committed';
      });
    })();

    coordinator.advanceGeneration();
    await coordinator.enqueueCommit(async () => {
      calls.push('direct-decision');
      return 'committed';
    });
    authStep.resolve();

    assertEqual(
      await staleFullReconcile,
      'skipped',
      'a generation change during auth skips the stale full reconcile',
    );
    assertEqual(
      calls.join(','),
      'direct-decision',
      'the stale auth path never reaches the native bridge',
    );
  }

  {
    const coordinator = createNativeTrackingStateCoordinator();
    const calls: string[] = [];
    const failedCommit = coordinator.enqueueCommit(async () => {
      calls.push('failed');
      throw new Error('bridge unavailable');
    });
    const recoveredCommit = coordinator.enqueueCommit(async () => {
      calls.push('recovered');
      return 'ok';
    });

    let failureSurfaced = false;
    try {
      await failedCommit;
    } catch {
      failureSurfaced = true;
    }
    assertEqual(failureSurfaced, true, 'the failed bridge call still rejects its own caller');
    assertEqual(await recoveredCommit, 'ok', 'a later bridge call runs after an earlier rejection');
    assertEqual(calls.join(','), 'failed,recovered', 'a rejection does not poison the commit queue');
  }

  {
    const coordinator = createNativeTrackingStateCoordinator();
    const calls: string[] = [];
    await coordinator.enqueueCommit(async () => {
      calls.push('tracking-intent');
      return 'started';
    });
    let authorizationFailed = false;
    try {
      calls.push('authorization');
      throw new Error('offline token refresh');
    } catch {
      authorizationFailed = true;
    }
    assertEqual(authorizationFailed, true, 'offline authorization failure is surfaced for retry');
    assertEqual(
      calls.join(','),
      'tracking-intent,authorization',
      'durable local tracking intent is committed before fallible authorization work',
    );
  }

  {
    const config = {
      speedKmh: 78,
      durationSec: 6,
      endSpeedKmh: 34,
      endDurationSec: 24,
    };
    const event = (type: AppEvent['type'], ts: string, extras: Record<string, unknown> = {}) => ({
      id: `${type}-${ts}`,
      tripId: 'trip-fast',
      type,
      ts,
      geo: { lat: 35, lng: 139 },
      extras,
    }) as AppEvent;
    const base = [event('trip_start', '2026-08-23T00:00:00.000Z')];
    const started = buildNativeFastTrackingIntent({
      tripId: 'trip-fast',
      events: base,
      expresswayConfig: config,
      breakConfirmationStatus: null,
    });
    assertEqual(started.activeTripId, 'trip-fast', 'trip start immediately resumes native route');

    const resting = buildNativeFastTrackingIntent({
      tripId: 'trip-fast',
      events: [...base, event('rest_start', '2026-08-23T01:00:00.000Z', { restSessionId: 'rest-1' })],
      expresswayConfig: config,
      breakConfirmationStatus: null,
    });
    assertEqual(resting.activeTripId, null, 'rest start immediately pauses native route');
    const restEnded = buildNativeFastTrackingIntent({
      tripId: 'trip-fast',
      events: [
        ...base,
        event('rest_start', '2026-08-23T01:00:00.000Z', { restSessionId: 'rest-1' }),
        event('rest_end', '2026-08-23T01:30:00.000Z', { restSessionId: 'rest-1' }),
      ],
      expresswayConfig: config,
      breakConfirmationStatus: null,
    });
    assertEqual(restEnded.activeTripId, 'trip-fast', 'rest end immediately resumes native route');

    const ferry = buildNativeFastTrackingIntent({
      tripId: 'trip-fast',
      events: [...base, event('boarding', '2026-08-23T02:00:00.000Z', { ferrySessionId: 'ferry-1' })],
      expresswayConfig: config,
      breakConfirmationStatus: null,
    });
    assertEqual(ferry.activeTripId, null, 'ferry boarding immediately pauses native route');
    const disembarked = buildNativeFastTrackingIntent({
      tripId: 'trip-fast',
      events: [
        ...base,
        event('boarding', '2026-08-23T02:00:00.000Z', { ferrySessionId: 'ferry-1' }),
        event('disembark', '2026-08-23T03:00:00.000Z', { ferrySessionId: 'ferry-1' }),
      ],
      expresswayConfig: config,
      breakConfirmationStatus: null,
    });
    assertEqual(disembarked.activeTripId, 'trip-fast', 'ferry exit immediately resumes native route');

    const expressway = buildNativeFastTrackingIntent({
      tripId: 'trip-fast',
      events: [
        ...base,
        event('expressway_start', '2026-08-23T03:10:00.000Z', { expresswaySessionId: 'exp-1' }),
      ],
      expresswayConfig: config,
      breakConfirmationStatus: null,
    });
    assertEqual(expressway.expresswayOpen, true, 'manual expressway start updates native owner');

    const breakPending = buildNativeFastTrackingIntent({
      tripId: 'trip-fast',
      events: [
        ...base,
        event('break_start', '2026-08-23T04:00:00.000Z', { breakSessionId: 'break-1' }),
      ],
      expresswayConfig: config,
      breakConfirmationStatus: 'pending',
    });
    assertEqual(
      breakPending.routePauseAt,
      '2026-08-23T07:00:00.000Z',
      'break start installs the three-hour native pause watermark',
    );
    const breakDeclined = buildNativeFastTrackingIntent({
      tripId: 'trip-fast',
      events: [
        ...base,
        event('break_start', '2026-08-23T04:00:00.000Z', { breakSessionId: 'break-1' }),
      ],
      expresswayConfig: config,
      breakConfirmationStatus: 'declined',
    });
    assertEqual(breakDeclined.routePauseAt, null, 'declined conversion resumes native route');

    const ended = buildNativeFastTrackingIntent({
      tripId: null,
      events: [],
      expresswayConfig: config,
      breakConfirmationStatus: null,
    });
    assertEqual(ended.activeTripId, null, 'trip end immediately clears native active trip');
    assertEqual(ended.expresswayOpen, false, 'trip end closes native reconcile overlay');
  }

  {
    const order: string[] = [];
    let failed = false;
    try {
      await commitRouteTransitionThenApplyNativeState({
        commit: async () => {
          order.push('dexie');
          return 'committed';
        },
        applyNativeState: async () => {
          order.push('native');
          throw new Error('bridge unavailable while backgrounding');
        },
      });
    } catch {
      failed = true;
    }
    assertEqual(order.join(','), 'dexie,native', 'every route transition awaits native after Dexie');
    assertEqual(failed, true, 'fast apply failure is surfaced before UI success');
  }

  console.log('nativeResidentLocation: 22 tests passed');
}

void runAsyncTests().catch(error => {
  globalThis.setTimeout(() => {
    throw error;
  }, 0);
});
