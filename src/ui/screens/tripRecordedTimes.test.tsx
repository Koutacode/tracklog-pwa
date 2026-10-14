import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppEvent } from '../../domain/types';
import { buildReportTripFromAppEvents, computeTripDayMetrics, projectTripReportTimelines } from '../../domain/reportLogic';
import { TripRecordedTimes } from './TripRecordedTimes';
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
const { DayReportSummary } = await import('./TripDetail');
function renderLocations(source: AppEvent[]) {
  const report = buildReportTripFromAppEvents({ tripId: source[0]?.tripId ?? tripId, events: source, dayRuns: [], currentTs: endTs });
  const reportMetrics = computeTripDayMetrics(report);
  const projections = projectTripReportTimelines(report.days);
  const dayTimelines = report.days.map(day => ({ dayIndex: day.dayIndex, timeline: projections.get(day.dayIndex)?.events ?? [] }));
  return report.days.map((day, index) => {
    const markup = renderToStaticMarkup(<DayReportSummary day={day} metrics={reportMetrics[index]!}
      timeline={projections.get(day.dayIndex)?.events ?? []} dayTimelines={dayTimelines} />);
    return markup.match(/<section class="trip-day-locations"[\s\S]*?<\/section>/)?.[0] ?? '';
  }).join('\n');
}

const locationHtml = renderLocations([...events].reverse());
assert.ok(locationHtml.includes(`<strong>運行終了地点</strong><time dateTime="${endTs}">00:37</time>`),
  'the location section itself shows the saved addressless end, not just the separate recorded-times summary');
assert.ok(locationHtml.includes(`<strong>運行開始地点</strong><time dateTime="${startTs}">23:02</time>`));
assert.equal((locationHtml.match(/住所未取得/g) ?? []).length, 2);
assert.ok(locationHtml.indexOf('運行開始地点') < locationHtml.indexOf('運行終了地点'),
  'report projection orders start before end even if loaded events arrive in reverse order');
assert.ok(!renderLocations([events[0]!]).includes('運行終了地点'), 'unfinished trips have no end row');
const addressed = renderLocations(events.map(event => ({ ...event, address: '合成住所' })));
assert.equal((addressed.match(/住所: 合成住所/g) ?? []).length, 2);
assert.ok(!addressed.includes('住所未取得'));
const withIc = renderLocations([...events, {
  id: 'ic', tripId, type: 'expressway_start', ts: '2026-09-30T14:17:00.000Z', syncStatus: 'synced',
  extras: { icName: '合成IC', icResolveStatus: 'resolved' },
}]);
assert.ok(withIc.includes('IC: 合成IC'), 'existing IC presentation remains intact');
assert.equal((withIc.match(/住所未取得/g) ?? []).length, 2, 'the boundary fallback does not change IC address presentation');

const trip = buildReportTripFromAppEvents({ tripId, events, dayRuns: [] });
const metrics = computeTripDayMetrics(trip);
const timelines = projectTripReportTimelines(trip.days);
const lastDay = trip.days[trip.days.length - 1]!;
const html = renderToStaticMarkup(<DayReportSummary
  day={lastDay}
  metrics={metrics[metrics.length - 1]!}
  timeline={timelines.get(lastDay.dayIndex)?.events ?? []}
  dayTimelines={trip.days.map(day => ({ dayIndex: day.dayIndex, timeline: timelines.get(day.dayIndex)?.events ?? [] }))}
/>);

assert.ok(html.includes('運行終了'), 'a recorded trip end is visible in the standard detail summary without an address');
assert.ok(html.includes(`dateTime="${endTs}"`), 'the displayed trip end uses the stored timestamp');
assert.ok(html.includes('2026/10/01 00:37'), 'the trip end shows the exact recorded minute in Japan time across midnight');

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
  const reloadedHtml = renderLocations(reloaded);
  assert.ok(reloadedHtml.includes(`<time dateTime="${correctedTs}">00:43</time>`),
    'a saved manual correction is displayed exactly after reopening');
  assert.deepEqual(await db.events.where('tripId').equals(started.tripId).toArray(), saved,
    'rendering cannot write rounded times back to saved events');
  await deleteEvent(ended.event.id);
  assert.ok(!renderLocations(await db.events.where('tripId').equals(started.tripId).toArray()).includes('運行終了地点'),
    'cancelling a saved end removes its location row');

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
  assert.ok(renderLocations(synced).includes(`<time dateTime="${endTs}">00:37</time>`),
    'the actual sync apply path retains and displays an addressless recorded end');
  assert.deepEqual(await db.events.where('tripId').equals(tripId).toArray(), synced);
});
db.close();
console.log('tripRecordedTimes: location rendering, persistence, correction, cancellation and synthetic sync passed');
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
