import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppEvent } from '../../domain/types';
import { buildReportTripFromAppEvents, computeTripDayMetrics } from '../../domain/reportLogic';
import { TripRecordedTimes } from './TripRecordedTimes';
import { TripDayReport } from './TripDayReport';
import { buildTripHistoryDays } from './tripHistoryReport';
import { DailyView } from './ReportDashboard';
import { db } from '../../db/db';
import { startTrip, endTrip, deleteEvent, updateEventTimestamp } from '../../db/repositories';
import { withRemoteSyncSignalsSuppressed } from '../../app/remoteSyncSignal';
import { synchronizeRemoteOutbox } from '../../services/remoteSyncV2';
import { SUPABASE_CONFIGURED } from '../../services/supabase';

Object.assign(globalThis, { __APP_VERSION__: '0.0.0-test', __BUILD_DATE__: 'synthetic-test' });

const tripId = 'synthetic-trip-times';
const startTs = '2026-09-30T14:02:00.000Z';
const endTs = '2026-09-30T15:37:00.000Z';
const events: AppEvent[] = [
  { id: 'start', tripId, type: 'trip_start', ts: startTs, syncStatus: 'synced', extras: { odoKm: 100 } },
  { id: 'end', tripId, type: 'trip_end', ts: endTs, syncStatus: 'synced', extras: { odoKm: 130, totalKm: 30, lastLegKm: 30 } },
];
async function main() {
function renderHistory(source: AppEvent[]) {
  return buildTripHistoryDays(source, endTs, source[0]?.tripId ?? tripId)
    .map(day => renderToStaticMarkup(<TripDayReport day={day} />)).join('\n');
}
function historyEvents(source: AppEvent[]) {
  return buildTripHistoryDays(source, endTs, source[0]?.tripId ?? tripId).flatMap(day => day.events);
}

const locationHtml = renderHistory([...events].reverse());
assert.ok(locationHtml.includes(`<time dateTime="${endTs}">00:30</time>`),
  'the addressless history end uses the display projection while retaining its saved timestamp');
assert.ok(locationHtml.includes(`<time dateTime="${startTs}">23:00</time>`));
assert.equal((locationHtml.match(/場所未確認/g) ?? []).length, 2);
assert.deepEqual(historyEvents([...events].reverse()).map(event => event.id), ['start', 'end'],
  'history orders start before end even if loaded events arrive in reverse order');
assert.ok(!historyEvents([events[0]!]).some(event => event.type === 'trip_end'), 'unfinished trips have no end row');
const addressed = renderHistory(events.map(event => ({ ...event, address: '合成住所' })));
assert.equal((addressed.match(/合成住所/g) ?? []).length, 2);
assert.ok(!addressed.includes('場所未確認'));
const withIc = renderHistory([...events, {
  id: 'ic', tripId, type: 'expressway_start', ts: '2026-09-30T14:17:00.000Z', syncStatus: 'synced',
  extras: { icName: '合成IC', icResolveStatus: 'resolved' },
}]);
assert.ok(withIc.includes('合成IC'), 'existing IC presentation remains intact');
assert.ok(withIc.includes('高速入口'), 'IC entry is identified even when its address is unavailable');

const restFerryEvents: AppEvent[] = [
  events[0]!,
  ...(['rest_start', 'boarding', 'rest_end', 'disembark'] as const).map((type, index) => ({
    id: `synthetic-${type}`, tripId, type,
    ts: index < 2 ? '2026-09-30T14:10:00.000Z' : '2026-09-30T14:33:27.001Z',
    syncStatus: 'synced' as const,
    extras: { restSessionId: 'synthetic-rest', ferrySessionId: 'synthetic-ferry' },
  })),
  events[1]!,
];
const restFerrySnapshot = structuredClone(restFerryEvents);
const restFerryHtml = renderHistory(restFerryEvents);
for (const label of ['休息開始', 'フェリー乗船', '休息終了', 'フェリー下船']) {
  assert.ok(restFerryHtml.includes(label), `${label} renders without a location`);
}
assert.equal((restFerryHtml.match(/場所未確認/g) ?? []).length, 6);
assert.deepEqual(restFerryEvents, restFerrySnapshot, 'rendering preserves saved events');

const operationRenderingPairs = [
  ['load_start', 'load_end', '積込開始', '積込終了'],
  ['unload_start', 'unload_end', '荷卸し開始', '荷卸し終了'],
  ['break_start', 'break_end', '休憩開始', '休憩終了'],
  ['wait_start', 'wait_end', '待機開始', '待機終了'],
  ['work_start', 'work_end', 'その他作業開始', 'その他作業終了'],
] as const;
for (const [start, end, startLabel, endLabel] of operationRenderingPairs) {
  for (const address of [undefined, null, '', '   ', '合成住所']) {
    const operationEvents = [start, end].map((type, index) => ({
      id: `operation-${type}`, tripId, type,
      ts: index ? '2026-09-30T14:11:00.000Z' : '2026-09-30T14:10:00.000Z',
      syncStatus: 'synced', address,
    })) as AppEvent[];
    const source = [events[0]!, ...operationEvents, events[1]!];
    const snapshot = structuredClone(source);
    const markup = renderHistory(source);
    for (const label of [startLabel, endLabel]) assert.ok(markup.includes(label), label);
    assert.equal((markup.match(/場所未確認/g) ?? []).length, address === '合成住所' ? 2 : 4);
    assert.ok(!historyEvents([events[0]!, operationEvents[0]!]).some(event => event.type === end),
      'rendering an unfinished operation creates no end row');
    assert.deepEqual(source, snapshot, 'rendering never changes operation events');
  }
}

const unroundedStartTs = '2026-09-30T02:57:00.000Z';
const unroundedStart: AppEvent[] = [{ ...events[0]!, ts: unroundedStartTs, address: '合成開始地点' }];
assert.ok(renderHistory(unroundedStart).includes(
  `<time dateTime="${unroundedStartTs}">12:00</time>`),
  'the app history rounds the reported 11:57 start to 12:00');
assert.ok(renderToStaticMarkup(<TripRecordedTimes events={unroundedStart} />).includes('2026/09/30 11:57'),
  'the separate recorded-times summary still displays the original 11:57');

const minimumEndTs = '2026-09-30T15:02:00.000Z';
const minimumEvents: AppEvent[] = [
  { ...events[0]!, ts: '2026-09-30T14:45:00.000Z' },
  { id: 'load-start', tripId, type: 'load_start', ts: '2026-09-30T14:58:00.000Z', syncStatus: 'synced',
    extras: { reportMinDurationMinutes: 15, loadSessionId: 'midnight-minimum' } },
  { id: 'load-end', tripId, type: 'load_end', ts: '2026-09-30T15:01:00.000Z', syncStatus: 'synced',
    extras: { loadSessionId: 'midnight-minimum' } },
  { ...events[1]!, ts: minimumEndTs },
];
const minimumSnapshot = structuredClone(minimumEvents);
assert.ok(renderHistory(minimumEvents).includes(`<time dateTime="${minimumEndTs}">00:15</time>`),
  'app history follows the shared minimum work duration across midnight');
assert.deepEqual(minimumEvents, minimumSnapshot, 'minimum-duration projection never extends stored timestamps');
assert.ok(renderToStaticMarkup(<TripRecordedTimes events={minimumEvents} />).includes('2026/10/01 00:02'),
  'the exact record keeps the real end even when display work extends to the next quarter hour');

const trip = buildReportTripFromAppEvents({ tripId, events, dayRuns: [] });
const metrics = computeTripDayMetrics(trip);
const lastDay = trip.days[trip.days.length - 1]!;
const html = renderHistory(events);
assert.ok(html.includes('運行終了'), 'a recorded trip end is visible in the app history without an address');
assert.ok(html.includes(`dateTime="${endTs}">00:30</time>`), 'app history displays the quarter-hour end');
assert.ok(!html.includes('2026/10/01 00:37'), 'app history does not substitute exact-minute labels for display times');
const recordedHtml = renderToStaticMarkup(<TripRecordedTimes events={events} />);
assert.ok(recordedHtml.includes(`dateTime="${endTs}"`));
assert.ok(recordedHtml.includes('2026/10/01 00:37'),
  'the separate recorded-times summary retains the exact Japan-time minute across midnight');

const reportHtml = renderToStaticMarkup(<DailyView day={lastDay} metrics={metrics[metrics.length - 1]!} expresswaySessions={[]} />);
assert.ok(reportHtml.includes(`dateTime="${endTs}"`), 'daily report displays the same recorded end without relying on its timeline tab');
assert.ok(reportHtml.includes('2026/10/01 00:37'));

const openHtml = renderToStaticMarkup(<TripRecordedTimes events={[events[0]!]} />);
assert.ok(openHtml.includes('運行開始'));
assert.ok(!openHtml.includes('<dt>運行終了</dt>'), 'an open trip does not invent a trip end');
assert.ok(!renderToStaticMarkup(<TripRecordedTimes events={[{ type: 'trip_end', ts: 'invalid' }]} />), 'invalid end timestamps are not shown as real times');
assert.ok(!renderToStaticMarkup(<TripRecordedTimes events={[]} />), 'an empty record cannot create timestamps');

assert.equal(SUPABASE_CONFIGURED, false, 'these tests must never connect to production');
await withRemoteSyncSignalsSuppressed(async () => {
  for (const table of db.tables) await table.clear();
  const started = await startTrip({ odoKm: 100, occurredAt: startTs });
  const ended = await endTrip({ tripId: started.tripId, odoEndKm: 130, occurredAt: endTs });
  assert.equal(ended.event.address, undefined);
  const correctedTs = '2026-09-30T15:43:27.000Z';
  await updateEventTimestamp(ended.event.id, correctedTs);
  const saved = await db.events.where('tripId').equals(started.tripId).toArray();
  db.close();
  await db.open();
  const reloaded = await db.events.where('tripId').equals(started.tripId).toArray();
  assert.deepEqual(reloaded, saved, 'saved synthetic data survives database reopen unchanged');
  const reloadedHtml = renderHistory(reloaded);
  assert.ok(reloadedHtml.includes(`<time dateTime="${correctedTs}">00:45</time>`),
    'a saved manual correction uses report rounding after reopening');
  assert.deepEqual(await db.events.where('tripId').equals(started.tripId).toArray(), saved,
    'rendering cannot write rounded times back to saved events');
  await deleteEvent(ended.event.id);
  assert.ok(!historyEvents(await db.events.where('tripId').equals(started.tripId).toArray()).some(event => event.type === 'trip_end'),
    'cancelling a saved end removes its history row');

  for (const table of db.tables) await table.clear();
  const owner = '11111111-1111-4111-8111-111111111111';
  let calls = 0;
  await synchronizeRemoteOutbox(owner, async request => {
    calls += 1;
    assert.equal(request.mutations.length, 0, 'the synthetic download sends no local data');
    return {
      protocolVersion: 2, cursor: 2, hasMore: false, acks: [],
      changes: { events: events.map((event, index) => ({
        id: event.id, trip_id: tripId, type: event.type, ts: event.ts, extras: event.extras,
        address: null, geo: null, owner_user_id: owner, device_id: 'synthetic-device',
        updated_at: endTs, revision: 1, change_seq: index + 1,
      })) },
    };
  });
  assert.equal(calls, 1, 'sync uses only the supplied in-memory transport');
  const synced = await db.events.where('tripId').equals(tripId).toArray();
  assert.ok(renderHistory(synced).includes(`<time dateTime="${endTs}">00:30</time>`),
    'the actual sync apply path retains an addressless end and displays its report projection');
  assert.deepEqual(await db.events.where('tripId').equals(tripId).toArray(), synced);
});
db.close();
console.log('tripRecordedTimes: projected history, exact daily report, persistence, correction, cancellation and synthetic sync passed');
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
