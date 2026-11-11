import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { computeLiveDriveStatus } from '../../../src/domain/liveDriveStatus.ts';
import type { AppEvent, EventType } from '../../../src/domain/types.ts';
import { isOpsTokenHash, opsTokenMatches, readBearerToken, sha256Hex } from './auth.ts';
import {
  applyCoarsePlace,
  buildOpsStatus,
  findSensitive,
  getOpsMunicipality,
  isStale,
  STALE_AFTER_MS,
  toJstIso,
} from './derive.ts';
import { coarsePlaceFromHeartRails, reverseGeocodeMunicipality } from './geocode.ts';
import { handleOpsStatus } from './handler.ts';

const TOKEN = 'tracklog-ops-reader-test-token-0123456789';

async function main() {
const TOKEN_HASH = await sha256Hex(TOKEN);
const CANARY_PHONE = '090-5555-0199';
const CANARY_EMAIL = 'ops-canary@example.test';
const CANARY_ODO = 909090;
const CANARY_LAT = 12.345678;
const CANARY_LNG = 98.765432;
const SYNCED = '2026-11-12T01:00:00.000Z';
const SEEN_FRESH = '2026-11-12T00:50:00.000Z';
const TRIP_START = '2026-11-10T15:00:00.000Z';

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
    geo: { lat: CANARY_LAT, lng: CANARY_LNG },
    extras: { odoKm: CANARY_ODO, phone: CANARY_PHONE, email: CANARY_EMAIL },
    lat: CANARY_LAT,
    lng: CANARY_LNG,
    ...extra,
  };
}

function activePayload(events: unknown[], extra: Record<string, unknown> = {}) {
  return {
    trip_active: true,
    trip_id: 'trip-ferry-1',
    device_id: 'device-1',
    trip_started_at: TRIP_START,
    synced_at: SYNCED,
    seen_at: SEEN_FRESH,
    events,
    driver_phone: CANARY_PHONE,
    driver_email: CANARY_EMAIL,
    odo_start: CANARY_ODO,
    odo_end: CANARY_ODO,
    total_km: 120,
    last_leg_km: 40,
    latest_trip_id: 'leftover-trip',
    latest_lat: CANARY_LAT,
    latest_lng: CANARY_LNG,
    _reverse_geocode: { lat: CANARY_LAT, lng: CANARY_LNG },
    ...extra,
  };
}

function assertClean(value: unknown, label: string) {
  const found = findSensitive(value);
  assert.equal(found, null, `${label} leaked at ${found}`);
  const text = JSON.stringify(value);
  for (const canary of [CANARY_PHONE, CANARY_EMAIL, String(CANARY_ODO), String(CANARY_LAT), String(CANARY_LNG), '丸の内', '1丁目', 'route-point']) {
    assert.equal(text.includes(canary), false, `${label} contains ${canary}`);
  }
}

function appEvents(rows: Array<ReturnType<typeof event>>): AppEvent[] {
  return rows.map(row => ({
    id: row.id,
    tripId: 'trip-ferry-1',
    type: row.type as EventType,
    ts: row.ts,
    syncStatus: 'synced',
    extras: row.session_key && row.session_id ? { [String(row.session_key)]: row.session_id } : {},
  }) as AppEvent);
}

const LIVE_STATE: Record<string, string> = {
  drive: '走行',
  break: '休憩',
  rest: '休息',
  load: '積込',
  unload: '荷卸',
  work: 'その他作業',
  idle: '待機',
  wait: '待機',
};

function assertMatchesLiveDrive(rows: Array<ReturnType<typeof event>>, label: string) {
  const built = buildOpsStatus(activePayload(rows));
  const live = computeLiveDriveStatus(appEvents(rows), SYNCED);
  assert.equal(built.body.state, LIVE_STATE[live.currentCategory], label);
  assert.equal(
    built.body.state_started_at,
    live.currentCategoryStartedAt ? toJstIso(live.currentCategoryStartedAt) : null,
    `${label} start`,
  );
  assertClean(built.body, label);
  if (built.body.place) assert.equal(built.geocode, null);
}

for (const [address, expected] of [
  ['北海道札幌市白石区中央1条1丁目', '北海道札幌市白石区'],
  ['千葉県市川市高谷3丁目', '千葉県市川市'],
  ['千葉県市川市市川1丁目', '千葉県市川市'],
  ['千葉県市原市姉崎', '千葉県市原市'],
  ['三重県四日市市日永', '三重県四日市市'],
  ['石川県野々市市三納', '石川県野々市市'],
  ['東京都町田市原町田', '東京都町田市'],
  ['東京都千代田区丸の内1丁目', '東京都千代田区'],
  ['京都府京都市伏見区横大路', '京都府京都市伏見区'],
  ['北海道余市郡余市町黒川町', '北海道余市郡余市町'],
  ['長野県北佐久郡軽井沢町長倉', '長野県北佐久郡軽井沢町'],
  ['〒060-0001 北海道札幌市中央区北一条', '北海道札幌市中央区'],
] as const) {
  assert.equal(getOpsMunicipality(address), expected, address);
}
assert.equal(getOpsMunicipality('合成倉庫'), undefined);
assert.equal(getOpsMunicipality('中央市場倉庫'), undefined);
assert.equal(getOpsMunicipality('山梨県市川三郷町市川大門'), undefined);
assert.equal(getOpsMunicipality('   '), undefined);

assert.equal(toJstIso('2026-11-12T01:00:00.000Z'), '2026-11-12T10:00:00.000+09:00');
assert.equal(isStale(null, SYNCED), true);
assert.equal(isStale(new Date(Date.parse(SYNCED) - STALE_AFTER_MS).toISOString(), SYNCED), false);
assert.equal(isStale(new Date(Date.parse(SYNCED) - STALE_AFTER_MS - 1).toISOString(), SYNCED), true);
assert.equal(isStale(SEEN_FRESH, SYNCED), false);

const driving = [
  event('start', 'trip_start', TRIP_START),
];
assertMatchesLiveDrive(driving, 'drive');

const resting = [
  event('start', 'trip_start', TRIP_START),
  event('rest', 'rest_start', '2026-11-11T12:00:00.000Z', { session_key: 'restSessionId', session_id: 'rest-1' }),
];
assertMatchesLiveDrive(resting, 'rest');

const breaking = [
  event('start', 'trip_start', TRIP_START),
  event('break', 'break_start', '2026-11-11T13:00:00.000Z', { session_key: 'breakSessionId', session_id: 'break-1' }),
];
assertMatchesLiveDrive(breaking, 'break');

const loading = [
  event('start', 'trip_start', TRIP_START),
  event('load', 'load_start', '2026-11-11T14:00:00.000Z', { session_key: 'loadSessionId', session_id: 'load-1' }),
];
assertMatchesLiveDrive(loading, 'load');

const unloading = [
  event('start', 'trip_start', TRIP_START),
  event('unload', 'unload_start', '2026-11-11T15:00:00.000Z', { session_key: 'unloadSessionId', session_id: 'unload-1' }),
];
assertMatchesLiveDrive(unloading, 'unload');

const working = [
  event('start', 'trip_start', TRIP_START),
  event('work', 'work_start', '2026-11-11T16:00:00.000Z', { session_key: 'workSessionId', session_id: 'work-1' }),
];
assertMatchesLiveDrive(working, 'work');

const resumed = [
  event('start', 'trip_start', TRIP_START),
  event('load', 'load_start', '2026-11-11T14:00:00.000Z', { session_key: 'loadSessionId', session_id: 'load-1' }),
  event('load-end', 'load_end', '2026-11-11T15:00:00.000Z', { session_key: 'loadSessionId', session_id: 'load-1' }),
];
assertMatchesLiveDrive(resumed, 'resumed drive');

const orphanEnd = [
  event('start', 'trip_start', TRIP_START),
  event('orphan', 'unload_end', '2026-11-11T18:00:00.000Z', { session_key: 'unloadSessionId', session_id: 'missing' }),
];
const orphan = buildOpsStatus(activePayload(orphanEnd));
assert.equal(orphan.body.state, '走行');
assert.equal(
  (orphan.body.trip_events as Array<Record<string, unknown>>).some(item => item.kind === 'unload'),
  false,
);

const ferryRest = [
  event('start', 'trip_start', TRIP_START, { address: '東京都千代田区丸の内一丁目9-1' }),
  event('rest', 'rest_start', '2026-11-11T08:00:00.000Z', {
    session_key: 'restSessionId',
    session_id: 'rest-1',
    address: '神奈川県横須賀市平成町',
  }),
  event('ferry', 'boarding', '2026-11-11T10:00:00.000Z', {
    session_key: 'ferrySessionId',
    session_id: 'ferry-1',
    auto_reason: 'ferry_boarding',
    address: '神奈川県横須賀市平成町1丁目',
  }),
  event('exp', 'expressway_start', '2026-11-11T06:00:00.000Z', {
    session_key: 'expresswaySessionId',
    session_id: 'exp-1',
    ic_name: '厚木IC',
    address: '神奈川県厚木市酒井',
  }),
];
const concurrent = buildOpsStatus(activePayload(ferryRest));
assert.equal(concurrent.body.state, 'フェリー');
assert.equal(concurrent.body.state_label, 'フェリー中');
assert.equal(concurrent.body.state_started_at, toJstIso('2026-11-11T10:00:00.000Z'));
assert.deepEqual(concurrent.body.flags, { ferry: true, expressway: true });
assert.equal(concurrent.body.trip_id, 'trip-ferry-1');
assert.equal(concurrent.body.trip_started_at, toJstIso(TRIP_START));
assert.deepEqual(concurrent.body.leg, { day_index: 2, date: '2026-11-12' });
assert.equal(concurrent.body.stale, false);
assert.deepEqual(concurrent.body.place, { kind: 'municipality', name: '神奈川県横須賀市' });
const tripEvents = concurrent.body.trip_events as Array<Record<string, unknown>>;
const todayEvents = concurrent.body.events_today as Array<Record<string, unknown>>;
const ferry = tripEvents.find(item => item.kind === 'ferry');
const rest = tripEvents.find(item => item.kind === 'rest');
const expressway = tripEvents.find(item => item.kind === 'expressway');
const tripStart = tripEvents.find(item => item.kind === 'trip_start');
assert.equal(ferry?.end_at, null);
assert.equal(rest?.end_at, null);
assert.equal(expressway?.end_at, null);
assert.equal(expressway?.place && (expressway.place as { name: string }).name, '厚木IC');
assert.equal('end_at' in (tripStart ?? {}), false);
assert.equal(todayEvents.some(item => item.kind === 'ferry'), true);
assert.equal(todayEvents.some(item => item.kind === 'trip_start'), false);
assert.equal(tripEvents.some(item => item.kind === 'trip_start'), true);
assert.equal(concurrent.geocode, null);
assert.equal(JSON.stringify(concurrent.body).includes('平成町'), false);
assert.equal(JSON.stringify(concurrent.body).includes('酒井'), false);
assertClean(concurrent.body, 'ferry rest expressway');

const stale = buildOpsStatus(activePayload(driving, { seen_at: '2026-11-12T00:30:00.000Z' }));
assert.equal(stale.body.stale, true);
assert.equal(stale.body.state, '走行');
assertClean(stale.body, 'stale');

const closed = buildOpsStatus({
  trip_active: false,
  synced_at: SYNCED,
  stale: true,
  trip_id: 'leftover-trip',
  latest_trip_id: 'leftover-trip',
  latest_lat: CANARY_LAT,
  latest_lng: CANARY_LNG,
  driver_phone: CANARY_PHONE,
  driver_email: CANARY_EMAIL,
  odo_start: CANARY_ODO,
  _reverse_geocode: { lat: CANARY_LAT, lng: CANARY_LNG },
  events: ferryRest,
});
assert.deepEqual(Object.keys(closed.body).sort(), ['stale', 'synced_at', 'trip_active']);
assert.equal(closed.body.trip_active, false);
assert.equal(closed.body.stale, false);
assert.equal(closed.geocode, null);
assertClean(closed.body, 'inactive');

const selection = buildOpsStatus({
  trip_active: false,
  selection_required: true,
  active_count: 2,
  synced_at: SYNCED,
  devices: [
    { device_id: 'device-1', display_name: '運転者A', vehicle_label: '品川800', driver_phone: CANARY_PHONE, latest_lat: CANARY_LAT },
    { device_id: 'device-2', display_name: CANARY_EMAIL, vehicle_label: CANARY_PHONE, latest_lng: CANARY_LNG },
  ],
  _reverse_geocode: { lat: CANARY_LAT, lng: CANARY_LNG },
});
assert.equal(selection.body.selection_required, true);
assert.equal(selection.body.trip_active, false);
assert.deepEqual(selection.body.devices, [
  { device_id: 'device-1', display_name: '運転者A', vehicle_label: '品川800' },
  { device_id: 'device-2', display_name: null, vehicle_label: null },
]);
assert.equal(selection.geocode, null);
assertClean(selection.body, 'selection');

const geocodeFallback = buildOpsStatus(activePayload([
  event('start', 'trip_start', TRIP_START, { address: `${CANARY_LAT},${CANARY_LNG}` }),
]));
assert.equal(geocodeFallback.body.place, null);
assert.deepEqual(geocodeFallback.geocode, { lat: CANARY_LAT, lng: CANARY_LNG });
const placed = applyCoarsePlace(geocodeFallback.body, { kind: 'municipality', name: '東京都千代田区' });
assert.deepEqual(placed.place, { kind: 'municipality', name: '東京都千代田区' });
assertClean(placed, 'reverse geocode fallback');

const heartRails = coarsePlaceFromHeartRails({
  response: {
    location: [
      { prefecture: '大阪府', city: '大阪市北区', town: '梅田', x: String(CANARY_LNG), y: String(CANARY_LAT), distance: 50, postal: '5300001' },
      { prefecture: '大阪府', city: '大阪市中央区', town: '遠い町', x: '135.000001', y: '34.000001', distance: 10, postal: '5400000' },
    ],
  },
});
assert.deepEqual(heartRails, { kind: 'municipality', name: '大阪府大阪市中央区' });
assertClean(heartRails, 'heartrails');

let fetchedUrl = '';
const lookedUp = await reverseGeocodeMunicipality(CANARY_LAT, CANARY_LNG, (async (url: string) => {
  fetchedUrl = String(url);
  return new Response(JSON.stringify({
    response: { location: [{ prefecture: '東京都', city: '千代田区', town: '丸の内', x: String(CANARY_LNG), y: String(CANARY_LAT), distance: 1, postal: '1000005' }] },
  }));
}) as typeof fetch);
assert.equal(lookedUp?.name, '東京都千代田区');
assert.match(fetchedUrl, /geoapi\.heartrails\.com/);
assertClean(lookedUp, 'heartrails fetch result');

const empty = buildOpsStatus(activePayload([]));
assert.equal(empty.body.state, '待機');
assert.equal(empty.body.state_label, '待機中');
assert.equal(empty.body.state_started_at, null);
assertClean(empty.body, 'waiting');

function deps(overrides: Partial<Parameters<typeof handleOpsStatus>[1]> = {}) {
  const calls: Array<string | null> = [];
  const callStatus = overrides.callStatus ?? (async () => activePayload(driving));
  return {
    calls,
    deps: {
      tokenHash: TOKEN_HASH,
      databaseConfigured: true,
      reverseGeocode: async () => ({ kind: 'municipality' as const, name: '東京都千代田区' }),
      ...overrides,
      callStatus: async (deviceId: string | null) => {
        calls.push(deviceId);
        return callStatus(deviceId);
      },
    },
  };
}

async function respond(authorization: string | undefined, url = 'https://example.test/tracklog-ops-status', overrides: Partial<Parameters<typeof handleOpsStatus>[1]> = {}) {
  const wired = deps(overrides);
  const headers = new Headers();
  if (authorization) headers.set('Authorization', authorization);
  const response = await handleOpsStatus(new Request(url, { headers }), wired.deps);
  return { response, calls: wired.calls, body: await response.json() };
}

assert.equal(readBearerToken('bearer tracklog-ops-reader-test-token-0123456789'), TOKEN);
assert.equal(isOpsTokenHash(TOKEN_HASH), true);
assert.equal(isOpsTokenHash('not-a-hash'), false);
assert.equal(await opsTokenMatches(TOKEN, TOKEN_HASH), true);
assert.equal(await opsTokenMatches('service-role-key-placeholder-not-real', TOKEN_HASH), false);

for (const authorization of [
  undefined,
  'Basic abc',
  `Bearer ${'a'.repeat(15)}`,
  'Bearer aaa.bbb.cccccccccccccccc',
  'Bearer service-role-key-placeholder-not-real',
  'Bearer anon-key-placeholder-not-real',
]) {
  const result = await respond(authorization, 'https://example.test/tracklog-ops-status?token=tracklog-ops-reader-test-token-0123456789');
  assert.equal(result.response.status, 401);
  assert.deepEqual(result.body, { ok: false, error: 'unauthorized' });
  assert.equal(result.calls.length, 0);
  assertClean(result.body, 'unauthorized');
}

const missingSecret = await respond(`Bearer ${TOKEN}`, 'https://example.test/tracklog-ops-status', { tokenHash: '' });
assert.equal(missingSecret.response.status, 503);
assert.equal(missingSecret.calls.length, 0);

const databaseDown = await respond(`Bearer ${TOKEN}`, 'https://example.test/tracklog-ops-status', { databaseConfigured: false });
assert.equal(databaseDown.response.status, 503);
assert.equal(databaseDown.calls.length, 0);

const posted = await respond(`Bearer ${TOKEN}`, 'https://example.test/tracklog-ops-status', {});
assert.equal((await handleOpsStatus(new Request('https://example.test/tracklog-ops-status', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } }), deps().deps)).status, 405);

const invalidDevice = await respond(`Bearer ${TOKEN}`, 'https://example.test/tracklog-ops-status?device_id=../secret');
assert.equal(invalidDevice.response.status, 400);
assert.equal(invalidDevice.calls.length, 0);

const inactive = await respond(`Bearer ${TOKEN}`, 'https://example.test/tracklog-ops-status?device_id=', {
  callStatus: async () => ({
    trip_active: false,
    synced_at: SYNCED,
    latest_lat: CANARY_LAT,
    latest_lng: CANARY_LNG,
    driver_phone: CANARY_PHONE,
    driver_email: CANARY_EMAIL,
    odo_start: CANARY_ODO,
    trip_id: 'leftover-trip',
  }),
});
assert.equal(inactive.response.status, 200);
assert.deepEqual(inactive.body, {
  trip_active: false,
  synced_at: toJstIso(SYNCED),
  stale: false,
});
assert.equal(inactive.calls.length, 1);
assertClean(inactive.body, 'http inactive');

const activeHttp = await respond(`Bearer ${TOKEN}`, 'https://example.test/tracklog-ops-status?device_id=device-9', {
  callStatus: async () => activePayload([
    event('start', 'trip_start', TRIP_START),
    event('exp', 'expressway_start', '2026-11-11T06:00:00.000Z', {
      session_key: 'expresswaySessionId',
      session_id: 'exp-1',
      ic_name: '厚木IC',
      address: '神奈川県厚木市酒井1丁目',
    }),
  ]),
  reverseGeocode: async () => {
    throw new Error(`should not fetch ${CANARY_LAT}`);
  },
});
assert.equal(activeHttp.response.status, 200);
assert.equal(activeHttp.calls[0], 'device-9');
assert.equal(activeHttp.body.state, '走行');
assert.deepEqual(activeHttp.body.flags, { ferry: false, expressway: true });
assert.deepEqual(activeHttp.body.place, { kind: 'ic', name: '厚木IC' });
assert.equal(activeHttp.response.headers.get('cache-control'), 'no-store');
assert.equal(activeHttp.response.headers.get('access-control-allow-origin'), null);
assertClean(activeHttp.body, 'http expressway');

const fallbackHttp = await respond(`Bearer ${TOKEN}`, 'https://example.test/tracklog-ops-status', {
  callStatus: async () => activePayload([event('start', 'trip_start', TRIP_START)]),
  reverseGeocode: async (lat: number, lng: number) => {
    assert.equal(lat, CANARY_LAT);
    assert.equal(lng, CANARY_LNG);
    return { kind: 'municipality', name: '北海道札幌市' };
  },
});
assert.deepEqual(fallbackHttp.body.place, { kind: 'municipality', name: '北海道札幌市' });
assert.equal(fallbackHttp.body.stale, false);
assertClean(fallbackHttp.body, 'http reverse geocode');

const staleHttp = await respond(`Bearer ${TOKEN}`, 'https://example.test/tracklog-ops-status', {
  callStatus: async () => activePayload(ferryRest, { seen_at: '2026-11-11T00:00:00.000Z' }),
});
assert.equal(staleHttp.body.stale, true);
assert.equal(staleHttp.body.state, 'フェリー');
assert.equal(staleHttp.body.flags.ferry, true);
assertClean(staleHttp.body, 'http stale ferry');

const poisonedGeocode = await respond(`Bearer ${TOKEN}`, 'https://example.test/tracklog-ops-status', {
  callStatus: async () => activePayload([event('start', 'trip_start', TRIP_START)]),
  reverseGeocode: async () => ({ kind: 'municipality', name: `東京都千代田区 ${CANARY_LAT}` }),
});
assert.equal(poisonedGeocode.response.status, 200);
assert.equal(poisonedGeocode.body.place, null);
assertClean(poisonedGeocode.body, 'poisoned geocode');

const rpcLeak = await respond(`Bearer ${TOKEN}`, 'https://example.test/tracklog-ops-status', {
  callStatus: async () => {
    throw new Error(`database said lat ${CANARY_LAT} phone ${CANARY_PHONE}`);
  },
});
assert.equal(rpcLeak.response.status, 500);
assert.deepEqual(rpcLeak.body, { ok: false, error: 'status_unavailable' });
assertClean(rpcLeak.body, 'rpc error');

assert.equal(posted.calls.length, 1);

const indexSource = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
const migrationSource = await readFile(new URL('../../migrations/20261111120000_tracklog_ops_status.sql', import.meta.url), 'utf8');
const configSource = await readFile(new URL('../../config.toml', import.meta.url), 'utf8');
assert.equal((indexSource.match(/\.rpc\s*\(/g) ?? []).length, 1);
assert.match(indexSource, /tracklog_ops_status/);
assert.doesNotMatch(indexSource, /\.(?:from|insert|update|delete|upsert)\s*\(/);
assert.doesNotMatch(indexSource, /trip_route_points|driver_phone|driver_email|odo_start/);
assert.match(configSource, /\[functions\.tracklog-ops-status\]\s*verify_jwt = false/);
assert.match(migrationSource, /security definer/);
assert.match(migrationSource, /grant execute on function public\.tracklog_ops_status\(text\) to service_role/);
assert.match(migrationSource, /revoke all on function public\.tracklog_ops_status\(text\) from public, anon, authenticated/);
assert.doesNotMatch(migrationSource, /trip_route_points|driver_phone|driver_email|odo_start|odo_end|total_km|last_leg_km/);
assert.doesNotMatch(migrationSource, /\b(?:insert|update|delete|truncate|merge)\b/i);

console.log('tracklog-ops-status: state, coarsening, auth, and leak assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
