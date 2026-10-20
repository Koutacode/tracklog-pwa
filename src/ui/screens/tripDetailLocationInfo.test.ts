import assert from 'node:assert/strict';
import {
  buildReportTripFromAppEvents,
  projectTripReportTimelines,
  type ProjectedReportTimelineEvent,
} from '../../domain/reportLogic';
import type { AppEvent } from '../../domain/types';
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
assert.deepEqual(locations.map(row => row.time), ['23:00', '00:45'],
  'boundary times use the supplied daily report projection across midnight');
assert.deepEqual(locations.map(row => row.recordedTs), boundaries.map(row => row.event.ts),
  'the full original timestamps remain available to the rendered time elements');
assert.ok(locations.every(row => row.address === undefined));
assert.deepEqual(boundaries, original, 'location presentation never changes recorded data');

const corrected = projected('trip_end', '2026-10-01T01:07:59.000Z', 675, '合成終了地点');
const correctedRow = buildTripDetailLocationInfo([corrected])[0]!;
assert.equal(correctedRow.time, '11:15', 'boundary display follows the effective minute, including report adjustments');
assert.equal(correctedRow.address, '合成終了地点', 'a recorded address remains visible');
assert.equal(corrected.event.ts, '2026-10-01T01:07:59.000Z');
assert.equal(buildTripDetailLocationInfo([
  projected('trip_end', '2026-09-30T15:00:00.000Z', 1440, '   '),
])[0]?.time, '24:00', 'the end of a report day retains its projected 24:00 boundary');
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
assert.equal(buildTripDetailLocationInfo([
  projected('load_start', '2026-10-01T01:07:00.000Z', 600),
])[0]?.addressUnavailable, true, 'addressless loading boundaries are explicitly unavailable');
const ic = buildTripDetailLocationInfo([{
  ...projected('expressway_end', '2026-10-01T01:07:00.000Z', 600),
  event: { type: 'expressway_end', ts: '2026-10-01T01:07:00.000Z', extras: { icName: '合成IC' } },
}])[0]!;
assert.equal(ic.time, '10:00', 'IC times retain report rounding');
assert.equal(ic.icDisplay?.label, '合成IC', 'an IC remains visible without an address');
assert.equal(ic.recordedTs, undefined, 'ordinary IC rows do not acquire a trip-boundary timestamp');

function projectLocations(events: AppEvent[]) {
  const trip = buildReportTripFromAppEvents({ tripId: 'rounded-locations', events, dayRuns: [] });
  const projections = projectTripReportTimelines(trip.days);
  return trip.days.flatMap(day => buildTripDetailLocationInfo(projections.get(day.dayIndex)?.events ?? []));
}

function recorded(
  type: AppEvent['type'], ts: string, extras?: AppEvent['extras'],
): AppEvent {
  return { id: `${type}-${ts}`, tripId: 'rounded-locations', type, ts, extras, syncStatus: 'synced' };
}

const reportedStart = [
  recorded('trip_start', '2026-10-16T02:57:00.000Z'),
  recorded('trip_end', '2026-10-16T04:00:00.000Z'),
];
const originalStart = structuredClone(reportedStart);
assert.equal(projectLocations(reportedStart)[0]?.time, '12:00',
  'the reported 11:57 start displays 12:00 using the actual report projection');
assert.deepEqual(reportedStart, originalStart, 'rounding never rewrites the original event timestamps');

const midnightMinimum = [
  recorded('trip_start', '2026-09-30T14:45:00.000Z'),
  recorded('load_start', '2026-09-30T14:58:00.000Z', {
    reportMinDurationMinutes: 15, loadSessionId: 'midnight-minimum',
  }),
  recorded('load_end', '2026-09-30T15:01:00.000Z', { loadSessionId: 'midnight-minimum' }),
  recorded('trip_end', '2026-09-30T15:02:00.000Z'),
];
assert.equal(projectLocations(midnightMinimum).find(row => row.label === '運行終了地点')?.time, '00:15',
  'the minimum load duration carries across midnight into the trip end location');
assert.equal(projectLocations([
  recorded('trip_start', '2026-09-30T13:00:00.000Z'),
  recorded('trip_end', '2026-09-30T14:57:00.000Z'),
]).find(row => row.label === '運行終了地点')?.time, '24:00',
  'a real 23:57 end projects to the report day boundary at 24:00');

console.log('tripDetailLocationInfo: report rounding, midnight minimums, recorded data and existing locations passed');

const operationPairs = [
  ['load_start', 'load_end', '積込開始地点', '積込終了地点'],
  ['unload_start', 'unload_end', '荷卸開始地点', '荷卸終了地点'],
  ['break_start', 'break_end', '休憩開始地点', '休憩終了地点'],
  ['wait_start', 'wait_end', '待機開始地点', '待機終了地点'],
  ['work_start', 'work_end', 'その他開始地点', 'その他終了地点'],
  ['rest_start', 'rest_end', '休息開始地点', '休息終了地点'],
  ['boarding', 'disembark', 'フェリー乗船地点', 'フェリー下船地点'],
] as const;
for (const [start, end, startLabel, endLabel] of operationPairs) {
  for (const address of [undefined, null, '', '  \t ', ' 合成住所 ']) {
    const source = [start, end].map((type, index) => ({
      ...projected(type, `2026-10-19T00:30:0${index}.001Z`, 570),
      event: { type, ts: `2026-10-19T00:30:0${index}.001Z`, address, geo: null,
        extras: { syntheticSessionId: 'same-session' } },
    })) as ProjectedReportTimelineEvent[];
    const snapshot = structuredClone(source);
    const rows = buildTripDetailLocationInfo(source);
    assert.deepEqual(rows.map(row => row.label), [startLabel, endLabel]);
    assert.equal(new Set(rows.map(row => row.key)).size, 2, 'same rounded time never hides the end');
    assert.ok(rows.every(row => row.time === '09:30' && row.recordedTs === undefined));
    assert.ok(rows.every(row => row.addressUnavailable === (address !== ' 合成住所 ')));
    assert.ok(rows.every(row => row.address === (address === ' 合成住所 ' ? '合成住所' : undefined)));
    assert.deepEqual(buildTripDetailLocationInfo(source.slice(0, 1)).map(row => row.label), [startLabel],
      'unfinished work cannot acquire an invented end');
    assert.deepEqual(source, snapshot, 'presentation preserves timestamps, extras and null location data');
  }
}
assert.deepEqual(buildTripDetailLocationInfo([
  projected('drive_start', '2026-10-18T09:03:27.001Z', 1080),
]), [], 'addressless drive_start remains excluded');
assert.equal(buildTripDetailLocationInfo([
  projected('drive_start', '2026-10-18T09:03:27.001Z', 1080, '従来の住所'),
])[0]?.address, '従来の住所', 'addressed drive_start retains existing behavior');
console.log('tripDetailLocationInfo: all 14 operation boundaries, address variants and unfinished work passed');

const simultaneous = operationPairs.flatMap(([start, end]) => [start, end]).map(type =>
  projected(type, '2026-10-19T09:03:27.001Z', 1080));
const simultaneousRows = buildTripDetailLocationInfo(simultaneous);
assert.equal(simultaneousRows.length, 14, 'simultaneous rest/ferry and other boundaries remain present');
assert.equal(new Set(simultaneousRows.map(row => row.key)).size, 14, 'same saved timestamps still have distinct rows');
