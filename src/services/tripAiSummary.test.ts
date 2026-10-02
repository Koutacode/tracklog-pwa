import assert from 'node:assert/strict';
import {
  computeTripDayMetrics,
  parseJsonToTrip,
  projectTripReportTimelines,
} from '../domain/reportLogic';
import type { AppEvent, EventType } from '../domain/types';
import { buildTripViewModel } from '../state/selectors';
import { buildTripDetailWorkTimelineForDay } from '../ui/screens/tripDetailTimeline';
import { buildAiShareText, splitAiShareText, type AiShareChunk } from './aiShareText';
import { buildTripAiSummaryPayload } from './tripAiSummary';

const TRIP_ID = 'synthetic-ai-summary-trip';
const GENERATED_AT = '2026-10-01T17:00:00.000Z';
const TS = {
  start: '2026-10-01T13:30:00.000Z',
  loadStart: '2026-10-01T13:45:00.000Z',
  loadEnd: '2026-10-01T14:00:00.000Z',
  workStart: '2026-10-01T14:00:00.000Z',
  workEnd: '2026-10-01T14:30:00.000Z',
  restStart: '2026-10-01T14:45:00.000Z',
  restEnd: '2026-10-01T15:15:00.000Z',
  end: '2026-10-01T16:00:00.000Z',
} as const;

function event(
  id: string,
  type: EventType,
  ts: string,
  extras: Record<string, unknown>,
  address?: string,
): AppEvent {
  return { id, tripId: TRIP_ID, type, ts, extras, address, syncStatus: 'synced' };
}

function completedEvents(): AppEvent[] {
  // Intentionally shuffled to cover event order supplied by either screen.
  return [
    event('end', 'trip_end', TS.end, { odoKm: 1180, totalKm: 180, lastLegKm: 60 }, '合成到着営業所'),
    event('work-end', 'work_end', TS.workEnd, { workSessionId: 'synthetic-work' }),
    event('start', 'trip_start', TS.start, { odoKm: 1000 }, '合成出発営業所🚚'),
    event('rest-end', 'rest_end', TS.restEnd, { restSessionId: 'synthetic-rest', dayClose: true }),
    event('load-end', 'load_end', TS.loadEnd, { loadSessionId: 'synthetic-load' }),
    event('work-start', 'work_start', TS.workStart, {
      workSessionId: 'synthetic-work', reportMinDurationMinutes: 15, note: 'タイヤ交換',
    }, '合成整備施設'),
    event('rest-start', 'rest_start', TS.restStart, { restSessionId: 'synthetic-rest', odoKm: 1120 }, '合成休息施設'),
    event('load-start', 'load_start', TS.loadStart, { loadSessionId: 'synthetic-load' }, '合成積込施設'),
  ];
}

function payloadFor(events: AppEvent[], generatedAt = GENERATED_AT) {
  const vm = buildTripViewModel(TRIP_ID, events);
  return buildTripAiSummaryPayload(TRIP_ID, vm, events, generatedAt);
}

function testCompletedPayloadKeepsOdometerDaysAndWorkTimeline(): void {
  const events = completedEvents();
  const before = structuredClone(events);
  const vm = buildTripViewModel(TRIP_ID, events);
  assert.deepEqual(vm.validation, { ok: true, errors: [] });
  const payload = buildTripAiSummaryPayload(TRIP_ID, vm, events, GENERATED_AT);
  assert.equal(payload.recordType, 'operation_log');
  assert.equal(payload.tripId, TRIP_ID);
  assert.equal(payload.generatedAt, GENERATED_AT);
  assert.deepEqual(payload.summary, {
    hasTripEnd: true,
    startTs: TS.start,
    endTs: TS.end,
    startAddress: '合成出発営業所🚚',
    endAddress: '合成到着営業所',
    odoStart: 1000,
    odoEnd: 1180,
    totalKm: 180,
    lastLegKm: 60,
  });
  assert.deepEqual(payload.segments, [
    { index: 1, toTs: TS.restStart, toOdo: 1120, restSessionIdTo: 'synthetic-rest' },
    { index: 2, toTs: TS.end, toOdo: 1180 },
  ]);
  assert.deepEqual(payload.dayRuns.map(day => ({ dateKey: day.dateKey, km: day.km })), [
    { dateKey: '2026-10-01', km: 120 },
    { dateKey: '2026-10-02', km: 60 },
  ], 'Japanese midnight keeps each day and its odometer distance');
  assert.deepEqual(payload.dayRuns.map(day => day.events.map(item => item.type)), [
    ['trip_start', 'load_start', 'load_end', 'work_start', 'work_end', 'rest_start'],
    ['rest_end', 'trip_end'],
  ]);
  const work = payload.dayRuns[0].events.find(item => item.type === 'work_start');
  assert.equal(work?.ts, TS.workStart);
  assert.equal(work?.address, '合成整備施設');
  assert.equal(work?.extras?.note, 'タイヤ交換');
  assert.deepEqual(payload.timeline, vm.timeline);
  const workTimeline = payload.timeline.filter(item => item.title === 'その他');
  assert.equal(workTimeline.length, 1);
  assert.equal(workTimeline[0].ts, TS.workStart);
  assert.match(workTimeline[0].detail ?? '', /30分/);
  assert.match(workTimeline[0].detail ?? '', /合成整備施設/);

  // The copied operation_log must remain importable as the same business time.
  const imported = parseJsonToTrip(JSON.stringify(payload), TRIP_ID);
  assert.deepEqual(imported.days.map(day => day.km), [120, 60]);
  const metrics = computeTripDayMetrics(imported, { currentTs: GENERATED_AT });
  assert.deepEqual(metrics.map(day => ({
    drive: day.driveMinutes, work: day.workMinutes, load: day.loadMinutes,
    rest: day.restMinutes, constraint: day.constraintMinutes,
  })), [
    { drive: 30, work: 30, load: 15, rest: 15, constraint: 75 },
    { drive: 45, work: 0, load: 0, rest: 15, constraint: 45 },
  ]);
  const projections = projectTripReportTimelines(imported.days);
  const businessRows = buildTripDetailWorkTimelineForDay(imported.days.map(day => ({
    dayIndex: day.dayIndex,
    timeline: projections.get(day.dayIndex)?.events ?? [],
  })), 1).filter(row => row.label === '業務');
  assert.equal(businessRows.length, 1);
  assert.equal(businessRows[0].startMinute, 23 * 60);
  assert.equal(businessRows[0].endMinute, 23 * 60 + 30);
  assert.deepEqual(events, before, 'building the shared payload must leave source events untouched');
}

function testActivePayloadHasNullCompletionAndCurrentDay(): void {
  const events = completedEvents().filter(item => !['trip_end', 'work_end', 'rest_start', 'rest_end'].includes(item.type));
  const payload = payloadFor(events, '2026-10-02T00:00:00.000Z');
  assert.deepEqual(payload.summary, {
    hasTripEnd: false,
    startTs: TS.start,
    endTs: null,
    startAddress: '合成出発営業所🚚',
    odoStart: 1000,
    odoEnd: null,
    totalKm: null,
    lastLegKm: null,
  });
  assert.deepEqual(payload.segments, []);
  assert.deepEqual(payload.dayRuns.map(day => day.dateKey), ['2026-10-01', '2026-10-02'],
    'an active trip includes the current Japanese calendar day at generation time');
  assert.deepEqual(payload.dayRuns[1].events, []);
  assert.equal(payload.dayRuns.flatMap(day => day.events).some(item => item.type === 'trip_end'), false);
  const work = payload.timeline.find(item => item.title === 'その他');
  assert.ok(work);
  assert.equal(work.ts, TS.workStart);
  assert.match(work.detail ?? '', /進行中/);
}

function testMissingStartRejectsAndAbsentAddressesStayAbsent(): void {
  const withoutStart = completedEvents().filter(item => item.type !== 'trip_start');
  assert.throws(() => payloadFor(withoutStart), /運行開始イベントが見つからない/);
  const events = completedEvents().map(item => ({ ...item, address: undefined }));
  const payload = payloadFor(events);
  assert.equal(Object.prototype.hasOwnProperty.call(payload.summary, 'startAddress'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload.summary, 'endAddress'), false);
}

function testSharedBuilderRejectsMismatchedVmAndExcludesOtherTrips(): void {
  const events = completedEvents();
  const vm = buildTripViewModel(TRIP_ID, events);
  assert.throws(() => buildTripAiSummaryPayload(TRIP_ID, { ...vm, tripId: 'another-trip' }, events, GENERATED_AT),
    /運行データの対象が一致しません/);
  const foreignStart = {
    ...event('foreign-start', 'trip_start', '2026-09-30T00:00:00.000Z', { odoKm: 9999 }, '別運行の合成出発地'),
    tripId: 'foreign-trip',
  };
  const foreignEnd = {
    ...event('foreign-end', 'trip_end', '2026-10-03T00:00:00.000Z', { odoKm: 10000, totalKm: 1, lastLegKm: 1 }, '別運行の合成到着地'),
    tripId: 'foreign-trip',
  };
  assert.deepEqual(buildTripAiSummaryPayload(TRIP_ID, vm, [foreignStart, ...events, foreignEnd], GENERATED_AT),
    buildTripAiSummaryPayload(TRIP_ID, vm, events, GENERATED_AT),
    'the shared builder keeps summary, days and timeline restricted to the requested trip');
  const missingStart = events.filter(item => item.type !== 'trip_start');
  assert.throws(() => payloadFor([foreignStart, ...missingStart]), /運行開始イベントが見つからない/,
    'a start belonging to another trip does not satisfy the requested trip');
}

function testFullShareTextContainsExactPayloadAndEndMarker(): void {
  const payload = payloadFor(completedEvents());
  const text = buildAiShareText(payload);
  const lines = text.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '運行履歴データ:');
  assert.deepEqual(JSON.parse(lines[1]), JSON.parse(JSON.stringify(payload)));
  assert.equal(lines[1], JSON.stringify(payload));
  assert.equal(lines[2], `TrackLogデータ終端:${TRIP_ID}:${lines[1].length}`);
  assert.equal(text.includes('要約してください'), false, 'share text does not insert a fixed AI instruction');
  assert.deepEqual(splitAiShareText(text, Array.from(text).length), [{ index: 1, total: 1, text }]);
}

function chunkBody(chunk: AiShareChunk): string {
  const prefix = `TrackLog運行履歴データ 分割 ${chunk.index}/${chunk.total}\n全${chunk.total}通です。番号順に同じ会話へ貼り付けてください。\n`;
  const suffix = `\nTrackLog分割終端:${chunk.index}/${chunk.total}`;
  assert.ok(chunk.text.startsWith(prefix));
  assert.ok(chunk.text.endsWith(suffix));
  return chunk.text.slice(prefix.length, -suffix.length);
}

function testLongPayloadChunksReconstructTheEntireOperationLog(): void {
  const payload = payloadFor(completedEvents());
  payload.timeline.push({ ts: TS.workStart, title: 'その他', detail: '合成作業メモ🚚🔧\n'.repeat(1500) });
  const text = buildAiShareText(payload);
  const chunks = splitAiShareText(text);
  assert.ok(chunks.length > 2);
  assert.deepEqual(chunks.map(chunk => chunk.index), Array.from({ length: chunks.length }, (_, index) => index + 1));
  assert.ok(chunks.every(chunk => chunk.total === chunks.length));
  const bodies = chunks.map(chunkBody);
  assert.ok(bodies.every(body => Array.from(body).length <= 5500));
  assert.equal(bodies.join(''), text, 'split copy retains every character and the final marker in order');
  assert.deepEqual(JSON.parse(bodies.join('').split('\n')[1]), JSON.parse(JSON.stringify(payload)));
  assert.ok(bodies[bodies.length - 1].endsWith(`TrackLogデータ終端:${TRIP_ID}:${JSON.stringify(payload).length}`));
}

function testSplitKeepsAstralUnicodeAtCharacterBoundary(): void {
  const text = `${'x'.repeat(499)}🚚${'タイヤ交換🔧\n'.repeat(150)}`;
  const chunks = splitAiShareText(text, 500);
  const bodies = chunks.map(chunkBody);
  assert.equal(bodies[0], `${'x'.repeat(499)}🚚`, 'the 500th Unicode character is kept as one complete emoji');
  assert.equal(bodies[0].length, 501, 'the test crosses a UTF-16 surrogate boundary');
  assert.equal(bodies.join(''), text);
  for (const body of bodies) {
    assert.ok(Array.from(body).length <= 500);
    assert.doesNotMatch(body, /[\uD800-\uDBFF]$/);
    assert.doesNotMatch(body, /^[\uDC00-\uDFFF]/);
  }
  for (const limit of [499, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => splitAiShareText(text, limit), /分割文字数が不正/);
  }
}

const tests: Array<[string, () => void]> = [
  ['completed payload preserves odometer days and business timeline', testCompletedPayloadKeepsOdometerDaysAndWorkTimeline],
  ['active payload has no synthetic completion and uses generation time', testActivePayloadHasNullCompletionAndCurrentDay],
  ['missing start rejects and missing addresses remain omitted', testMissingStartRejectsAndAbsentAddressesStayAbsent],
  ['shared builder restricts events to the requested trip and VM', testSharedBuilderRejectsMismatchedVmAndExcludesOtherTrips],
  ['full share text preserves exact operation_log and final marker', testFullShareTextContainsExactPayloadAndEndMarker],
  ['long share chunks reconstruct the complete payload', testLongPayloadChunksReconstructTheEntireOperationLog],
  ['Unicode chunk boundary keeps complete emoji characters', testSplitKeepsAstralUnicodeAtCharacterBoundary],
];

for (const [name, run] of tests) {
  try {
    run();
  } catch (error) {
    console.error(`tripAiSummary: ${name}`);
    throw error;
  }
}
console.log(`tripAiSummary: ${tests.length} tests passed`);
