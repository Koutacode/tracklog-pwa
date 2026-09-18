import {
  IC_RESOLVE_AUTH_BACKOFF_CAP_MS,
  IC_RESOLVE_ALGORITHM_VERSION,
  IC_RESOLVE_TEMPORARY_BACKOFF_CAP_MS,
  canApplyIcResolutionResult,
  canRetryIcResolve,
  captureIcResolutionEventVersion,
  computeIcResolveBackoffMs,
  computeIcResolveDeferredBackoffMs,
  getNextIcResolveDeferredRetryCount,
} from './expresswayIcRetryPolicy';
import {
  acceptIcCandidate,
  classifyIcResolverHttpStatus,
} from './icResolver';
import {
  IC_GEO_FALLBACK_WINDOW_MS,
  IC_GEO_UNKNOWN_ACCURACY_WINDOW_MS,
  isUsableIcResolutionGeo,
  selectIcResolutionRoutePoint,
} from './expresswayIcResolution';

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function assertJsonEqual(actual: unknown, expected: unknown, message: string) {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

const nowMs = Date.parse('2026-07-17T08:00:00.000Z');

assertEqual(
  canRetryIcResolve({ icName: '札幌IC', icResolveAlgorithmVersion: 1 }, nowMs),
  false,
  'an already named event is never reprocessed just because its algorithm is old',
);
assertEqual(
  canRetryIcResolve({
    icResolveAlgorithmVersion: IC_RESOLVE_ALGORITHM_VERSION - 1,
    icResolveRetryCount: 6,
  }, nowMs),
  true,
  'an unnamed event from an old algorithm is retried even after exhaustion',
);
assertEqual(
  canRetryIcResolve({
    icResolveAlgorithmVersion: IC_RESOLVE_ALGORITHM_VERSION,
    icResolveStatus: 'pending',
    icResolveNextRetryAt: '2026-07-17T08:02:00.000Z',
  }, nowMs),
  false,
  'pending backoff is observed during the timer run',
);
assertEqual(
  canRetryIcResolve({
    icResolveAlgorithmVersion: IC_RESOLVE_ALGORITHM_VERSION,
    icResolveStatus: 'pending',
    icResolveNextRetryAt: '2026-07-17T08:02:00.000Z',
  }, nowMs, true),
  true,
  'auth and online recovery can bypass pending backoff',
);
assertEqual(
  canRetryIcResolve({
    icResolveAlgorithmVersion: IC_RESOLVE_ALGORITHM_VERSION,
    icResolveStatus: 'failed',
    icResolveRetryCount: 5,
    icResolveNextRetryAt: '2026-07-17T07:59:00.000Z',
  }, nowMs),
  true,
  'a due non-exhausted failure is retried',
);
assertEqual(
  canRetryIcResolve({
    icResolveAlgorithmVersion: IC_RESOLVE_ALGORITHM_VERSION,
    icResolveStatus: 'failed',
    icResolveRetryCount: 6,
  }, nowMs),
  false,
  'an exhausted current-algorithm failure is not retried forever',
);
assertEqual(
  canRetryIcResolve({
    icName: '旧IC名',
    icResolveAlgorithmVersion: IC_RESOLVE_ALGORITHM_VERSION,
    icResolveStatus: 'pending',
    icResolveNextRetryAt: '2026-07-17T07:59:00.000Z',
  }, nowMs),
  true,
  'a due pending attempt is not hidden by its previously resolved name',
);
assertEqual(
  canRetryIcResolve({
    icName: '確定IC名',
    icResolveAlgorithmVersion: IC_RESOLVE_ALGORITHM_VERSION,
    icResolveStatus: 'resolved',
  }, nowMs),
  false,
  'a resolved named event remains stable',
);
assertEqual(
  canRetryIcResolve({
    icResolveAlgorithmVersion: IC_RESOLVE_ALGORITHM_VERSION,
    icResolveStatus: 'failed',
    icResolveRetryCount: 1,
  }, nowMs),
  false,
  'an explicit terminal failure without a next-at timestamp is not retried',
);
assertEqual(computeIcResolveBackoffMs(1), 120_000, 'first failure uses two-minute backoff');
assertEqual(computeIcResolveBackoffMs(10), 3_600_000, 'backoff is capped at one hour');
assertEqual(
  computeIcResolveDeferredBackoffMs('temporary', 1),
  15_000,
  'temporary failures retry promptly after a short network interruption',
);
assertEqual(
  computeIcResolveDeferredBackoffMs('temporary', 2),
  30_000,
  'temporary deferred failures increase exponentially',
);
assertEqual(
  computeIcResolveDeferredBackoffMs('temporary', 30),
  IC_RESOLVE_TEMPORARY_BACKOFF_CAP_MS,
  'temporary deferred failures are capped',
);
assertEqual(
  computeIcResolveDeferredBackoffMs('authorization-recoverable', 1),
  900_000,
  'authorization recovery begins at fifteen minutes',
);
assertEqual(
  computeIcResolveDeferredBackoffMs('authorization-recoverable', 2),
  1_800_000,
  'authorization recovery increases exponentially',
);
assertEqual(
  computeIcResolveDeferredBackoffMs('authorization-recoverable', 30),
  IC_RESOLVE_AUTH_BACKOFF_CAP_MS,
  'authorization recovery is capped',
);
assertEqual(
  getNextIcResolveDeferredRetryCount({
    icResolveAlgorithmVersion: IC_RESOLVE_ALGORITHM_VERSION,
    icResolveStatus: 'pending',
    icResolveRetryCount: 4,
  }),
  5,
  'the persisted deferred retry count advances',
);
assertEqual(
  getNextIcResolveDeferredRetryCount({
    icResolveAlgorithmVersion: IC_RESOLVE_ALGORITHM_VERSION,
    icResolveStatus: 'pending',
    icResolveRetryCount: 12,
  }, true),
  1,
  'an explicit recovery trigger restarts deferred backoff',
);
assertEqual(
  getNextIcResolveDeferredRetryCount({
    icResolveAlgorithmVersion: IC_RESOLVE_ALGORITHM_VERSION - 1,
    icResolveStatus: 'pending',
    icResolveRetryCount: 12,
  }),
  1,
  'an algorithm upgrade restarts deferred backoff',
);
assertEqual(
  getNextIcResolveDeferredRetryCount({
    icResolveAlgorithmVersion: IC_RESOLVE_ALGORITHM_VERSION,
    icResolveStatus: 'failed',
    icResolveRetryCount: 5,
  }),
  1,
  'a retryable failure starts a separate pending backoff series',
);

assertEqual(
  classifyIcResolverHttpStatus(403),
  'authorization-recoverable',
  'approval and device assignment 403s remain recoverable',
);
assertEqual(classifyIcResolverHttpStatus(404), 'permanent', '404 remains a permanent request error');
assertEqual(classifyIcResolverHttpStatus(503), 'temporary', 'server failures remain temporary');

assertJsonEqual(
  acceptIcCandidate({ icName: '境界IC', distanceM: 1200 }),
  { icName: '境界IC', distanceM: 1200 },
  'a candidate at the primary acceptance boundary is retained',
);
assertEqual(
  acceptIcCandidate({ icName: '中距離IC', distanceM: 1201 }),
  null,
  'a middle-band candidate is rejected without corroborating signals',
);
assertJsonEqual(
  acceptIcCandidate(
    { icName: '料金所付近IC', distanceM: 1800 },
    { nearEtcGate: true, onExpresswayRoad: true },
  ),
  { icName: '料金所付近IC', distanceM: 1800 },
  'a middle-band candidate requires both ETC and expressway-road evidence',
);
assertEqual(
  acceptIcCandidate(
    { icName: '遠方IC', distanceM: 2001 },
    { nearEtcGate: true, onExpresswayRoad: true },
  ),
  null,
  'a candidate beyond two kilometres is always rejected',
);

assertEqual(
  isUsableIcResolutionGeo({ lat: 35, lng: 139 }),
  true,
  'historical geo without accuracy remains usable',
);
assertEqual(
  isUsableIcResolutionGeo({ lat: 35, lng: 139, accuracy: 101 }),
  false,
  'coarse recorded geo is rejected',
);
assertJsonEqual(
  selectIcResolutionRoutePoint([
    { ts: '2026-07-17T07:57:00.000Z', lat: 35.1, lng: 139.1, accuracy: 20 },
    { ts: '2026-07-17T08:00:25.000Z', lat: 35.2, lng: 139.2, accuracy: 30 },
    { ts: '2026-07-17T08:00:30.000Z', lat: 35.3, lng: 139.3, accuracy: 120 },
  ], '2026-07-17T08:00:00.000Z'),
  { lat: 35.2, lng: 139.2, accuracy: 30 },
  'the closest usable route point wins while coarse fixes are ignored',
);
assertEqual(
  selectIcResolutionRoutePoint([
    {
      ts: new Date(nowMs + IC_GEO_FALLBACK_WINDOW_MS + 1).toISOString(),
      lat: 35,
      lng: 139,
      accuracy: 10,
    },
  ], new Date(nowMs).toISOString()),
  undefined,
  'route points outside the ninety-second window are ignored',
);
assertEqual(
  selectIcResolutionRoutePoint([
    {
      ts: new Date(nowMs + IC_GEO_UNKNOWN_ACCURACY_WINDOW_MS + 1).toISOString(),
      lat: 35,
      lng: 139,
    },
  ], new Date(nowMs).toISOString()),
  undefined,
  'unknown-accuracy fallback points are limited to fifteen seconds',
);
assertJsonEqual(
  selectIcResolutionRoutePoint([
    { ts: '2026-07-17T07:59:50.000Z', lat: 35.1, lng: 139.1, accuracy: 20 },
    { ts: '2026-07-17T08:00:10.000Z', lat: 35.2, lng: 139.2, accuracy: 20 },
  ], '2026-07-17T08:00:00.000Z', 'expressway_start'),
  { lat: 35.2, lng: 139.2, accuracy: 20 },
  'an equidistant start fallback prefers the first point after entry',
);
assertJsonEqual(
  selectIcResolutionRoutePoint([
    { ts: '2026-07-17T07:59:50.000Z', lat: 35.1, lng: 139.1, accuracy: 20 },
    { ts: '2026-07-17T08:00:10.000Z', lat: 35.2, lng: 139.2, accuracy: 20 },
  ], '2026-07-17T08:00:00.000Z', 'expressway_end'),
  { lat: 35.1, lng: 139.1, accuracy: 20 },
  'an equidistant end fallback prefers the last point before exit',
);

const pendingVersionSource = {
  localRevision: 4,
  syncMutationId: 'mutation-pending',
  extras: {
    icResolveStatus: 'pending',
  },
};
const pendingVersion = captureIcResolutionEventVersion(pendingVersionSource);
assertEqual(
  canApplyIcResolutionResult(pendingVersion, pendingVersionSource),
  true,
  'an unchanged pending row accepts either a success or failure outcome',
);
assertEqual(
  canApplyIcResolutionResult(pendingVersion, {
    localRevision: 5,
    syncMutationId: 'mutation-manual',
    extras: {
      icResolveStatus: 'resolved',
      icName: '手動確定IC',
      icResolvedManually: true,
      icResolveManualUpdatedAt: '2026-08-23T08:00:00.000Z',
    },
  }),
  false,
  'a delayed resolver success cannot overwrite a newer manual IC correction',
);
assertEqual(
  canApplyIcResolutionResult(pendingVersion, {
    localRevision: 5,
    syncMutationId: 'mutation-manual',
    extras: {
      icResolveStatus: 'resolved',
      icName: '手動確定IC',
      icResolvedManually: true,
      icResolveManualUpdatedAt: '2026-08-23T08:00:00.000Z',
    },
  }),
  false,
  'a delayed resolver failure cannot downgrade a newer manual IC correction',
);

const existingManualSource = {
  extras: {
    icResolveStatus: 'resolved',
    icName: '既存手動IC',
    icResolvedManually: true,
    icResolveManualUpdatedAt: '2026-08-23T08:10:00.000Z',
  },
};
const existingManualVersion = captureIcResolutionEventVersion(existingManualSource);
assertEqual(
  canApplyIcResolutionResult(existingManualVersion, existingManualSource),
  false,
  'a failed or deferred refresh cannot downgrade an unchanged manual IC value',
);
assertEqual(
  canApplyIcResolutionResult(existingManualVersion, existingManualSource, {
    allowExistingManual: true,
  }),
  true,
  'an explicit refresh may replace the same unchanged manual value',
);
assertEqual(
  canApplyIcResolutionResult(existingManualVersion, {
    extras: {
      ...existingManualSource.extras,
      icName: '再編集された手動IC',
      icResolveManualUpdatedAt: '2026-08-23T08:11:00.000Z',
    },
  }, {
    allowExistingManual: true,
  }),
  false,
  'even an explicit refresh yields to a manual edit made after it started',
);

console.log('expresswayIcRetryPolicy: all assertions passed');
