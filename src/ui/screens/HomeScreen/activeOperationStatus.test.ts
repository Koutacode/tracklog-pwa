import assert from 'node:assert/strict';
import type { AppEvent } from '../../../domain/types';
import { computeLiveDriveStatus } from '../../../domain/liveDriveStatus';
import {
  buildActiveOperationStatuses,
  buildRestMilestones,
  formatElapsedHoursMinutes,
} from './activeOperationStatus';

const event = (id: string, type: AppEvent['type'], ts: string, extras: Record<string, unknown> = {}): AppEvent => ({
  id,
  tripId: 'trip-1',
  type,
  ts,
  syncStatus: 'synced',
  extras,
} as AppEvent);

const restBeforeFerry = [
  event('trip', 'trip_start', '2026-08-29T04:00:00.000Z', { odoKm: 1 }),
  event('rest', 'rest_start', '2026-08-29T05:05:00.000Z', { restSessionId: 'rest-1' }),
  event('ferry', 'boarding', '2026-08-29T06:21:00.000Z', { ferrySessionId: 'ferry-1' }),
  event('exp', 'expressway_start', '2026-08-29T06:30:00.000Z', { expresswaySessionId: 'exp-1' }),
];
const statuses = buildActiveOperationStatuses(
  restBeforeFerry,
  computeLiveDriveStatus(restBeforeFerry, '2026-08-29T07:23:00.000Z'),
);
assert.deepEqual(statuses.map(item => item.channel), ['base', 'ferry', 'expressway']);
assert.equal(statuses[0]?.annotation, '乗船前から継続');
assert.equal(formatElapsedHoursMinutes(statuses[0]!.startedAt, Date.parse('2026-08-29T07:23:00.000Z')), '2時間18分');
assert.equal(formatElapsedHoursMinutes(statuses[1]!.startedAt, Date.parse('2026-08-29T07:23:00.000Z')), '1時間02分');
assert.equal(statuses[1]?.startedLabel, '乗船', 'ferry time uses the boarding label');

const autoRest = [
  event('trip', 'trip_start', '2026-08-29T04:00:00.000Z', { odoKm: 1 }),
  event('rest', 'rest_start', '2026-08-29T06:21:00.000Z', {
    restSessionId: 'rest-auto',
    autoReason: 'ferry_boarding',
  }),
  event('ferry', 'boarding', '2026-08-29T06:21:00.000Z', {
    ferrySessionId: 'ferry-1',
    autoRestSessionId: 'rest-auto',
  }),
];
const autoStatuses = buildActiveOperationStatuses(
  autoRest,
  computeLiveDriveStatus(autoRest, '2026-08-29T07:23:00.000Z'),
);
assert.equal(autoStatuses[0]?.annotation, 'フェリー乗船と同時に開始');
assert.equal(autoStatuses[0]?.origin, 'automatic');

const autoExpressway = [
  event('trip', 'trip_start', '2026-08-29T04:00:00.000Z', { odoKm: 1 }),
  event('auto-exp', 'expressway_start', '2026-08-29T04:30:00.000Z', {
    expresswaySessionId: 'exp-auto',
    autoDecision: { nativeDetectionId: 'native-1', nativeGeneration: 1 },
  }),
];
const autoExpresswayStatus = buildActiveOperationStatuses(
  autoExpressway,
  computeLiveDriveStatus(autoExpressway, '2026-08-29T05:00:00.000Z'),
).find(item => item.channel === 'expressway');
assert.equal(autoExpresswayStatus?.origin, 'automatic', 'native auto-decision metadata marks automatic origin');
assert.equal(autoExpresswayStatus?.startedLabel, '開始');

const afterDisembark = [
  ...restBeforeFerry,
  event('ferry-end', 'disembark', '2026-08-29T08:00:00.000Z', { ferrySessionId: 'ferry-1' }),
  event('exp-end', 'expressway_end', '2026-08-29T08:05:00.000Z', { expresswaySessionId: 'exp-1' }),
];
const afterDisembarkStatuses = buildActiveOperationStatuses(
  afterDisembark,
  computeLiveDriveStatus(afterDisembark, '2026-08-29T08:23:00.000Z'),
);
assert.deepEqual(afterDisembarkStatuses.map(item => item.channel), ['base']);
assert.equal(afterDisembarkStatuses[0]?.kind, 'rest', 'pre-boarding rest continues after disembark');
assert.equal(afterDisembarkStatuses[0]?.annotation, undefined, 'ferry annotation clears after disembark');

const staleRestEnd = [
  event('trip', 'trip_start', '2026-08-29T13:00:00.000Z', { odoKm: 1 }),
  event('stale-end', 'rest_end', '2026-08-29T14:00:00.000Z', { restSessionId: 'rest-old' }),
  event('rest', 'rest_start', '2026-08-29T14:30:00.000Z', { restSessionId: 'rest-current' }),
];
const staleStatuses = buildActiveOperationStatuses(
  staleRestEnd,
  computeLiveDriveStatus(staleRestEnd, '2026-08-30T00:45:00.000Z'),
);
assert.equal(staleStatuses[0]?.kind, 'rest', 'stale session end does not close current rest');
assert.equal(
  formatElapsedHoursMinutes(staleStatuses[0]!.startedAt, Date.parse('2026-08-30T00:45:00.000Z')),
  '10時間15分',
  'rest elapsed remains correct across midnight',
);

assert.deepEqual(buildRestMilestones('2026-08-29T05:07:00.000Z'), [
  { hours: 8, clock: '22:00' },
  { hours: 9, clock: '23:00' },
  { hours: 10, clock: '00:00' },
  { hours: 12, clock: '02:00' },
]);

console.log('activeOperationStatus tests passed');
