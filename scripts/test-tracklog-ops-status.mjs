import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_PATH = path.join(ROOT, 'supabase', 'migrations', '20261111140308_tracklog_ops_status.sql');

const PHONE = '090-5555-0199';
const EMAIL = 'ops-canary@example.test';
const ODO = 909090;
const PROFILE_LAT = 12.345678;
const PROFILE_LNG = 98.765432;
const ROUTE_LAT = 33.333333;
const ROUTE_LNG = 44.444444;

const BASELINE_SQL = `
create schema if not exists auth;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.role', true), '');
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'create role anon nologin';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'create role authenticated nologin';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'create role service_role nologin';
  end if;
end;
$$;

create table public.device_profiles (
  device_id text primary key,
  display_name text not null,
  vehicle_label text,
  driver_phone text,
  driver_email text,
  latest_status text,
  latest_trip_id text,
  latest_lat double precision,
  latest_lng double precision,
  latest_location_at timestamptz,
  last_seen_at timestamptz
);

create table public.trip_headers (
  trip_id text primary key,
  device_id text not null,
  start_ts timestamptz not null,
  status text not null,
  odo_start integer,
  odo_end integer,
  total_km integer,
  last_leg_km integer
);

create table public.trip_events (
  id text primary key,
  trip_id text not null,
  type text not null,
  ts timestamptz not null,
  address text,
  geo jsonb,
  extras jsonb
);

create table public.trip_route_points (
  id text primary key,
  trip_id text not null,
  lat double precision not null,
  lng double precision not null
);
`;

const db = new PGlite();
let passed = 0;

function asPayload(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function walkKeys(value, path, visit) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkKeys(item, `${path}[${index}]`, visit));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    visit(key, `${path}.${key}`);
    walkKeys(child, `${path}.${key}`, visit);
  }
}

function assertNoSensitiveKeys(value, allowedPaths = new Set()) {
  walkKeys(value, '$', (key, keyPath) => {
    if (allowedPaths.has(keyPath)) return;
    assert.doesNotMatch(key, /lat|lng|lon|geo|phone|mail|odo|coord|accuracy|postal|town|route|address|extras/i, keyPath);
  });
}

async function check(name, run) {
  await run();
  passed += 1;
  console.log(`[ok] ${name}`);
}

async function expectSqlState(run, code) {
  let error;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `expected SQLSTATE ${code}`);
  assert.equal(error.code, code);
}

async function setRole(role) {
  await db.exec(`select set_config('request.jwt.claim.role', '${role}', false)`);
  await db.exec(`set role ${role}`);
}

async function callStatus(deviceId = null) {
  const result = await db.query('select public.tracklog_ops_status($1) as payload', [deviceId]);
  return asPayload(result.rows[0].payload);
}

async function counts() {
  const result = await db.query(`
    select
      (select count(*) from public.device_profiles) as profiles,
      (select count(*) from public.trip_headers) as trips,
      (select count(*) from public.trip_events) as events,
      (select count(*) from public.trip_route_points) as points
  `);
  return result.rows[0];
}

try {
  await db.exec(BASELINE_SQL);
  const migration = await readFile(MIGRATION_PATH, 'utf8');
  await db.exec(migration);

  await check('function is security definer and hidden from anon and authenticated', async () => {
    const meta = (await db.query(`
      select prosecdef, proconfig::text as config
      from pg_proc
      where oid = 'public.tracklog_ops_status(text)'::regprocedure
    `)).rows[0];
    assert.equal(meta.prosecdef, true);
    assert.match(meta.config, /statement_timeout=3s/);
    const privileges = (await db.query(`
      select
        has_function_privilege('anon', 'public.tracklog_ops_status(text)', 'EXECUTE') as anon,
        has_function_privilege('authenticated', 'public.tracklog_ops_status(text)', 'EXECUTE') as authenticated,
        has_function_privilege('service_role', 'public.tracklog_ops_status(text)', 'EXECUTE') as service_role
    `)).rows[0];
    assert.deepEqual(privileges, { anon: false, authenticated: false, service_role: true });
    const definition = (await db.query(`
      select pg_get_functiondef('public.tracklog_ops_status(text)'::regprocedure) as definition
    `)).rows[0].definition;
    assert.doesNotMatch(definition, /trip_route_points|driver_phone|driver_email|odo_start|odo_end|total_km|last_leg_km/);
    assert.doesNotMatch(definition, /\b(?:insert into|update public|delete from|truncate|merge into)\b/i);
  });

  await check('anon and a user JWT cannot execute the snapshot', async () => {
    await setRole('anon');
    await expectSqlState(() => callStatus(null), '42501');
    await db.exec('reset role');
    await setRole('authenticated');
    await expectSqlState(() => callStatus(null), '42501');
    await db.exec('reset role');
    await db.exec("select set_config('request.jwt.claim.role', 'authenticated', false)");
    await db.exec('set role service_role');
    await expectSqlState(() => callStatus(null), '42501');
    await db.exec('reset role');
    await setRole('service_role');
    const empty = await callStatus(null);
    assert.equal(empty.trip_active, false);
    assert.deepEqual(Object.keys(empty).sort(), ['stale', 'synced_at', 'trip_active']);
    await db.exec('reset role');
  });

  await db.exec("select set_config('request.jwt.claim.role', 'service_role', false)");

  await check('a closed trip ignores leftover device location and identifiers', async () => {
    await db.query(
      `insert into public.device_profiles (
         device_id, display_name, vehicle_label, driver_phone, driver_email,
         latest_status, latest_trip_id, latest_lat, latest_lng, latest_location_at, last_seen_at
       ) values (
         'device-closed', '運転者A', '品川800', $1, $2,
         '運転中', 'leftover-trip', $3, $4, now(), now()
       )`,
      [PHONE, EMAIL, PROFILE_LAT, PROFILE_LNG],
    );
    await db.query(
      `insert into public.trip_headers (
         trip_id, device_id, start_ts, status, odo_start, odo_end, total_km, last_leg_km
       ) values ('leftover-trip', 'device-closed', now() - interval '2 days', 'closed', $1, $1, 10, 10)`,
      [ODO],
    );
    await db.query(
      `insert into public.trip_route_points (id, trip_id, lat, lng)
       values ('route-point-canary', 'leftover-trip', $1, $2)`,
      [ROUTE_LAT, ROUTE_LNG],
    );
    const before = await counts();
    const payload = await callStatus(null);
    assert.deepEqual(Object.keys(payload).sort(), ['stale', 'synced_at', 'trip_active']);
    assert.equal(payload.trip_active, false);
    assert.equal(payload.stale, false);
    const text = JSON.stringify(payload);
    assert.doesNotMatch(text, /12\.345678|33\.333333|route-point-canary|090-5555-0199|ops-canary@example\.test|909090|leftover-trip/);
    assert.deepEqual(await counts(), before);
  });

  await check('an active trip returns events without coordinates, contact, odometer, or route points', async () => {
    await db.query(
      `insert into public.device_profiles (
         device_id, display_name, vehicle_label, driver_phone, driver_email,
         latest_status, latest_trip_id, latest_lat, latest_lng, latest_location_at, last_seen_at
       ) values (
         'device-active', '運転者B', '足立100', $1, $2,
         '休息中', 'old-trip', $3, $4, now() - interval '2 minutes', now() - interval '2 minutes'
       )`,
      [PHONE, EMAIL, PROFILE_LAT, PROFILE_LNG],
    );
    await db.query(
      `insert into public.trip_headers (
         trip_id, device_id, start_ts, status, odo_start, odo_end, total_km, last_leg_km
       ) values ('trip-active', 'device-active', '2026-11-10T15:00:00Z', 'active', $1, null, null, null)`,
      [ODO],
    );
    await db.query(
      `insert into public.trip_events (id, trip_id, type, ts, address, geo, extras)
       values
         ('evt-start', 'trip-active', 'trip_start', '2026-11-10T15:00:00Z',
          '東京都千代田区丸の内一丁目9-1', $1::jsonb, $2::jsonb),
         ('evt-rest', 'trip-active', 'rest_start', '2026-11-11T08:00:00Z',
          '神奈川県横須賀市平成町', $1::jsonb, $3::jsonb),
         ('evt-ferry', 'trip-active', 'boarding', '2026-11-11T10:00:00Z',
          '神奈川県横須賀市平成町1丁目', $1::jsonb, $4::jsonb)`,
      [
        JSON.stringify({ lat: PROFILE_LAT, lng: PROFILE_LNG }),
        JSON.stringify({ odoKm: ODO, phone: PHONE, email: EMAIL }),
        JSON.stringify({ restSessionId: 'rest-1', odoKm: ODO }),
        JSON.stringify({ ferrySessionId: 'ferry-1', autoReason: 'ferry_boarding', icName: '横須賀IC' }),
      ],
    );
    await db.query(
      `insert into public.trip_route_points (id, trip_id, lat, lng)
       values ('route-point-active', 'trip-active', $1, $2)`,
      [ROUTE_LAT, ROUTE_LNG],
    );
    const before = await counts();
    const payload = await callStatus('device-active');
    assert.equal(payload.trip_active, true);
    assert.equal(payload.trip_id, 'trip-active');
    assert.equal(payload.device_id, 'device-active');
    assert.equal(payload.stale, false);
    assert.deepEqual(payload._reverse_geocode, { lat: PROFILE_LAT, lng: PROFILE_LNG });
    const events = payload.events;
    assert.equal(events.length, 3);
    assert.equal(events[2].ic_name, '横須賀IC');
    assert.equal(events[2].session_key, 'ferrySessionId');
    assert.equal(events[2].session_id, 'ferry-1');
    assert.equal(events[2].auto_reason, 'ferry_boarding');
    assert.equal(events[1].session_id, 'rest-1');
    assert.equal(Object.hasOwn(events[0], 'geo'), false);
    assert.equal(Object.hasOwn(events[0], 'extras'), false);
    const stripped = JSON.parse(JSON.stringify(payload));
    delete stripped._reverse_geocode;
    for (const item of stripped.events) delete item.address;
    const text = JSON.stringify(stripped);
    assert.doesNotMatch(text, /12\.345678|98\.765432|33\.333333|44\.444444|route-point|090-5555-0199|ops-canary@example\.test|909090/);
    assertNoSensitiveKeys(stripped, new Set());
    assert.deepEqual(await counts(), before);
  });

  await check('a stale active trip is marked from the heartbeat age', async () => {
    await db.query(
      `update public.device_profiles
         set last_seen_at = now() - interval '16 minutes',
             latest_location_at = now() - interval '16 minutes'
       where device_id = 'device-active'`,
    );
    const payload = await callStatus('device-active');
    assert.equal(payload.trip_active, true);
    assert.equal(payload.stale, true);
    const stripped = JSON.parse(JSON.stringify(payload));
    delete stripped._reverse_geocode;
    assert.doesNotMatch(JSON.stringify(stripped), /12\.345678|090-5555-0199|ops-canary@example\.test/);
  });

  await check('requesting a device without an active trip does not reveal another device', async () => {
    const payload = await callStatus('device-closed');
    assert.deepEqual(Object.keys(payload).sort(), ['stale', 'synced_at', 'trip_active']);
    assert.equal(payload.trip_active, false);
    assert.doesNotMatch(JSON.stringify(payload), /trip-active|device-active|12\.345678/);
  });

  await check('several active trips require a device id and do not include coordinates', async () => {
    await db.query(
      `insert into public.device_profiles (
         device_id, display_name, vehicle_label, driver_phone, driver_email, latest_lat, latest_lng, last_seen_at
       ) values ('device-second', '運転者C', '川崎200', $1, $2, $3, $4, now())`,
      [PHONE, EMAIL, ROUTE_LAT, ROUTE_LNG],
    );
    await db.query(
      `insert into public.trip_headers (trip_id, device_id, start_ts, status, odo_start)
       values ('trip-second', 'device-second', '2026-11-11T00:00:00Z', 'active', $1)`,
      [ODO],
    );
    const payload = await callStatus(null);
    assert.equal(payload.selection_required, true);
    assert.equal(payload.trip_active, false);
    assert.equal(payload.active_count, 2);
    assert.deepEqual(payload.devices.map(device => device.device_id), ['device-active', 'device-second']);
    assert.equal(Object.hasOwn(payload, '_reverse_geocode'), false);
    const text = JSON.stringify(payload);
    assert.doesNotMatch(text, /12\.345678|33\.333333|090-5555-0199|ops-canary@example\.test|909090|route-point/);
    assertNoSensitiveKeys(payload);
    const chosen = await callStatus('device-second');
    assert.equal(chosen.trip_id, 'trip-second');
    assert.equal(chosen.trip_active, true);
  });

  await check('an invalid device id is rejected before any snapshot is built', async () => {
    await expectSqlState(() => callStatus('../secret'), '22023');
  });

  console.log(`tracklog-ops-status sql: ${passed} checks passed`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.close();
}
