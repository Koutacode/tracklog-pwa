import assert from 'node:assert/strict';
import { projectReportResolvedIc } from './reportResolvedIc';
import type { AppEvent } from './types';
import type { Trip } from './reportTypes';
import { mergeIcMetadata, isEstimatedIcName } from './icMetadata';

// Synthetic fixtures only; no production sessions, locations, or trip data.
const trip: Trip = {
  id: 'synthetic-report', label: '合成日報', createdAt: '2026-09-01T00:00:00.000Z', jobs: [],
  rawJson: JSON.stringify({ recordType: 'app_trip_snapshot', sourceTripId: 'synthetic-report' }),
  remoteChangeSeq: 10,
  ownerUserId: 'synthetic-owner', localUpdatedAt: '2026-09-01T00:05:00.000Z',
  days: [{
    dayIndex: 1, dateKey: '2026-09-01', km: 1, odoStart: 100, odoEnd: 101,
    isFirstDay: true, tripStartMin: 0, restStartMin: null, restPlace: '',
    events: [{
      type: 'expressway_start', ts: '2026-09-01T00:00:00.000Z', address: '保存済み合成住所',
      extras: { expresswaySessionId: 'synthetic-session', icResolveStatus: 'pending',
        icResolveNextRetryAt: '2026-09-01T12:00:00.000Z', unrelated: 'retain' },
    }],
  }],
};
const event: AppEvent = {
  id: 'synthetic-start', tripId: trip.id, type: 'expressway_start', ts: trip.days[0].events[0].ts,
  address: '後着合成住所', geo: { lat: 35, lng: 139 }, syncStatus: 'synced', remoteChangeSeq: 9,
  ownerUserId: 'synthetic-owner', localUpdatedAt: '2026-09-01T00:04:00.000Z',
  extras: { expresswaySessionId: 'synthetic-session', icResolveStatus: 'resolved',
    icResolveAlgorithmVersion: 13, icName: '合成開始IC', icDistanceM: 40 },
};
const savedBefore = structuredClone(trip);
const projected = projectReportResolvedIc(trip, [event]);
assert.equal(projected.days[0].events[0].extras?.icName, '合成開始IC');
assert.equal(projected.days[0].events[0].extras?.icResolveStatus, 'resolved');
assert.equal(projected.days[0].events[0].extras?.icResolveNextRetryAt, undefined);
assert.equal(projected.days[0].events[0].extras?.unrelated, 'retain');
assert.equal(projected.days[0].events[0].address, '保存済み合成住所');
assert.equal(projected.rawJson, trip.rawJson);
assert.deepEqual(trip, savedBefore, 'projection does not mutate saved snapshot');
assert.equal(projectReportResolvedIc(trip, []), trip, 'partial sync preserves missing saved rows');
assert.equal(projectReportResolvedIc(trip, [{ ...event, tripId: 'other' }]), trip);
assert.equal(projectReportResolvedIc(trip, [{ ...event, ownerUserId: 'other-owner' }]), trip);
assert.equal(projectReportResolvedIc(trip, [{ ...event, extras: { ...event.extras, expresswaySessionId: 'other' } }]), trip);
assert.equal(projectReportResolvedIc(trip, [event, { ...event, id: 'duplicate' }]), trip, 'ambiguous rows do not guess');
assert.equal(projectReportResolvedIc(trip, [{ ...event, extras: { ...event.extras, icResolveStatus: 'pending' } }])
  .days[0].events[0].extras?.icName, '合成開始IC', 'pending names remain visible without being confirmed');
const pendingNewerAlgorithm = structuredClone(trip);
pendingNewerAlgorithm.days[0].events[0].extras!.icResolveAlgorithmVersion = 14;
assert.equal(projectReportResolvedIc(pendingNewerAlgorithm, [{ ...event, extras: {
  icResolveStatus: 'resolved', icName: '旧形式の合成解決IC',
} }]).days[0].events[0].extras?.icName, '旧形式の合成解決IC',
  'a resolved legacy row may fill an unnamed pending snapshot');
assert.equal(projectReportResolvedIc({ ...trip, rawJson: '{}' }, [event]).days[0].events[0].extras?.icName, undefined,
  'independently imported reports are retained');
const sameSession = projectReportResolvedIc(trip, [{ ...event, ts: '2026-09-01T00:01:00.000Z' }]);
assert.equal(sameSession.days[0].events[0].extras?.icName, '合成開始IC');
assert.equal(sameSession.days[0].events[0].ts, event.ts, 'IC projection does not edit recorded timestamps');

const manual = structuredClone(projected);
manual.days[0].events[0].extras = {
  ...manual.days[0].events[0].extras, icName: '手動合成IC', icResolvedManually: true,
  icResolveManualUpdatedAt: '2026-09-01T00:10:00.000Z',
};
assert.equal(projectReportResolvedIc(manual, [event]), manual,
  'stale automatic canonical data cannot undo the report manual correction');
assert.equal(projectReportResolvedIc(manual, [{ ...event, remoteChangeSeq: 11 }]).days[0].events[0].extras?.icName,
  '手動合成IC', 'a later automatic mutation cannot erase a manual correction');
const newerManual = { ...event, extras: { ...event.extras, icName: '再修正合成IC', icResolvedManually: true,
  icResolveManualUpdatedAt: '2026-09-01T00:11:00.000Z' } };
assert.equal(projectReportResolvedIc(manual, [newerManual]).days[0].events[0].extras?.icName, '再修正合成IC');
assert.equal(projectReportResolvedIc(projected, [{ ...event, extras: { ...event.extras,
  icResolveAlgorithmVersion: 12, icName: '古い合成IC' } }]), projected, 'older resolver results preserve saved resolution');
assert.equal(projectReportResolvedIc(projected, [{ ...event, extras: { ...event.extras,
  icName: '古い同版合成IC' } }]), projected, 'a same-algorithm stale row cannot regress a resolved name');
assert.equal(projectReportResolvedIc(projected, [{ ...event, localUpdatedAt: '2026-09-01T00:06:00.000Z',
  extras: { ...event.extras, icName: '新しい合成IC' } }]).days[0].events[0].extras?.icName, '新しい合成IC');
assert.equal(projectReportResolvedIc(manual, [{ ...newerManual, extras: { ...newerManual.extras,
  icName: '手動合成IC', icResolveManualUpdatedAt: '2026-09-01T00:09:00.000Z' } }]), manual,
  'the same manual name cannot roll back its confirmation timestamp');

const estimate = {
  displayName: '合成A入口／合成B入口（推定候補）', candidateNames: ['合成A入口', '合成B入口'],
  certainty: 'ambiguous_candidates', source: 'saved_address_official_sources',
  sourceUrls: ['https://example.invalid/synthetic-source'], note: '住所由来、実際の入口と方向は未確認',
  estimatedAt: '2026-09-01T00:03:00.000Z',
};
const estimatedEvent = { ...event, extras: { ...event.extras, icName: estimate.displayName,
  icNameEstimate: estimate, icResolveStatus: 'pending', icResolveRetryCount: 2 } };
const estimatedReport = projectReportResolvedIc(trip, [estimatedEvent]);
assert.equal(estimatedReport.days[0].events[0].extras?.icName, estimate.displayName);
assert.deepEqual(estimatedReport.days[0].events[0].extras?.icNameEstimate, estimate);
assert.equal(estimatedReport.days[0].events[0].extras?.icResolveStatus, 'pending', 'projection never promotes an estimate');
const failed = projectReportResolvedIc(estimatedReport, [{ ...event, remoteChangeSeq: 12, extras: {
  icResolveStatus: 'failed', icResolveRetryCount: 6, icResolveLastAttemptAt: '2026-09-01T00:20:00.000Z',
  icResolveError: 'synthetic timeout',
} }]);
assert.equal(failed.days[0].events[0].extras?.icName, estimate.displayName, 'failed retry preserves saved estimate');
assert.equal(failed.days[0].events[0].extras?.icResolveStatus, 'failed');
assert.deepEqual(failed.days[0].events[0].extras?.icNameEstimate, estimate);
const noNameFailed = projectReportResolvedIc(trip, [{ ...event, extras: {
  icResolveStatus: 'failed', icResolveRetryCount: 6, icResolveLastAttemptAt: '2026-09-01T00:20:00.000Z',
} }]);
assert.equal(noNameFailed.days[0].events[0].extras?.icResolveStatus, 'failed', 'unnamed status reaches reports');
assert.equal(noNameFailed.days[0].events[0].extras?.icName, undefined);
assert.deepEqual(noNameFailed.days[0].odoStart, trip.days[0].odoStart);
assert.equal(noNameFailed.days[0].events[0].ts, trip.days[0].events[0].ts);

const corrected = mergeIcMetadata(estimatedEvent.extras, {
  icName: '手動合成C入口', icResolvedManually: true, icResolveManualUpdatedAt: '2026-09-01T00:30:00.000Z',
  icResolveStatus: 'resolved', odoKm: 200,
});
assert.equal(corrected?.icName, '手動合成C入口');
assert.deepEqual(corrected?.icNameEstimate, estimate, 'manual correction retains estimate provenance');
assert.equal(isEstimatedIcName(corrected), false);
assert.equal(mergeIcMetadata(corrected, { icName: '古い自動名', icResolveStatus: 'resolved', odoKm: 210 })?.icName,
  '手動合成C入口');
assert.equal(mergeIcMetadata(corrected, { icName: '古い自動名', icResolveStatus: 'resolved', odoKm: 210 })?.odoKm,
  210, 'IC preservation does not undo unrelated incoming event edits');
assert.equal(mergeIcMetadata(corrected, { icName: '明示再取得名', icResolveStatus: 'resolved',
  icResolveManualClearedAt: '2026-09-01T00:31:00.000Z' })?.icName, '明示再取得名');
assert.equal(mergeIcMetadata({ icName: '明示再取得名', icResolveStatus: 'resolved',
  icResolveManualClearedAt: '2026-09-01T00:30:00.000Z' }, corrected)?.icName, '明示再取得名',
  'a clearing marker also rejects a superseded manual value with the same timestamp');
const newerEstimate = { ...estimate, displayName: '合成C入口（推定）', candidateNames: ['合成C入口'],
  estimatedAt: '2026-09-01T00:40:00.000Z' };
const newerEstimatedExtras = mergeIcMetadata(estimatedEvent.extras, {
  icName: newerEstimate.displayName, icNameEstimate: newerEstimate, icResolveStatus: 'resolved',
});
assert.deepEqual(newerEstimatedExtras?.icNameEstimateHistory, [estimate], 'changed estimates retain their previous source');
assert.equal(mergeIcMetadata(newerEstimatedExtras, estimatedEvent.extras)?.icName, newerEstimate.displayName,
  'a stale estimate cannot replace a newer one');
assert.equal(isEstimatedIcName({ icName: '旧端末候補（推定）', icResolveStatus: 'resolved' }), true);
assert.equal(mergeIcMetadata({ icName: '旧端末候補（推定）', icResolveStatus: 'resolved' }, {
  icName: '更新候補（推定候補）', icResolveStatus: 'resolved',
})?.icName, '更新候補（推定候補）', 'legacy labels without estimate objects stay estimates and do not throw');
console.log('reportResolvedIc: read projection assertions passed');
