import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppEvent } from '../../domain/types';
import { buildReportTripFromAppEvents, computeTripDayMetrics, projectTripReportTimelines } from '../../domain/reportLogic';
import { TripRecordedTimes } from './TripRecordedTimes';
import { DailyView } from './ReportDashboard';

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

console.log('tripRecordedTimes: address-free completed trip rendering passed');
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
