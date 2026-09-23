import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { withRemoteSyncSignalsSuppressed } from '../app/remoteSyncSignal';
import { db } from '../db/db';
import { updateEventAddress, updateExpresswayIcNameManual } from '../db/repositories';
import type { AppEvent, Geo, RoutePoint } from '../domain/types';
import {
  createExpresswayIcResolutionRunner,
  createExpresswayIcRetryBatchRunner,
  getIcResolutionReferenceTs,
  selectIcResolutionSupplementalPoints,
} from './expresswayIcResolution';
import { IcResolverError, type IcResult } from './icResolver';
import { IC_RESOLVE_ALGORITHM_VERSION } from './expresswayIcRetryPolicy';
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
