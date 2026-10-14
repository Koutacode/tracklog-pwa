import assert from 'node:assert/strict';
import type { ProjectedReportTimelineEvent } from '../../domain/reportLogic';
import { buildTripDetailLocationInfo } from './tripDetailLocationInfo';

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected=${String(expected)} actual=${String(actual)}`);
}

const timeline: ProjectedReportTimelineEvent[] = [
  {
    event: {
      type: 'expressway_start',
      ts: '2026-08-30T01:00:00.000Z',
      address: '高速入口付近',
      extras: { icName: '札幌南IC' },
    },
    effectiveMinute: 600,
    effectiveTs: '2026-08-30T01:00:00.000Z',
  },
  {
    event: {
      type: 'expressway_end',
      ts: '2026-08-30T03:00:00.000Z',
      address: '高速出口付近',
      extras: { icName: '千歳IC' },
    },
    effectiveMinute: 720,
    effectiveTs: '2026-08-30T03:00:00.000Z',
  },
  {
    event: { type: 'load_start', ts: '2026-08-30T04:00:00.000Z', address: '荷主倉庫' },
    effectiveMinute: 780,
    effectiveTs: '2026-08-30T04:00:00.000Z',
  },
  {
    event: { type: 'drive_start', ts: '2026-08-30T05:00:00.000Z' },
    effectiveMinute: 840,
    effectiveTs: '2026-08-30T05:00:00.000Z',
  },
];

const info = buildTripDetailLocationInfo(timeline);
assertEqual(info.length, 3, 'expressway and addressed events remain visible');
assertEqual(info[0]?.label, '高速開始', 'expressway start is explicit');
assertEqual(info[0]?.time, '10:00', 'expressway start time');
assertEqual(info[0]?.icName, '札幌南IC', 'start IC remains visible');
assertEqual(info[1]?.label, '高速終了', 'expressway end is explicit');
assertEqual(info[1]?.icName, '千歳IC', 'end IC remains visible');
assertEqual(info[2]?.label, '積込開始地点', 'event address label');
assertEqual(info[2]?.address, '荷主倉庫', 'event address remains visible');

function projected(
  type: ProjectedReportTimelineEvent['event']['type'], ts: string, effectiveMinute: number, address?: string,
): ProjectedReportTimelineEvent {
  return { event: { type, ts, address }, effectiveMinute, effectiveTs: ts };
}

const boundaries = [
  projected('trip_start', '2026-09-30T14:02:19.123Z', 1380),
  projected('trip_end', '2026-09-30T15:37:42.456Z', 45),
];
const original = structuredClone(boundaries);
const locations = buildTripDetailLocationInfo(boundaries);
assert.deepEqual(locations.map(row => row.label), ['運行開始地点', '運行終了地点'],
  'recorded start and end stay visible and ordered without addresses');
assert.deepEqual(locations.map(row => row.time), ['23:02', '00:37'],
  'boundary times use exact saved JST minutes across midnight, not rounded report minutes');
assert.deepEqual(locations.map(row => row.recordedTs), boundaries.map(row => row.event.ts),
  'the full original timestamps remain available to the rendered time elements');
assert.ok(locations.every(row => row.address === undefined));
assert.deepEqual(boundaries, original, 'location presentation never changes recorded data');

const corrected = projected('trip_end', '2026-10-01T01:07:59.000Z', 675, '合成終了地点');
const correctedRow = buildTripDetailLocationInfo([corrected])[0]!;
assert.equal(correctedRow.time, '10:07', 'a saved manual correction wins over projected time');
assert.equal(correctedRow.address, '合成終了地点', 'a recorded address remains visible');
assert.equal(corrected.event.ts, '2026-10-01T01:07:59.000Z');
assert.equal(buildTripDetailLocationInfo([
  projected('trip_end', '2026-09-30T15:00:00.000Z', 1440, '   '),
])[0]?.time, '00:00', 'JST midnight is 00:00, not a projected 24:00');
assert.equal(buildTripDetailLocationInfo([
  projected('trip_end', '2026-09-30T15:00:00.000Z', 0, '   '),
])[0]?.address, undefined, 'blank boundary addresses are treated as unavailable');

assert.deepEqual(buildTripDetailLocationInfo([]), [], 'an empty trip creates no boundary');
assert.deepEqual(buildTripDetailLocationInfo(boundaries.slice(0, 1)).map(row => row.label), ['運行開始地点'],
  'an unfinished trip or a removed end cannot acquire an invented end');
assert.deepEqual(buildTripDetailLocationInfo([
  projected('trip_end', 'invalid', 600, '合成住所'),
  projected('trip_start', '', 600),
]), [], 'invalid recorded timestamps are never replaced with projected times');

assert.equal(buildTripDetailLocationInfo([
  projected('load_start', '2026-10-01T01:07:00.000Z', 600, '合成倉庫'),
])[0]?.time, '10:00', 'ordinary addressed events retain report rounding');
assert.deepEqual(buildTripDetailLocationInfo([
  projected('load_start', '2026-10-01T01:07:00.000Z', 600),
]), [], 'ordinary addressless events remain excluded');
const ic = buildTripDetailLocationInfo([{
  ...projected('expressway_end', '2026-10-01T01:07:00.000Z', 600),
  event: { type: 'expressway_end', ts: '2026-10-01T01:07:00.000Z', extras: { icName: '合成IC' } },
}])[0]!;
assert.equal(ic.time, '10:00', 'IC times retain report rounding');
assert.equal(ic.icDisplay?.label, '合成IC', 'an IC remains visible without an address');
assert.equal(ic.recordedTs, undefined, 'ordinary IC rows do not acquire a trip-boundary timestamp');

console.log('tripDetailLocationInfo: boundaries, exact JST, missing addresses and existing location regressions passed');
