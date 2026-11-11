import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { sha256Hex } from '../tracklog-ops-status/auth.ts';
import { buildClosedDayReport, buildClosedTripReport, findSensitive, toJstIso } from '../tracklog-ops-status/derive.ts';
import { handleClosedTrip } from './handler.ts';

const TOKEN = 'tracklog-ops-reader-test-token-0123456789';
const CANARY_PHONE = '090-5555-0199';
const CANARY_EMAIL = 'ops-canary@example.test';
const CANARY_LAT = 12.345678;
const CANARY_LNG = 98.765432;
const DEVICE_ID = 'android:device-secret-0199';
const TRIP_ID = '11111111-1111-4111-8111-111111111111';

function event(id: string, type: string, ts: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type,
    ts,
    address: null,
    ic_name: null,
    session_key: null,
    session_id: null,
    auto_reason: null,
    device_id: DEVICE_ID,
    geo: { lat: CANARY_LAT, lng: CANARY_LNG },
    lat: CANARY_LAT,
    lng: CANARY_LNG,
    ...extra,
  };
}

function assertClean(value: unknown, label: string) {
  const found = findSensitive(value);
  assert.equal(found, null, `${label} leaked at ${found}`);
  const text = JSON.stringify(value);
  for (const canary of [CANARY_PHONE, CANARY_EMAIL, String(CANARY_LAT), String(CANARY_LNG), DEVICE_ID, '丸の内', '1丁目', 'route-point']) {
    assert.equal(text.includes(canary), false, `${label} contains ${canary}`);
  }
  assert.equal(text.includes('device_id'), false, `${label} names a device`);
}

const closedPayload = {
  closed: true,
  trip_id: TRIP_ID,
  device_id: DEVICE_ID,
  trip_started_at: '2026-11-10T15:00:00.000Z',
  trip_ended_at: '2026-11-11T12:00:00.000Z',
  driver_phone: CANARY_PHONE,
  driver_email: CANARY_EMAIL,
  latest_lat: CANARY_LAT,
  latest_lng: CANARY_LNG,
  _reverse_geocode: { lat: CANARY_LAT, lng: CANARY_LNG },
  events: [
    event('start', 'trip_start', '2026-11-10T15:00:00.000Z', {
      address: '東京都千代田区丸の内一丁目9-1',
    }),
    event('rest', 'rest_start', '2026-11-11T03:00:00.000Z', {
      session_key: 'restSessionId',
      session_id: 'rest-1',
      address: '神奈川県横須賀市平成町1丁目',
    }),
    event('rest-end', 'rest_end', '2026-11-11T06:07:00.000Z', {
      session_key: 'restSessionId',
      session_id: 'rest-1',
    }),
    event('ferry', 'boarding', '2026-11-11T03:30:00.000Z', {
      session_key: 'ferrySessionId',
      session_id: 'ferry-1',
      address: '神奈川県横須賀市平成町1丁目',
    }),
    event('ferry-end', 'disembark', '2026-11-11T06:07:00.000Z', {
      session_key: 'ferrySessionId',
      session_id: 'ferry-1',
    }),
    event('exp', 'expressway_start', '2026-11-11T07:00:00.000Z', {
      session_key: 'expresswaySessionId',
      session_id: 'exp-1',
      ic_name: '厚木IC',
      address: '神奈川県厚木市酒井1丁目',
    }),
    event('exp-end', 'expressway_end', '2026-11-11T08:00:00.000Z', {
      session_key: 'expresswaySessionId',
      session_id: 'exp-1',
      ic_name: '横浜町田IC',
    }),
  ],
};

const report = buildClosedTripReport(closedPayload);
assert.equal(report.closed, true);
assert.equal(report.trip_id, TRIP_ID);
assert.equal(report.trip_started_at, '2026-11-11T00:00:00.000+09:00');
assert.equal(report.trip_ended_at, '2026-11-11T21:00:00.000+09:00');
assert.equal(toJstIso('2026-11-11T06:07:00.000Z'), '2026-11-11T15:07:00.000+09:00');
const segments = report.segments as Array<Record<string, unknown>>;
assert.deepEqual(segments.map(item => item.kind), ['rest', 'ferry', 'expressway']);
const rest = segments.find(item => item.kind === 'rest');
const ferry = segments.find(item => item.kind === 'ferry');
const expressway = segments.find(item => item.kind === 'expressway');
assert.equal(rest?.start_at, '2026-11-11T12:00:00.000+09:00');
assert.equal(rest?.end_at, '2026-11-11T15:07:00.000+09:00');
assert.equal(rest?.overlaps, true);
assert.deepEqual(rest?.place, { kind: 'municipality', name: '神奈川県横須賀市' });
assert.equal(ferry?.kind, 'ferry');
assert.equal(ferry?.label, 'フェリー');
assert.equal(ferry?.start_at, '2026-11-11T12:30:00.000+09:00');
assert.equal(ferry?.end_at, '2026-11-11T15:07:00.000+09:00');
assert.equal(ferry?.overlaps, true);
assert.equal(expressway?.end_at, '2026-11-11T17:00:00.000+09:00');
assert.equal(expressway?.overlaps, false);
assert.deepEqual(expressway?.place, { kind: 'ic', name: '厚木IC' });
assert.deepEqual(report.gaps, [
  { start_at: '2026-11-11T00:00:00.000+09:00', end_at: '2026-11-11T12:00:00.000+09:00' },
  { start_at: '2026-11-11T15:07:00.000+09:00', end_at: '2026-11-11T16:00:00.000+09:00' },
  { start_at: '2026-11-11T17:00:00.000+09:00', end_at: '2026-11-11T21:00:00.000+09:00' },
]);
assert.equal(JSON.stringify(report).includes('15:00:00.000+09:00'), false);
assert.equal(JSON.stringify(report).includes('15:15:00.000+09:00'), false);
assert.equal(JSON.stringify(report).includes('minutes'), false);
assert.equal(JSON.stringify(report).includes('平成町'), false);
assert.equal(JSON.stringify(report).includes('酒井'), false);
assertClean(report, 'closed report');

const active = buildClosedTripReport({
  closed: false,
  trip_id: TRIP_ID,
  device_id: DEVICE_ID,
  trip_started_at: '2026-11-10T15:00:00.000Z',
  latest_lat: CANARY_LAT,
  latest_lng: CANARY_LNG,
  events: closedPayload.events,
});
assert.deepEqual(active, { closed: false });
assertClean(active, 'active refused');

const missing = buildClosedTripReport({ closed: false });
assert.deepEqual(missing, { closed: false });

const spanning = {
  closed: true,
  trip_id: TRIP_ID,
  trip_started_at: '2026-11-10T15:00:00.000Z',
  trip_ended_at: '2026-11-11T18:00:00.000Z',
  device_id: DEVICE_ID,
  latest_lat: CANARY_LAT,
  events: [
    event('early', 'load_start', '2026-11-11T00:00:00.000Z', {
      session_key: 'loadSessionId',
      session_id: 'load-1',
      address: '東京都千代田区丸の内一丁目',
    }),
    event('early-end', 'load_end', '2026-11-11T02:00:00.000Z', {
      session_key: 'loadSessionId',
      session_id: 'load-1',
    }),
    event('overnight', 'rest_start', '2026-11-11T14:00:00.000Z', {
      session_key: 'restSessionId',
      session_id: 'rest-span',
      address: '神奈川県横須賀市平成町',
    }),
    event('overnight-end', 'rest_end', '2026-11-11T16:00:00.000Z', {
      session_key: 'restSessionId',
      session_id: 'rest-span',
    }),
    event('next', 'work_start', '2026-11-11T20:00:00.000Z', {
      session_key: 'workSessionId',
      session_id: 'work-1',
    }),
    event('next-end', 'work_end', '2026-11-11T21:00:00.000Z', {
      session_key: 'workSessionId',
      session_id: 'work-1',
    }),
  ],
};
const dayOne = buildClosedDayReport({ date: '2026-11-11', trips: [spanning, { closed: false, trip_id: TRIP_ID, device_id: DEVICE_ID }] });
const dayTwo = buildClosedDayReport({ date: '2026-11-12', trips: [spanning] });
const firstTrips = dayOne.trips as Array<Record<string, unknown>>;
const secondTrips = dayTwo.trips as Array<Record<string, unknown>>;
assert.equal(firstTrips.length, 1);
assert.deepEqual(
  (firstTrips[0].segments as Array<Record<string, unknown>>).map(item => item.kind),
  ['load', 'rest'],
);
assert.equal((firstTrips[0].segments as Array<Record<string, unknown>>)[1].end_at, '2026-11-12T01:00:00.000+09:00');
assert.deepEqual(
  (secondTrips[0].segments as Array<Record<string, unknown>>).map(item => item.kind),
  ['rest', 'work'],
);
assert.equal((secondTrips[0].segments as Array<Record<string, unknown>>)[0].start_at, '2026-11-11T23:00:00.000+09:00');
assertClean(dayOne, 'day one');
assertClean(dayTwo, 'day two');
assert.throws(() => buildClosedDayReport({ date: '2026-02-31', trips: [] }), /invalid_status_payload/);

async function main() {
  const tokenHash = await sha256Hex(TOKEN);
  const calls: string[] = [];
  const response = await handleClosedTrip(
    new Request(`https://example.test/tracklog-ops-closed-trip?trip_id=${TRIP_ID}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
    {
      tokenHash,
      databaseConfigured: true,
      callClosedTrip: async tripId => {
        calls.push(tripId);
        return closedPayload;
      },
      callClosedDay: async () => { throw new Error('day lookup was not requested'); },
    },
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [TRIP_ID]);
  assert.equal(body.trip_started_at, '2026-11-11T00:00:00.000+09:00');
  assertClean(body, 'http closed');

  const refused = await handleClosedTrip(
    new Request(`https://example.test/tracklog-ops-closed-trip?trip_id=${TRIP_ID}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
    {
      tokenHash,
      databaseConfigured: true,
      callClosedTrip: async () => ({
        closed: false,
        trip_id: TRIP_ID,
        device_id: DEVICE_ID,
        latest_lat: CANARY_LAT,
        events: closedPayload.events,
      }),
      callClosedDay: async () => { throw new Error('day lookup was not requested'); },
    },
  );
  assert.equal(refused.status, 200);
  assert.deepEqual(await refused.json(), { closed: false });

  const anonymous = await handleClosedTrip(
    new Request(`https://example.test/tracklog-ops-closed-trip?trip_id=${TRIP_ID}`),
    { tokenHash, databaseConfigured: true, callClosedTrip: async () => closedPayload, callClosedDay: async () => closedPayload },
  );
  assert.equal(anonymous.status, 401);
  const wrongKey = await handleClosedTrip(
    new Request(`https://example.test/tracklog-ops-closed-trip?trip_id=${TRIP_ID}`, {
      headers: { Authorization: 'Bearer anon-key-placeholder-not-real' },
    }),
    { tokenHash, databaseConfigured: true, callClosedTrip: async () => closedPayload, callClosedDay: async () => closedPayload },
  );
  assert.equal(wrongKey.status, 401);

  const dayCalls: string[] = [];
  const byDate = await handleClosedTrip(
    new Request('https://example.test/tracklog-ops-closed-trip?date=2026-11-11', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
    {
      tokenHash,
      databaseConfigured: true,
      callClosedTrip: async () => { throw new Error('trip lookup was not requested'); },
      callClosedDay: async date => {
        dayCalls.push(date);
        return { date, trips: [spanning] };
      },
    },
  );
  assert.equal(byDate.status, 200);
  assert.deepEqual(dayCalls, ['2026-11-11']);
  const dated = await byDate.json();
  assert.equal(dated.date, '2026-11-11');
  assertClean(dated, 'http day');
  const both = await handleClosedTrip(
    new Request(`https://example.test/tracklog-ops-closed-trip?trip_id=${TRIP_ID}&date=2026-11-11`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
    { tokenHash, databaseConfigured: true, callClosedTrip: async () => closedPayload, callClosedDay: async () => ({ date: '2026-11-11', trips: [] }) },
  );
  assert.equal(both.status, 400);
  const badDate = await handleClosedTrip(
    new Request('https://example.test/tracklog-ops-closed-trip?date=2026-02-31', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
    { tokenHash, databaseConfigured: true, callClosedTrip: async () => closedPayload, callClosedDay: async () => ({ date: '2026-02-31', trips: [] }) },
  );
  assert.equal(badDate.status, 400);

  const liveIndex = await readFile(new URL('../tracklog-ops-status/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(liveIndex, /tracklog_ops_closed_trip/);
  const migration = await readFile(new URL('../../migrations/20261111144500_tracklog_ops_closed_trip.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(migration, /\b(?:alter table|add column|create table|insert|update|delete|truncate)\b/i);
  assert.doesNotMatch(migration, /device_id|driver_phone|driver_email|odo_start|trip_route_points|latest_lat/);
  const rollback = await readFile(new URL('../../rollback/20261111144500_tracklog_ops_closed_trip_down.sql', import.meta.url), 'utf8');
  assert.match(rollback, /drop function if exists public\.tracklog_ops_closed_trip\(text\)/);
  assert.match(rollback, /drop function if exists public\.tracklog_ops_closed_day\(text\)/);
  assert.doesNotMatch(rollback, /drop table|trip_headers|trip_events/i);

  console.log('tracklog-ops-closed-trip: closed segments, JST, and leak assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
