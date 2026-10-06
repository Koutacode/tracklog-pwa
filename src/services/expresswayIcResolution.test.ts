import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { liveQuery } from 'dexie';
import { withRemoteSyncSignalsSuppressed } from '../app/remoteSyncSignal';
import { db } from '../db/db';
import { getEventsByTripId, updateEventAddress, updateExpresswayIcNameManual } from '../db/repositories';
import type { AppEvent, Geo, RoutePoint } from '../domain/types';
import {
  createExpresswayIcResolutionRunner,
  createExpresswayIcRetryBatchRunner,
  getIcResolutionReferenceTs,
  selectIcResolutionSupplementalPoints,
} from './expresswayIcResolution';
import { IcResolverError, type IcResult } from './icResolver';
import { IC_RESOLVE_ALGORITHM_VERSION, IC_RESOLVE_RETRY_LIMIT } from './expresswayIcRetryPolicy';
import { buildTripDetailReportSnapshot } from '../ui/screens/tripDetailReportSnapshot';

// All fixtures are synthetic; no device/session/network data is used.
const eventId = 'synthetic-ic-event';
const tripId = 'synthetic-ic-trip';
const timestamp = '2026-09-18T03:00:00.000Z';
const referenceMs = Date.parse(timestamp);
const originalGeo: Geo = { lat: 35, lng: 139, accuracy: 10 };
const ts = (offsetSeconds: number) => new Date(referenceMs + offsetSeconds * 1000).toISOString();
const geoAt = (meters: number): Geo => ({ ...originalGeo, lat: 35 + meters / 111_195 });

function point(id: string, seconds: number, meters: number, extra: Partial<RoutePoint> = {}): RoutePoint {
  return { id, tripId, ts: ts(seconds), ...geoAt(meters), source: 'background', ...extra };
}

async function reset(points: RoutePoint[] = [], eventOverrides: Partial<AppEvent> = {}) {
  await db.transaction('rw', db.events, db.routePoints, async () => {
    await db.events.clear();
    await db.routePoints.clear();
    await db.events.put({
      id: eventId, tripId, type: 'expressway_end', ts: timestamp,
      geo: originalGeo, syncStatus: 'pending', extras: { icResolveStatus: 'pending' },
      ...eventOverrides,
    } as AppEvent);
    await db.routePoints.bulkPut(points);
  });
}

function runnerWithResults(results: (IcResult | null | Error)[]) {
  const calls: Geo[] = [];
  const run = createExpresswayIcResolutionRunner(async (lat, lng) => {
    calls.push({ lat, lng });
    assert.ok(calls.length <= results.length, 'network query count stays within the expected bound');
    const result = results[calls.length - 1];
    if (result instanceof Error) throw result;
    return result;
  });
  return { calls, run: () => run({ eventId, source: 'retry' }) };
}

async function savedExtras() {
  return (await db.events.get(eventId))!.extras!;
}

async function testPrimarySuccessDoesNotQueryAdditionalPoints() {
  await reset([point('route', -20, 500)]);
  const { run, calls } = runnerWithResults([{ icName: '合成IC', distanceM: 50 }]);
  assert.equal((await run()).status, 'resolved');
  assert.equal(calls.length, 1);
  assert.equal((await savedExtras()).icResolveGeoSource, 'event');
}

async function testConcurrentAddressCompletionKeepsResolvedIcAndReport() {
  await reset();
  const before = (await db.events.get(eventId))!;
  const run = createExpresswayIcResolutionRunner(async () => {
    await updateEventAddress(eventId, '合成住所');
    return { icName: '合成IC', distanceM: 50 };
  });
  assert.equal((await run({ eventId, source: 'manual' })).status, 'resolved');
  const saved = (await db.events.get(eventId))!;
  assert.equal(saved.address, '合成住所');
  assert.ok((saved.localRevision ?? 0) > (before.localRevision ?? 0), 'real database revision hooks ran');
  assert.equal(saved.extras?.icName, '合成IC', 'address completion does not discard the in-flight IC result');
  const reportEvents: AppEvent[] = [
    { ...saved, id: 'trip-start', type: 'trip_start', ts: ts(-60), extras: { odoKm: 100 } },
    { ...saved, id: 'expressway-start', type: 'expressway_start', ts: ts(-30), extras: {} },
    saved,
  ];
  const snapshot = buildTripDetailReportSnapshot({ tripId, events: reportEvents, dayRuns: [], fallbackLabel: '合成日報' }, '', timestamp);
  const reportEvent = snapshot.days.flatMap(day => day.events).find(event => event.type === 'expressway_end');
  assert.equal(reportEvent?.extras?.icName, '合成IC', 'rebuilt report snapshots retain the resolved name');
  assert.equal(reportEvent?.address, '合成住所');
}

async function testRelevantEventEditsRejectStaleIcAndDoNotReportSuccess() {
  const mutations: Array<() => Promise<unknown>> = [
    () => db.events.update(eventId, { geo: geoAt(500) }),
    () => db.events.update(eventId, { type: 'point_mark' }),
    () => db.events.update(eventId, { ts: ts(10) }),
    () => db.events.update(eventId, { tripId: 'other-trip' }),
    () => db.events.update(eventId, { extras: { icResolveStatus: 'pending', autoDecision: {
      source: 'native-auto', action: 'end-prompt', evaluatedAt: ts(-20),
    } } }),
    () => db.events.update(eventId, { extras: { icResolveStatus: 'pending', icResolveRetryCount: 2 } }),
    () => db.events.delete(eventId),
  ];
  for (const mutate of mutations) {
    await reset();
    const run = createExpresswayIcResolutionRunner(async () => {
      await mutate();
      return { icName: '古い候補IC', distanceM: 40 };
    });
    const result = await run({ eventId, source: 'manual' });
    assert.equal(result.status, 'deferred');
    if (result.status === 'deferred') assert.equal(result.reason, 'superseded');
    assert.equal((await db.events.get(eventId))?.extras?.icName, undefined);
  }
}

async function testQueuedGeoHintCannotReplaceCorrectedSavedLocation() {
  await reset([], { geo: geoAt(500) });
  const run = createExpresswayIcResolutionRunner(async (lat, lng) => {
    assert.equal(lat, geoAt(500).lat);
    assert.equal(lng, geoAt(500).lng);
    return { icName: '訂正地点IC', distanceM: 40 };
  });
  assert.equal((await run({ eventId, geo: originalGeo, source: 'retry' })).status, 'resolved');
}

async function testDiscardedFailureDoesNotReportBatchUpdate() {
  await reset();
  const resolve = createExpresswayIcResolutionRunner(async () => {
    await db.events.delete(eventId);
    throw new Error('合成検索失敗');
  });
  assert.equal(await createExpresswayIcRetryBatchRunner(resolve)(), false,
    'a failure rejected by the write guard is not counted as a saved update');
}

async function testRemovedBatchItemDoesNotBlockOtherPendingIc() {
  await reset();
  const event = (await db.events.get(eventId))!;
  await db.events.put({ ...event, id: 'second-event', ts: ts(10) });
  let calls = 0;
  const resolver = createExpresswayIcResolutionRunner(async () => ({ icName: '後続IC', distanceM: 40 }));
  const retry = createExpresswayIcRetryBatchRunner(async request => {
    calls += 1;
    if (calls === 1) await db.events.delete(request.eventId);
    return resolver(request);
  });
  assert.equal(await retry(), true);
  assert.equal(calls, 2, 'the second event is still processed after the first record disappears');
  assert.equal((await db.events.get('second-event'))?.extras?.icName, '後続IC');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('synthetic IC test did not make progress')), 2000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function addPendingEvents(count: number, futureBackoff = false) {
  const base = (await db.events.get(eventId))!;
  await db.events.bulkPut(Array.from({ length: count }, (_, index) => ({
    ...base,
    id: index === 0 ? eventId : `synthetic-following-${index}`,
    ts: ts(index),
    extras: {
      icResolveStatus: 'pending',
      icResolveAlgorithmVersion: IC_RESOLVE_ALGORITHM_VERSION,
      ...(futureBackoff ? {
        icResolveRetryCount: 2,
        icResolveNextRetryAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
      } : {}),
    },
  } as AppEvent)));
}

async function testSlowFirstRequestDoesNotBlockLaterEventsAndConcurrencyIsBounded() {
  await reset();
  await addPendingEvents(5);
  const blocked = deferred<IcResult>();
  const laterSaved = deferred<void>();
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const resolver = createExpresswayIcResolutionRunner(async () => {
    const call = ++calls;
    maximumActive = Math.max(maximumActive, ++active);
    try {
      if (call === 1) return await blocked.promise;
      return { icName: '後続合成IC', distanceM: 40 };
    } finally {
      active -= 1;
    }
  });
  let saved = 0;
  const batch = createExpresswayIcRetryBatchRunner(async request => {
    const outcome = await resolver(request);
    if (++saved === 4) laterSaved.resolve();
    return outcome;
  })(5);
  try {
    await within(laterSaved.promise);
    assert.equal(calls, 5, 'the second worker advances through later records while the first is waiting');
    assert.equal((await db.events.toArray()).filter(event => event.extras?.icName).length, 4);
    assert.equal(maximumActive, 2, 'network concurrency stays at two');
  } finally {
    blocked.resolve({ icName: '先頭合成IC', distanceM: 40 });
    await batch;
  }
}

async function testRecoveryDuringTimerBatchPreservesBackoff() {
  await reset();
  await addPendingEvents(2, true);
  await db.events.update(eventId, { extras: {
    icResolveStatus: 'pending', icResolveAlgorithmVersion: IC_RESOLVE_ALGORITHM_VERSION,
  } });
  const started = deferred<void>();
  const complete = deferred<IcResult>();
  const requested: Array<{ id: string; recovery: boolean }> = [];
  const resolver = createExpresswayIcResolutionRunner(async () => {
    if (requested.length === 1) {
      started.resolve();
      return complete.promise;
    }
    return { icName: '復旧合成IC', distanceM: 40 };
  });
  const retry = createExpresswayIcRetryBatchRunner(request => {
    requested.push({ id: request.eventId, recovery: request.resetDeferredBackoff === true });
    return resolver(request);
  });
  const timerBatch = retry(1);
  await within(started.promise);
  const recovery = retry(12, { ignorePendingBackoff: true });
  complete.resolve({ icName: '先頭合成IC', distanceM: 40 });
  assert.equal(await recovery, true);
  await timerBatch;
  assert.deepEqual(requested, [
    { id: eventId, recovery: false },
  ]);
  assert.equal((await db.events.get('synthetic-following-1'))?.extras?.icName, undefined);
  assert.equal((await db.events.get('synthetic-following-1'))?.extras?.icResolveRetryCount, 2);
}

async function testRecoveryRespectsBatchLimitWithoutRepeatingFailures() {
  await reset();
  await addPendingEvents(13);
  const requested = new Map<string, number>();
  let retry!: ReturnType<typeof createExpresswayIcRetryBatchRunner>;
  const resolver = createExpresswayIcResolutionRunner(async () => {
    // Model TOKEN_REFRESHED raised by the resolver's own refresh request.
    void retry(12, { ignorePendingBackoff: true });
    throw new IcResolverError('synthetic device approval unavailable', true, 403);
  });
  retry = createExpresswayIcRetryBatchRunner(request => {
    requested.set(request.eventId, (requested.get(request.eventId) ?? 0) + 1);
    return resolver(request);
  });
  assert.equal(await within(retry(12, { ignorePendingBackoff: true })), false);
  assert.equal(requested.size, 12, 'one recovery is limited to twelve due events');
  assert.ok([...requested.values()].every(count => count === 1), 'each event is attempted once per recovery');
  const saved = await db.events.toArray();
  assert.equal(saved.filter(event => event.extras?.icResolveRetryCount === 1).length, 12);
  assert.equal(await retry(12), false, 'the next tick reaches the remaining unattempted event');
  assert.equal([...requested.values()].reduce((sum, count) => sum + count, 0), 13);
}

async function testTimerBatchSelectionDoesNotStarveUnattemptedRecords() {
  await reset();
  await addPendingEvents(5);
  const actualNow = Date.now;
  let now = actualNow();
  Date.now = () => now;
  const requested: string[] = [];
  const resolver = createExpresswayIcResolutionRunner(async () => {
    throw new IcResolverError('synthetic transport failure', true);
  });
  const retry = createExpresswayIcRetryBatchRunner(request => {
    requested.push(request.eventId);
    return resolver(request);
  });
  try {
    await retry(2);
    now += 20_000;
    await retry(2);
    assert.equal(new Set(requested).size, 4, 'a due retry of the newest rows does not hide unattempted older rows');
  } finally {
    Date.now = actualNow;
  }
}

async function testForcedJoinDoesNotResetDeferredImmediateRequest() {
  await reset();
  const started = deferred<void>();
  const continueFirst = deferred<void>();
  let calls = 0;
  let run!: ReturnType<typeof createExpresswayIcResolutionRunner>;
  run = createExpresswayIcResolutionRunner(async () => {
    if (++calls === 1) {
      started.resolve();
      await continueFirst.promise;
      throw new IcResolverError('synthetic expired session', true, 401);
    }
    void run({ eventId, source: 'retry', resetDeferredBackoff: true });
    return { icName: '復旧合成IC', distanceM: 40 };
  });
  const immediate = run({ eventId, source: 'immediate' });
  await within(started.promise);
  const recovery = run({ eventId, source: 'retry', resetDeferredBackoff: true });
  assert.equal(immediate, recovery, 'joining callers retain one shared request');
  continueFirst.resolve();
  assert.equal((await within(recovery)).status, 'deferred');
  assert.equal(calls, 1, 'a joined recovery retains one request and persisted backoff');
  assert.equal((await savedExtras()).icResolveRetryCount, 1);
  assert.equal((await savedExtras()).icName, undefined);
}

async function testRepeatedAuthorizationFailureCannotLoopThroughRecovery() {
  await reset();
  const requested: string[] = [];
  let retry!: ReturnType<typeof createExpresswayIcRetryBatchRunner>;
  const resolver = createExpresswayIcResolutionRunner(async () => {
    void retry(12, { ignorePendingBackoff: true });
    throw new IcResolverError('synthetic refreshed session still rejected', true, 401);
  });
  retry = createExpresswayIcRetryBatchRunner(request => {
    requested.push(request.eventId);
    return resolver(request);
  });
  assert.equal(await within(retry(4)), false);
  assert.equal(requested.length, 1, 'a token refresh raised by the timer batch cannot trigger another pass');
  assert.equal((await savedExtras()).icResolveRetryCount, 1);
}

async function testMountedDetailQueryRefreshesResolvedIcAndRemoteWrites() {
  await reset();
  await db.events.put({
    id: 'synthetic-trip-start', tripId, type: 'trip_start', ts: ts(-60),
    extras: { odoKm: 100 }, syncStatus: 'pending',
  } as AppEvent);
  await db.events.put({
    id: 'synthetic-expressway-start', tripId, type: 'expressway_start', ts: ts(-30),
    extras: {}, syncStatus: 'pending',
  } as AppEvent);
  const initial = deferred<void>();
  const resolved = deferred<void>();
  const remoteUpdate = deferred<void>();
  const seenNames: string[] = [];
  const subscription = liveQuery(() => getEventsByTripId(tripId)).subscribe(events => {
    initial.resolve();
    const name = events.find(event => event.id === eventId)?.extras?.icName;
    if (typeof name !== 'string') return;
    seenNames.push(name);
    const report = buildTripDetailReportSnapshot({
      tripId, events, dayRuns: [], fallbackLabel: '合成日報',
    }, '', timestamp);
    assert.equal(report.days.flatMap(day => day.events).find(event => event.extras?.icName)?.extras?.icName, name);
    if (name === '合成解決IC') resolved.resolve();
    if (name === '合成同期IC') remoteUpdate.resolve();
  });
  try {
    await within(initial.promise);
    const run = createExpresswayIcResolutionRunner(async () => ({ icName: '合成解決IC', distanceM: 40 }));
    await run({ eventId, source: 'immediate' });
    await within(resolved.promise);
    // Direct writes intentionally send no window notification, as with sync.
    await db.events.update(eventId, { extras: { ...(await savedExtras()), icName: '合成同期IC' } });
    await within(remoteUpdate.promise);
    assert.deepEqual(seenNames, ['合成解決IC', '合成同期IC']);
  } finally {
    subscription.unsubscribe();
  }
}

async function testValidPrimaryMissRecoversUsingRouteAndRecordsOrigin() {
  await reset([point('route', -20, 500)]);
  const { run, calls } = runnerWithResults([null, { icName: '合成IC', distanceM: 100 }]);
  assert.equal((await run()).status, 'resolved');
  assert.equal(calls.length, 2);
  const extras = await savedExtras();
  assert.equal(extras.icName, '合成IC');
  assert.equal(extras.icDistanceM, 100, 'distance remains the IC distance from the queried route fix');
  assert.equal(extras.icResolveGeoSource, 'route');
  assert.equal(extras.icResolveGeoOffsetSeconds, -20);
  assert.equal(extras.icResolveAlgorithmVersion, IC_RESOLVE_ALGORITHM_VERSION);
}

async function testMissingPrimaryRetainsNearestHistoricalFallback() {
  await reset([
    point('near-unknown', -10, 100, { accuracy: undefined }),
    point('far-known', -20, 500),
  ], { geo: undefined });
  const { run, calls } = runnerWithResults([{ icName: '合成IC', distanceM: 70 }]);
  assert.equal((await run()).status, 'resolved');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].lat, geoAt(100).lat);
  assert.equal((await savedExtras()).icResolveGeoOffsetSeconds, -10);
}

async function testInvalidAndUnrelatedRouteFixesAreNotQueried() {
  await reset([
    point('future', 31, 600),
    point('old', -91, 600),
    point('far', -10, 2100),
    point('coarse', -10, 600, { accuracy: 101 }),
    point('negative-accuracy', -10, 600, { accuracy: -1 }),
    point('nan-accuracy', -10, 600, { accuracy: NaN }),
    point('unknown-accuracy', -10, 600, { accuracy: undefined }),
    point('invalid-lat', -10, 600, { lat: 91 }),
    point('invalid-lng', -10, 600, { lng: 181 }),
    point('invalid-time', -10, 600, { ts: 'invalid' }),
    point('event-copy', -10, 600, { source: 'event' }),
    point('other-trip', -10, 600, { tripId: 'other-trip' }),
    point('too-close', -10, 100),
    point('valid', -20, 500),
    point('duplicate', -21, 500),
    point('dense-fix', -22, 510),
  ]);
  const { run, calls } = runnerWithResults([null, { icName: '合成IC', distanceM: 90 }]);
  assert.equal((await run()).status, 'resolved');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].lat, geoAt(500).lat);
}

async function testDelayedEndConfirmationUsesDetectionTime() {
  await reset([
    point('detection-route', -10, 400),
    point('confirmation-route', 110, 700),
  ], {
    ts: ts(120),
    extras: {
      icResolveStatus: 'pending',
      autoDecision: { source: 'native-auto', action: 'end-prompt', evaluatedAt: timestamp },
    },
  });
  const { run, calls } = runnerWithResults([null, { icName: '合成IC', distanceM: 60 }]);
  assert.equal((await run()).status, 'resolved');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].lat, geoAt(400).lat);
  assert.equal((await savedExtras()).icResolveGeoOffsetSeconds, -10);
}

async function testUntrustedDetectionMetadataUsesEventTimestamp() {
  for (const reason of [
    { source: 'manual', action: 'end-prompt', evaluatedAt: ts(-120) },
    { source: 'native-auto', action: 'start', evaluatedAt: ts(-120) },
    { source: 'native-auto', action: 'end-prompt', evaluatedAt: 'invalid' },
    { source: 'native-auto', action: 'end-prompt', evaluatedAt: ts(1) },
  ]) {
    assert.equal(getIcResolutionReferenceTs({
      type: 'expressway_end', ts: timestamp, extras: { autoDecision: reason },
    }), timestamp);
  }
  assert.equal(getIcResolutionReferenceTs({
    type: 'expressway_start', ts: timestamp,
    extras: { autoDecision: { source: 'native-auto', action: 'end-prompt', evaluatedAt: ts(-120) } },
  }), timestamp);
}

async function testConflictingCandidatesRemainUnresolved() {
  await reset([point('before', -10, 400), point('earlier', -50, -400)]);
  const { run, calls } = runnerWithResults([
    null, { icName: '合成北IC', distanceM: 80 }, { icName: '合成南IC', distanceM: 60 },
  ]);
  assert.equal((await run()).status, 'failed');
  assert.equal(calls.length, 3);
  const extras = await savedExtras();
  assert.equal(extras.icName, undefined);
  assert.equal(extras.icResolveStatus, 'failed');
  assert.match(String(extras.icResolveError), /一致しない/);
}

async function testFormattingDifferencesDoNotCauseFalseConflict() {
  await reset([point('before', -10, 400), point('earlier', -50, -400)]);
  const { run } = runnerWithResults([
    null, { icName: '合成 ＩＣ', distanceM: 80 }, { icName: '合成インターチェンジ', distanceM: 60 },
  ]);
  assert.equal((await run()).status, 'resolved');
  assert.equal((await savedExtras()).icName, '合成インターチェンジ');
}

async function testCandidateDistanceIsBoundedFromOriginalFix() {
  await reset([point('far-within-window', -45, 1800)]);
  const { run } = runnerWithResults([null, { icName: '遠い合成IC', distanceM: 300 }]);
  assert.equal((await run()).status, 'failed');
  assert.equal((await savedExtras()).icName, undefined);
}

async function testSupplementCountAndTemporalDiversityAreBounded() {
  const points = [
    point('near', -1, 400),
    point('near-dense', -2, 410),
    point('middle', -30, 800),
    point('oldest', -90, 1200),
    point('later', 30, -800),
  ];
  const selected = selectIcResolutionSupplementalPoints(points, timestamp, 'expressway_end', originalGeo);
  assert.equal(selected.length, 3);
  assert.equal(selected[0].ts, ts(-1));
  assert.ok(selected.some(p => p.ts === ts(-90)), 'the older independent fix is covered');
  assert.ok(selected.some(p => p.ts === ts(30)), 'the permitted future boundary is covered');
  await reset(points);
  const { run, calls } = runnerWithResults([null, null, null, null]);
  assert.equal((await run()).status, 'failed');
  assert.equal(calls.length, 4);
}

async function testNetworkFailureIsDeferredWithoutTryingOtherPoints() {
  await reset([point('route', -20, 500)]);
  const { run, calls } = runnerWithResults([new IcResolverError('synthetic timeout', true)]);
  const result = await run();
  assert.equal(result.status, 'deferred');
  assert.equal(calls.length, 1);
  const extras = await savedExtras();
  assert.equal(extras.icResolveStatus, 'pending');
  assert.equal(extras.icResolveRetryCount, 1);
  assert.ok(Date.parse(String(extras.icResolveNextRetryAt)) > Date.now());
}

async function testPartialSupplementNetworkFailureDoesNotFinalizeEarlierCandidate() {
  await reset([point('before', -10, 400), point('earlier', -50, -400)]);
  const { run } = runnerWithResults([
    null, { icName: '合成IC', distanceM: 80 }, new IcResolverError('synthetic unavailable', true, 503),
  ]);
  assert.equal((await run()).status, 'deferred');
  const extras = await savedExtras();
  assert.equal(extras.icResolveStatus, 'pending');
  assert.equal(extras.icName, undefined);
}

async function testConcurrentManualCorrectionWinsOverDelayedLookup() {
  await reset([point('route', -20, 500)]);
  let notifyLookup!: () => void;
  const lookupStarted = new Promise<void>(resolve => { notifyLookup = resolve; });
  let completeLookup!: (result: IcResult) => void;
  const delayed = new Promise<IcResult>(resolve => { completeLookup = resolve; });
  let calls = 0;
  const run = createExpresswayIcResolutionRunner(async () => {
    calls += 1;
    if (calls === 1) return null;
    notifyLookup();
    return delayed;
  });
  const running = run({ eventId, source: 'retry' });
  assert.equal(run({ eventId, source: 'retry' }), running, 'duplicate requests share the pending network work');
  await lookupStarted;
  await db.events.update(eventId, {
    extras: {
      icName: '手動合成IC', icResolveStatus: 'resolved',
      icResolvedManually: true, icResolveManualUpdatedAt: ts(10),
    },
  });
  completeLookup({ icName: '古い自動候補IC', distanceM: 50 });
  const outcome = await running;
  assert.equal(outcome.status, 'deferred', 'a discarded stale lookup must not be reported as a saved result');
  const extras = await savedExtras();
  assert.equal(extras.icName, '手動合成IC');
  assert.equal(extras.icResolvedManually, true);
  assert.equal(extras.icResolveGeoSource, undefined, 'stale result cannot overwrite provenance either');
}

async function testExistingManualNameSurvivesNetworkFailure() {
  await reset([], { extras: { icName: '手動合成IC', icResolveStatus: 'resolved', icResolvedManually: true } });
  const { run } = runnerWithResults([new IcResolverError('synthetic timeout', true)]);
  assert.equal((await run()).status, 'deferred');
  const extras = await savedExtras();
  assert.equal(extras.icResolveStatus, 'resolved');
  assert.equal(extras.icName, '手動合成IC');
}

async function testTemporaryAndAuthFailuresHaveFinitePersistedBudget() {
  for (const status of [503, 403]) {
    await reset();
    const actualNow = Date.now;
    let now = actualNow();
    Date.now = () => now;
    let calls = 0;
    const resolve = async () => { calls += 1; throw new IcResolverError('synthetic unavailable', true, status); };
    try {
      for (let attempt = 1; attempt <= IC_RESOLVE_RETRY_LIMIT; attempt += 1) {
        // Recreate the runner and reopen storage: budgets must survive restart.
        if (attempt > 1) { db.close(); await db.open(); }
        const run = createExpresswayIcResolutionRunner(resolve);
        const outcome = await run({ eventId, source: 'retry', resetDeferredBackoff: true });
        const extras = await savedExtras();
        assert.equal(extras.icResolveRetryCount, attempt);
        if (attempt < IC_RESOLVE_RETRY_LIMIT) {
          assert.equal(outcome.status, 'deferred');
          assert.equal(extras.icResolveStatus, 'pending');
          await createExpresswayIcRetryBatchRunner(run)(12, { ignorePendingBackoff: true });
          assert.equal(calls, attempt, 'online/auth/startup triggers respect the stored delay');
          now = Date.parse(String(extras.icResolveNextRetryAt)) + 1;
        } else {
          assert.equal(outcome.status, 'failed');
          assert.equal(extras.icResolveStatus, 'failed');
          assert.equal(extras.icResolveNextRetryAt, undefined);
        }
      }
      await createExpresswayIcRetryBatchRunner(createExpresswayIcResolutionRunner(resolve))(12, { ignorePendingBackoff: true });
      assert.equal(calls, IC_RESOLVE_RETRY_LIMIT);
      await createExpresswayIcResolutionRunner(resolve)({ eventId, source: 'manual' });
      assert.equal((await savedExtras()).icResolveRetryCount, 1, 'explicit manual retry starts a new finite series');
    } finally {
      Date.now = actualNow;
    }
  }
}

async function testEstimatePendingSurvivesFailureOfflineAndRestart() {
  const estimate = { displayName: '合成入口（推定）', candidateNames: ['合成入口'],
    source: 'synthetic-address', note: 'synthetic evidence', estimatedAt: timestamp };
  await reset([], { extras: { icName: '合成入口（推定）', icNameEstimate: estimate,
    icResolveStatus: 'pending', icResolveRetryCount: 2, icResolveAlgorithmVersion: IC_RESOLVE_ALGORITHM_VERSION } });
  const run = createExpresswayIcResolutionRunner(async () => { throw new IcResolverError('synthetic timeout', true); });
  assert.equal((await run({ eventId, source: 'retry' })).status, 'deferred');
  const before = await savedExtras();
  assert.equal(before.icName, estimate.displayName);
  assert.deepEqual(before.icNameEstimate, estimate);
  db.close(); await db.open();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } });
  try {
    assert.equal((await run({ eventId, source: 'manual' })).status, 'deferred');
    assert.deepEqual(await savedExtras(), before, 'offline restart never removes saved estimate or retry state');
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  }
}

async function testManualRetryNeverOverwritesExistingManualName() {
  await reset([], { extras: { icName: '手動合成IC', icResolveStatus: 'resolved', icResolvedManually: true } });
  let requests = 0;
  const run = createExpresswayIcResolutionRunner(async () => { requests += 1; return { icName: '別合成IC', distanceM: 50 }; });
  assert.equal((await run({ eventId, source: 'manual' })).status, 'deferred');
  assert.equal(requests, 0);
  assert.equal((await savedExtras()).icName, '手動合成IC');
}

async function testEstimateResponseSavesProvenanceAndEventContext() {
  await reset([], { type: 'expressway_start' });
  const before = (await db.events.get(eventId))!;
  const run = createExpresswayIcResolutionRunner(async (_lat, _lng, _radius, context) => {
    assert.deepEqual(context, { eventType: 'expressway_start' });
    return { icName: '合成入口', distanceM: 90, confidence: 'estimated',
      candidates: ['合成入口', '別合成入口'], estimateSource: 'overpass_nearby',
      sourceUrls: ['https://www.openstreetmap.org/copyright'], note: 'direction remains unknown' };
  });
  assert.equal((await run({ eventId, source: 'immediate' })).status, 'resolved');
  const saved = (await db.events.get(eventId))!;
  assert.equal(saved.extras?.icName, '合成入口');
  assert.equal(saved.extras?.icResolveStatus, 'resolved');
  assert.deepEqual((saved.extras?.icNameEstimate as Record<string, unknown>)?.candidateNames, ['合成入口', '別合成入口']);
  assert.equal((saved.extras?.icNameEstimate as Record<string, unknown>)?.certainty, 'ambiguous_candidates');
  assert.equal(saved.ts, before.ts);
  assert.deepEqual(saved.geo, before.geo);
  assert.equal(saved.type, before.type);
}

async function testRetrySuccessRetainsOldEstimateEvidence() {
  const estimate = { displayName: '旧合成候補（推定）', candidateNames: ['旧合成候補'],
    source: 'synthetic-address', note: 'synthetic evidence', estimatedAt: timestamp };
  await reset([], { extras: { icName: estimate.displayName, icNameEstimate: estimate, icResolveStatus: 'pending' } });
  const run = createExpresswayIcResolutionRunner(async () => { throw new IcResolverError('synthetic timeout', true); });
  assert.equal((await run({ eventId, source: 'retry' })).status, 'deferred');
  db.close(); await db.open();
  const retry = createExpresswayIcResolutionRunner(async () => ({
    icName: '新合成候補', distanceM: 80, confidence: 'estimated', candidates: ['新合成候補'],
  }));
  assert.equal((await retry({ eventId, source: 'manual' })).status, 'resolved');
  const extras = await savedExtras();
  assert.equal(extras.icName, '新合成候補');
  assert.equal(extras.icResolveRetryCount, 0);
  assert.equal(extras.icResolveNextRetryAt, undefined);
  assert.equal(extras.icResolveError, undefined);
  assert.ok((extras.icNameEstimateHistory as Array<Record<string, unknown>>).some(item => item.displayName === estimate.displayName),
    'a successful retry preserves the prior candidate and its evidence');
  db.close(); await db.open();
  assert.deepEqual(await savedExtras(), extras, 'the replacement estimate and history survive restart');
}

async function testOfflineCatalogResolvesOldExhaustedEventWithoutRequests() {
  await reset([], { extras: { icResolveStatus: 'failed', icResolveAlgorithmVersion: IC_RESOLVE_ALGORITHM_VERSION - 1,
    icResolveRetryCount: 6, icResolveError: 'old synthetic upstream failure', expresswaySessionId: 'synthetic-preserved-session', odoKm: 1234 } });
  const original = (await db.events.get(eventId))!;
  let requests = 0;
  const run = createExpresswayIcResolutionRunner(async () => {
    requests += 1; throw new Error('offline must not invoke the network adapter');
  }, (_lat, _lon, context) => {
    assert.equal(context?.eventType, 'expressway_end');
    return { icName: '合成公的IC（推定）', distanceM: 100, confidence: 'estimated', candidates: ['合成公的IC'],
      estimateSource: 'mlit_n06_2025', sourceDatasetDate: '2025-12-31', sourceUrls: ['https://example.invalid/public-dataset'],
      note: '2025-12-31現況の候補。入口・出口・進行方向未確認。' };
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } });
  try {
    assert.equal(await createExpresswayIcRetryBatchRunner(run, true)(12), true);
    assert.equal(requests, 0);
    const saved = (await db.events.get(eventId))!;
    assert.equal(saved.extras?.icResolveStatus, 'resolved');
    assert.equal(saved.extras?.icResolveAlgorithmVersion, IC_RESOLVE_ALGORITHM_VERSION);
    assert.equal(saved.extras?.icResolveRetryCount, 0);
    assert.equal(saved.extras?.icResolveError, undefined);
    assert.equal((saved.extras?.icNameEstimate as Record<string, unknown>)?.source, 'mlit_n06_2025');
    assert.equal((saved.extras?.icNameEstimate as Record<string, unknown>)?.sourceDatasetDate, '2025-12-31');
    assert.equal(saved.extras?.expresswaySessionId, original.extras?.expresswaySessionId);
    assert.equal(saved.extras?.odoKm, original.extras?.odoKm);
    assert.equal(saved.ts, original.ts);
    assert.deepEqual(saved.geo, original.geo);
    db.close(); await db.open();
    assert.deepEqual((await db.events.get(eventId))?.extras, saved.extras);
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  }
}

async function testOfflineCatalogMissKeepsLastErrorAndBudget() {
  await reset([], { extras: { icResolveStatus: 'pending', icResolveAlgorithmVersion: IC_RESOLVE_ALGORITHM_VERSION - 1,
    icResolveRetryCount: 2, icResolveError: 'old synthetic timeout', icResolveNextRetryAt: '2026-09-18T04:00:00Z' } });
  const before = await savedExtras();
  let requests = 0;
  const run = createExpresswayIcResolutionRunner(async () => { requests += 1; return null; }, () => null);
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } });
  try {
    assert.equal(await createExpresswayIcRetryBatchRunner(run, true)(12), false);
    assert.equal(requests, 0);
    assert.deepEqual(await savedExtras(), before);
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  }
}

async function testAddressAloneCannotInferAnIcName() {
  await reset([], { geo: undefined, address: '合成市合成区（その他）' });
  let lookups = 0;
  const run = createExpresswayIcResolutionRunner(async () => { lookups += 1; return null; }, () => { lookups += 1; return null; });
  assert.equal((await run({ eventId, source: 'manual' })).status, 'failed');
  assert.equal(lookups, 0, 'a broad address cannot be used as an IC coordinate or an entrance selection');
  assert.equal((await savedExtras()).icName, undefined);
  assert.match(String((await savedExtras()).icResolveError), /有効な位置情報/);
  assert.equal((await db.events.get(eventId))?.ts, timestamp);
}

async function testLocalSupplementPrecedesFailingExternalLookup() {
  for (const online of [true, false]) {
    await reset([point('synthetic-local-supplement', -20, 500)]);
    let requests = 0;
    const localQueries: number[] = [];
    const run = createExpresswayIcResolutionRunner(async () => {
      requests += 1; throw new IcResolverError('synthetic unavailable upstream', true, 503);
    }, (lat) => {
      localQueries.push(lat);
      return lat === originalGeo.lat ? null : {
        icName: '合成補足IC（推定）', distanceM: 100, confidence: 'estimated',
        candidates: ['合成補足IC'], estimateSource: 'mlit_n06_2025', sourceDatasetDate: '2025-12-31',
      };
    });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: online } });
    try {
      assert.equal((await run({ eventId, source: 'retry' })).status, 'resolved');
      assert.equal(requests, 0, 'all bounded local route fixes precede external lookup regardless of connectivity');
      assert.deepEqual(localQueries, [originalGeo.lat, geoAt(500).lat]);
      const saved = await savedExtras();
      assert.equal(saved.icName, '合成補足IC（推定）');
      assert.equal(saved.icResolveGeoSource, 'route');
      assert.equal(saved.icResolveGeoOffsetSeconds, -20);
      assert.ok(Number(saved.icDistanceM) >= 600 && Number(saved.icDistanceM) <= 601, 'supplement distance is an upper bound from the original event');
      assert.equal((saved.icNameEstimate as Record<string, unknown>).source, 'mlit_n06_2025');
      assert.equal((await db.events.get(eventId))?.ts, timestamp);
    } finally {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
    }
  }
}

async function testDifferentLocalSupplementsRemainUnconfirmedCandidates() {
  await reset([point('synthetic-local-before', -10, 400), point('synthetic-local-earlier', -50, -400)]);
  let requests = 0;
  const run = createExpresswayIcResolutionRunner(async () => { requests += 1; return null; }, lat => {
    if (lat === originalGeo.lat) return null;
    const name = lat > originalGeo.lat ? '合成北IC' : '合成南IC';
    return { icName: `${name}（推定）`, distanceM: 80, confidence: 'estimated',
      candidates: [name], estimateSource: 'mlit_n06_2025' };
  });
  assert.equal((await run({ eventId, source: 'retry' })).status, 'resolved');
  assert.equal(requests, 0, 'different local candidates do not need a remote request to pick a winner');
  const saved = await savedExtras();
  const estimate = saved.icNameEstimate as Record<string, unknown>;
  assert.deepEqual(new Set(estimate.candidateNames as string[]), new Set(['合成北IC', '合成南IC']));
  assert.equal(estimate.certainty, 'ambiguous_candidates');
  assert.match(String(estimate.note), /保存軌跡.*元イベント.*未確認/);
  assert.ok(Number(saved.icDistanceM) >= 480 && Number(saved.icDistanceM) <= 481);
}

async function testLocalSupplementBoundsEveryAlternativeFromOriginalEvent() {
  for (const offset of [500, 1000]) {
    await reset([point('synthetic-multiple-local', -20, offset)]);
    let requests = 0;
    const run = createExpresswayIcResolutionRunner(async () => { requests += 1; return null; }, lat => {
      if (lat === originalGeo.lat) return null;
      return { icName: '合成近傍IC（推定）', distanceM: 80, confidence: 'estimated',
        candidates: ['合成近傍IC', '合成別IC'], estimateSource: 'mlit_n06_2025' };
    });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } });
    try {
      const outcome = await run({ eventId, source: 'retry' });
      assert.equal(requests, 0);
      if (offset === 500) {
        assert.equal(outcome.status, 'resolved');
        assert.deepEqual(((await savedExtras()).icNameEstimate as Record<string, unknown>).candidateNames, ['合成近傍IC', '合成別IC']);
        assert.ok(Number((await savedExtras()).icDistanceM) >= 1700 && Number((await savedExtras()).icDistanceM) <= 1701);
      } else {
        assert.equal(outcome.status, 'deferred');
        assert.equal((await savedExtras()).icName, undefined, 'an unbounded alternative is not hidden by keeping only the representative');
      }
    } finally {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
    }
  }
}

async function testLocalSupplementUnionOverflowDoesNotTruncateCandidates() {
  await reset([point('synthetic-overflow-before', -10, 400), point('synthetic-overflow-earlier', -50, -400)]);
  const before = await savedExtras();
  let requests = 0;
  let supplements = 0;
  const run = createExpresswayIcResolutionRunner(async () => { requests += 1; return null; }, lat => {
    if (lat === originalGeo.lat) return null;
    supplements += 1;
    const prefix = lat > originalGeo.lat ? '合成北' : '合成南';
    const candidates = Array.from({ length: 7 }, (_, index) => `${prefix}${index + 1}IC`);
    return { icName: `${candidates[0]}（推定）`, distanceM: 80, confidence: 'estimated',
      candidates, estimateSource: 'mlit_n06_2025' };
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } });
  try {
    const result = await run({ eventId, source: 'retry' });
    assert.equal(supplements, 2, 'two individually valid seven-name results are combined');
    assert.equal(result.status, 'deferred');
    assert.equal(requests, 0);
    assert.deepEqual(await savedExtras(), before, 'a fourteen-name union is rejected without saving a truncated subset');
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  }
}

async function testOnlineLocalUnionOverflowCannotFallbackToSharedRepresentative() {
  const estimate = { displayName: '既存合成候補（推定）', candidateNames: ['既存合成候補'],
    source: 'overpass_nearby', note: 'synthetic prior evidence', certainty: 'estimated',
    sourceUrls: ['https://example.invalid/synthetic-evidence'], estimatedAt: ts(-60) };
  const history = [{ ...estimate, displayName: '前の合成候補（推定）', candidateNames: ['前の合成候補'], estimatedAt: ts(-90) }];
  await reset([point('synthetic-shared-before', -10, 400), point('synthetic-shared-earlier', -50, -400)], {
    extras: { icName: estimate.displayName, icNameEstimate: estimate, icNameEstimateHistory: history,
      icResolveStatus: 'pending', icResolveAlgorithmVersion: IC_RESOLVE_ALGORITHM_VERSION,
      icResolveRetryCount: IC_RESOLVE_RETRY_LIMIT - 1, icResolveNextRetryAt: ts(-1) },
  });
  let requests = 0;
  let localCalls = 0;
  const lookupLocal = (lat: number): IcResult | null => {
    localCalls += 1;
    if (lat === originalGeo.lat) return null;
    const prefix = lat > originalGeo.lat ? '合成北' : '合成南';
    // Seven names per fix, a common representative, thirteen names in total.
    const candidates = ['共通合成IC', ...Array.from({ length: 6 }, (_, index) => `${prefix}${index + 1}IC`)];
    return { icName: '共通合成IC（推定）', distanceM: 80, confidence: 'estimated',
      candidates, estimateSource: 'mlit_n06_2025' };
  };
  const run = createExpresswayIcResolutionRunner(async lat => {
    requests += 1;
    return lookupLocal(lat); // Model the production fallback's catalog-first behavior.
  }, lookupLocal);
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  assert.equal((await run({ eventId, source: 'retry' })).status, 'failed');
  assert.equal(requests, 0, 'overflow stops before the online fallback can save a seven-name subset');
  const saved = await savedExtras();
  assert.equal(saved.icName, estimate.displayName);
  assert.deepEqual(saved.icNameEstimate, estimate);
  assert.deepEqual(saved.icNameEstimateHistory, history);
  assert.equal(saved.icResolveRetryCount, IC_RESOLVE_RETRY_LIMIT);
  assert.equal(saved.icResolveStatus, 'failed');
  assert.equal(saved.icResolveNextRetryAt, undefined);
  assert.match(String(saved.icResolveError), /候補が上限/);
  assert.equal((await run({ eventId, source: 'retry' })).status, 'deferred');
  assert.equal(localCalls, 3, 'an exhausted attempt budget prevents further automatic catalog searches');
  assert.equal(requests, 0);
}

async function testManualCorrectionClearsAutomaticOriginMetadata() {
  await reset([], {
    extras: { icName: '自動合成IC', icResolveStatus: 'resolved', icResolveGeoSource: 'route', icResolveGeoOffsetSeconds: -20 },
  });
  await updateExpresswayIcNameManual(eventId, '手動合成IC');
  const extras = await savedExtras();
  assert.equal(extras.icName, '手動合成IC');
  assert.equal(extras.icResolveGeoSource, undefined);
  assert.equal(extras.icResolveGeoOffsetSeconds, undefined);
}

const tests = [
  testPrimarySuccessDoesNotQueryAdditionalPoints,
  testConcurrentAddressCompletionKeepsResolvedIcAndReport,
  testRelevantEventEditsRejectStaleIcAndDoNotReportSuccess,
  testQueuedGeoHintCannotReplaceCorrectedSavedLocation,
  testDiscardedFailureDoesNotReportBatchUpdate,
  testRemovedBatchItemDoesNotBlockOtherPendingIc,
  testSlowFirstRequestDoesNotBlockLaterEventsAndConcurrencyIsBounded,
  testRecoveryDuringTimerBatchPreservesBackoff,
  testRecoveryRespectsBatchLimitWithoutRepeatingFailures,
  testTimerBatchSelectionDoesNotStarveUnattemptedRecords,
  testForcedJoinDoesNotResetDeferredImmediateRequest,
  testRepeatedAuthorizationFailureCannotLoopThroughRecovery,
  testMountedDetailQueryRefreshesResolvedIcAndRemoteWrites,
  testValidPrimaryMissRecoversUsingRouteAndRecordsOrigin,
  testMissingPrimaryRetainsNearestHistoricalFallback,
  testInvalidAndUnrelatedRouteFixesAreNotQueried,
  testDelayedEndConfirmationUsesDetectionTime,
  testUntrustedDetectionMetadataUsesEventTimestamp,
  testConflictingCandidatesRemainUnresolved,
  testFormattingDifferencesDoNotCauseFalseConflict,
  testCandidateDistanceIsBoundedFromOriginalFix,
  testSupplementCountAndTemporalDiversityAreBounded,
  testNetworkFailureIsDeferredWithoutTryingOtherPoints,
  testPartialSupplementNetworkFailureDoesNotFinalizeEarlierCandidate,
  testConcurrentManualCorrectionWinsOverDelayedLookup,
  testExistingManualNameSurvivesNetworkFailure,
  testManualCorrectionClearsAutomaticOriginMetadata,
  testTemporaryAndAuthFailuresHaveFinitePersistedBudget,
  testEstimatePendingSurvivesFailureOfflineAndRestart,
  testManualRetryNeverOverwritesExistingManualName,
  testEstimateResponseSavesProvenanceAndEventContext,
  testRetrySuccessRetainsOldEstimateEvidence,
  testOfflineCatalogResolvesOldExhaustedEventWithoutRequests,
  testOfflineCatalogMissKeepsLastErrorAndBudget,
  testAddressAloneCannotInferAnIcName,
  testLocalSupplementPrecedesFailingExternalLookup,
  testDifferentLocalSupplementsRemainUnconfirmedCandidates,
  testLocalSupplementBoundsEveryAlternativeFromOriginalEvent,
  testLocalSupplementUnionOverflowDoesNotTruncateCandidates,
  testOnlineLocalUnionOverflowCannotFallbackToSharedRepresentative,
];

async function main() {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  try {
    await withRemoteSyncSignalsSuppressed(async () => {
      for (const test of tests) {
        await test();
        console.log(`PASS ${test.name}`);
      }
    });
    console.log(`expresswayIcResolution: ${tests.length} integration tests passed`);
  } finally {
    await db.delete();
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
