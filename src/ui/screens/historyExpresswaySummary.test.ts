import assert from 'node:assert/strict';
import type { AppEvent } from '../../domain/types';
import {
  buildTripExpresswayHistorySummaries,
  formatTripExpresswayHistorySummary,
} from './historyExpresswaySummary';

function event(params: {
  id: string;
  tripId?: string;
  type: 'expressway' | 'expressway_start' | 'expressway_end';
  ts: string;
  sessionId?: string;
  icName?: string;
  status?: string;
  nextRetryAt?: string;
}): AppEvent {
  return {
    id: params.id,
    tripId: params.tripId ?? 'trip-a',
    type: params.type,
    ts: params.ts,
    syncStatus: 'synced',
    extras: {
      ...(params.sessionId ? { expresswaySessionId: params.sessionId } : {}),
      ...(params.icName ? { icName: params.icName } : {}),
      ...(params.status ? { icResolveStatus: params.status } : {}),
      ...(params.nextRetryAt ? { icResolveNextRetryAt: params.nextRetryAt } : {}),
    },
  };
}

const summaries = buildTripExpresswayHistorySummaries([
  event({
    id: 'start-a',
    type: 'expressway_start',
    ts: '2026-08-23T00:00:00.000Z',
    sessionId: 'A',
    icName: '札幌南IC',
    status: 'resolved',
  }),
  event({
    id: 'start-b',
    type: 'expressway_start',
    ts: '2026-08-23T00:10:00.000Z',
    sessionId: 'B',
    icName: '北広島IC',
    status: 'resolved',
  }),
  event({
    id: 'end-b',
    type: 'expressway_end',
    ts: '2026-08-23T00:20:00.000Z',
    sessionId: 'B',
    icName: '恵庭IC',
    status: 'resolved',
  }),
  event({
    id: 'end-a',
    type: 'expressway_end',
    ts: '2026-08-23T00:30:00.000Z',
    sessionId: 'A',
    icName: '千歳IC',
    status: 'resolved',
  }),
]);

const exactSummary = summaries.get('trip-a');
assert.ok(exactSummary);
assert.equal(exactSummary.segmentCount, 2);
assert.equal(exactSummary.latest.pairing, 'exact');
assert.equal(
  formatTripExpresswayHistorySummary(exactSummary, { tripActive: false }).routeLabel,
  '札幌南IC → 千歳IC',
  'matching session IDs win even when another start is older in the open queue',
);
assert.equal(
  formatTripExpresswayHistorySummary(exactSummary, { tripActive: false }).countLabel,
  'ほか1区間',
);

const legacyPair = buildTripExpresswayHistorySummaries([
  event({
    id: 'legacy-start',
    type: 'expressway_start',
    ts: '2026-08-23T01:00:00.000Z',
    icName: '小樽IC',
  }),
  event({
    id: 'legacy-end',
    type: 'expressway_end',
    ts: '2026-08-23T01:30:00.000Z',
    icName: '札幌西IC',
  }),
]).get('trip-a');
assert.ok(legacyPair);
assert.equal(legacyPair.latest.pairing, 'fallback');
assert.equal(
  formatTripExpresswayHistorySummary(legacyPair, { tripActive: false }).routeLabel,
  '小樽IC → 札幌西IC',
);

const explicitMismatch = buildTripExpresswayHistorySummaries([
  event({
    id: 'mismatch-start',
    type: 'expressway_start',
    ts: '2026-08-23T01:40:00.000Z',
    sessionId: 'explicit-A',
    icName: '開始A',
    status: 'resolved',
  }),
  event({
    id: 'mismatch-end',
    type: 'expressway_end',
    ts: '2026-08-23T01:50:00.000Z',
    sessionId: 'explicit-B',
    icName: '終了B',
    status: 'resolved',
  }),
]).get('trip-a');
assert.ok(explicitMismatch);
assert.equal(explicitMismatch.segmentCount, 2, 'contradictory explicit sessions remain separate');
assert.equal(explicitMismatch.latest.pairing, 'orphan');
assert.equal(
  formatTripExpresswayHistorySummary(explicitMismatch, { tripActive: false }).routeLabel,
  '開始記録なし → 終了B',
  'history never displays a false IC pair for mismatched explicit sessions',
);

const oneSidedLegacyPair = buildTripExpresswayHistorySummaries([
  event({
    id: 'missing-id-start',
    type: 'expressway_start',
    ts: '2026-08-23T01:55:00.000Z',
    icName: '旧開始',
    status: 'resolved',
  }),
  event({
    id: 'explicit-id-end',
    type: 'expressway_end',
    ts: '2026-08-23T02:00:00.000Z',
    sessionId: 'explicit-end',
    icName: '明示終了',
    status: 'resolved',
  }),
]).get('trip-a');
assert.ok(oneSidedLegacyPair);
assert.equal(oneSidedLegacyPair.latest.pairing, 'fallback');
assert.equal(
  formatTripExpresswayHistorySummary(oneSidedLegacyPair, { tripActive: false }).routeLabel,
  '旧開始 → 明示終了',
  'one missing legacy session ID still permits causal fallback',
);

const pendingOpen = buildTripExpresswayHistorySummaries([
  event({
    id: 'pending-start',
    type: 'expressway_start',
    ts: '2026-08-23T02:00:00.000Z',
    status: 'pending',
  }),
]).get('trip-a');
assert.ok(pendingOpen);
assert.deepEqual(
  formatTripExpresswayHistorySummary(pendingOpen, { tripActive: true }),
  { routeLabel: '確認中 → 走行中', countLabel: undefined, state: 'pending' },
);
assert.deepEqual(
  formatTripExpresswayHistorySummary(pendingOpen, { tripActive: false }),
  { routeLabel: '確認中 → 終了記録なし', countLabel: undefined, state: 'unresolved' },
);

const retryingEnd = buildTripExpresswayHistorySummaries([
  event({
    id: 'retry-start',
    type: 'expressway_start',
    ts: '2026-08-23T03:00:00.000Z',
    status: 'failed',
  }),
  event({
    id: 'retry-end',
    type: 'expressway_end',
    ts: '2026-08-23T03:30:00.000Z',
    status: 'failed',
    nextRetryAt: '2026-08-23T04:00:00.000Z',
  }),
]).get('trip-a');
assert.ok(retryingEnd);
assert.deepEqual(
  formatTripExpresswayHistorySummary(retryingEnd, { tripActive: false }),
  { routeLabel: '未特定 → 再確認待ち', countLabel: undefined, state: 'unresolved' },
);

const orphan = buildTripExpresswayHistorySummaries([
  event({
    id: 'orphan-end',
    type: 'expressway_end',
    ts: '2026-08-23T05:00:00.000Z',
    icName: '苫小牧東IC',
    status: 'resolved',
  }),
]).get('trip-a');
assert.ok(orphan);
assert.equal(
  formatTripExpresswayHistorySummary(orphan, { tripActive: false }).routeLabel,
  '開始記録なし → 苫小牧東IC',
);

const oldFormat = buildTripExpresswayHistorySummaries([
  event({
    id: 'old-format',
    type: 'expressway',
    ts: '2026-08-23T06:00:00.000Z',
    icName: '旭川鷹栖IC',
  }),
]).get('trip-a');
assert.ok(oldFormat);
assert.equal(
  formatTripExpresswayHistorySummary(oldFormat, { tripActive: false }).routeLabel,
  '旭川鷹栖IC（旧形式）',
);

console.log('historyExpresswaySummary: session-first, legacy, and factual status assertions passed');
