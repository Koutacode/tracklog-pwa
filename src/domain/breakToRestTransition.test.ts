import assert from 'node:assert/strict';
import {
  AUTO_REST_REASON_BREAK_THRESHOLD,
  buildBreakToRestTransition,
  computeSegments,
  getOpenBreakToRestThresholdTs,
} from './metrics';
import type { AppEvent, RestStartEvent } from './types';

const tripId = 'trip-break-threshold';
const breakStartTs = '2026-07-17T00:00:00.000Z';
const breakSessionId = 'break-session-1';

function openBreakEvents(): AppEvent[] {
  return [
    {
      id: 'trip-start-1',
      tripId,
      type: 'trip_start',
      ts: '2026-07-16T23:00:00.000Z',
      syncStatus: 'pending',
      extras: { odoKm: 100 },
    },
    {
      id: 'break-start-1',
      tripId,
      type: 'break_start',
      ts: breakStartTs,
      syncStatus: 'pending',
      extras: { breakSessionId },
    },
  ];
}

assert.equal(
  buildBreakToRestTransition(openBreakEvents(), '2026-07-17T02:59:59.000Z'),
  null,
  '179:59 must remain break time',
);
assert.equal(
  getOpenBreakToRestThresholdTs(openBreakEvents()),
  '2026-07-17T03:00:00.000Z',
  'native route pause uses the same exact threshold',
);

const atThreshold = buildBreakToRestTransition(
  openBreakEvents(),
  '2026-07-17T03:00:00.000Z',
);
assert.ok(atThreshold, '180:00 must produce a break-to-rest transition');
assert.equal(atThreshold.thresholdTs, '2026-07-17T03:00:00.000Z');
assert.equal(atThreshold.breakEnd.ts, atThreshold.thresholdTs);
assert.equal(atThreshold.restStart.ts, atThreshold.thresholdTs);
assert.equal(atThreshold.breakEnd.extras?.breakSessionId, breakSessionId);
assert.equal(atThreshold.restStart.extras.odoKm, undefined);
assert.equal(atThreshold.restStart.extras.autoReason, AUTO_REST_REASON_BREAK_THRESHOLD);
assert.equal(atThreshold.restStart.extras.generatedFrom, 'break-start-1');

const sameInputAgain = buildBreakToRestTransition(
  openBreakEvents(),
  '2026-07-17T04:00:00.000Z',
);
assert.ok(sameInputAgain);
assert.equal(sameInputAgain.thresholdTs, atThreshold.thresholdTs);
assert.equal(sameInputAgain.breakEnd.id, atThreshold.breakEnd.id);
assert.equal(sameInputAgain.restStart.id, atThreshold.restStart.id);
assert.equal(
  sameInputAgain.restStart.extras.restSessionId,
  atThreshold.restStart.extras.restSessionId,
);

const reconciledEvents = [
  ...openBreakEvents(),
  atThreshold.breakEnd,
  atThreshold.restStart,
];
assert.equal(
  buildBreakToRestTransition(reconciledEvents, '2026-07-17T04:00:00.000Z'),
  null,
  'reconciliation must be idempotent after the deterministic pair is applied',
);

const endedBreakEvents: AppEvent[] = [
  ...openBreakEvents(),
  {
    id: 'manual-break-end-1',
    tripId,
    type: 'break_end',
    ts: '2026-07-17T02:00:00.000Z',
    syncStatus: 'pending',
    extras: { breakSessionId },
  },
];
assert.equal(
  buildBreakToRestTransition(endedBreakEvents, '2026-07-17T04:00:00.000Z'),
  null,
  'an ended break must not be converted',
);

const manualRestStart: RestStartEvent = {
  id: 'manual-rest-start-1',
  tripId,
  type: 'rest_start',
  ts: '2026-07-17T05:00:00.000Z',
  syncStatus: 'pending',
  extras: { restSessionId: 'manual-rest-1', odoKm: 140 },
};
const segments = computeSegments({
  odoStart: 100,
  tripStartTs: '2026-07-16T23:00:00.000Z',
  restStarts: [atThreshold.restStart, manualRestStart],
  tripEnd: { odoEnd: 160, tripEndTs: '2026-07-17T06:00:00.000Z' },
});
assert.deepEqual(
  segments.map(segment => [segment.fromOdo, segment.toOdo, segment.km]),
  [[100, 140, 40], [140, 160, 20]],
  'automatic rest without an odometer must not create a distance checkpoint',
);

console.log('breakToRestTransition: 17 assertions passed');
