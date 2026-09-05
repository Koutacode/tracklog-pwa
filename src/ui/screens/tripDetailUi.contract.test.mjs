import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [tripDetail, home, history, styles] = await Promise.all([
  readFile(new URL('./TripDetail.tsx', import.meta.url), 'utf8'),
  readFile(new URL('./HomeScreen.tsx', import.meta.url), 'utf8'),
  readFile(new URL('./HistoryScreen.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../styles/global.css', import.meta.url), 'utf8'),
]);

assert.doesNotMatch(tripDetail, /日報を作成\/更新/, 'trip detail must not show a report creation button');
assert.match(
  tripDetail,
  /createTripDetailReportSnapshotPersistence\(\{[\s\S]*?getReportTrip\(id\)[\s\S]*?saveSnapshot:\s*saveReportTripSnapshot\s*,[\s\S]*?\.enqueue\(\{/,
  'trip detail automatically refreshes the snapshot with the deletion-aware writer',
);
assert.match(
  tripDetail,
  /\.enqueue\(\{[\s\S]*?tripId,[\s\S]*?events,[\s\S]*?dayRuns:\s*vm\.dayRuns[\s\S]*?\}\);[\s\S]*?\}, \[events, tripId, vm\]\);/,
  'snapshot writes are keyed to material trip data rather than minute refresh state',
);
assert.doesNotMatch(home, /<Link to="\/report">運行日報<\/Link>/, 'home must not show report navigation');
assert.doesNotMatch(history, /<Link to="\/report"[^>]*>運行日報<\/Link>/, 'history must not show report navigation');
assert.doesNotMatch(tripDetail, />\s*TL\s*</, 'trip detail must not show the redundant TL tab');
assert.match(
  tripDetail,
  /項目別時間[\s\S]*?className="trip-day-timeline"[\s\S]*?>時間軸</,
  'time allocation and timeline must be visible together',
);
assert.match(
  tripDetail,
  /row\.kind === 'interval' && <time>\{formatted\.endLabel\}<\/time>/,
  'instant timeline events must not display an artificial end time',
);
assert.match(
  tripDetail,
  /row\.kind === 'interval' && \([\s\S]*?trip-day-timeline__duration/,
  'instant timeline events must not display an artificial duration',
);
assert.match(styles, /\.trip-section\s*\{[^}]*color:\s*#f8fafc;/, 'dark correction cards must set a readable light text color');
assert.match(styles, /\.trip-item\s*\{[^}]*color:\s*#f8fafc;/, 'dark correction rows must set a readable light text color');
assert.match(styles, /\.trip-section__note\s*\{[^}]*color:\s*#cbd5e1;/, 'dark card notes must use high-contrast small text');
assert.match(styles, /\.trip-edit__id\s*\{[^}]*color:\s*#cbd5e1;/, 'dark card identifiers must use high-contrast small text');
assert.match(styles, /\.trip-detail__button:focus-visible[\s\S]*?outline:/, 'trip detail controls must retain a visible focus state');
assert.match(styles, /\.trip-detail__button:disabled[\s\S]*?cursor:\s*not-allowed;/, 'disabled buttons must remain visibly distinct');

console.log('Trip detail UI contract: 15 checks passed');
