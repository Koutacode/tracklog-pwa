import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20261111144500_tracklog_ops_closed_trip.sql');
const PHONE = '090-5555-0199';
const EMAIL = 'ops-canary@example.test';
const LAT = 12.345678;
const LNG = 98.765432;
const TRIP = '11111111-1111-4111-8111-111111111111';

const db = new PGlite();

function payloadOf(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function call(tripId) {
  const result = await db.query('select public.tracklog_ops_closed_trip($1) as payload', [tripId]);
  return payloadOf(result.rows[0].payload);
}

try {
  await db.exec(`
    create schema if not exists auth;
    create or replace function auth.role()
    returns text language sql stable as $$
      select nullif(current_setting('request.jwt.claim.role', true), '');
    $$;
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then execute 'create role anon nologin'; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'create role authenticated nologin'; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then execute 'create role service_role nologin'; end if;
    end $$;
    create table public.trip_headers (
      trip_id text primary key,
      device_id text not null,
      start_ts timestamptz not null,
      end_ts timestamptz,
      status text not null,
      odo_start integer
    );
    create table public.trip_events (
      id text primary key,
      trip_id text not null,
      device_id text not null,
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
    create table public.device_profiles (
      device_id text primary key,
      driver_phone text,
      driver_email text,
      latest_lat double precision,
      latest_lng double precision
    );
  `);
  await db.exec(await readFile(MIGRATION, 'utf8'));

  const privileges = (await db.query(`
    select
      has_function_privilege('anon', 'public.tracklog_ops_closed_trip(text)', 'EXECUTE') as anon,
      has_function_privilege('authenticated', 'public.tracklog_ops_closed_trip(text)', 'EXECUTE') as authenticated,
      has_function_privilege('service_role', 'public.tracklog_ops_closed_trip(text)', 'EXECUTE') as service_role
  `)).rows[0];
  assert.deepEqual(privileges, { anon: false, authenticated: false, service_role: true });

  await db.exec("select set_config('request.jwt.claim.role', 'service_role', false)");
  await db.query(
    `insert into public.device_profiles (device_id, driver_phone, driver_email, latest_lat, latest_lng)
     values ('device-1', $1, $2, $3, $4)`,
    [PHONE, EMAIL, LAT, LNG],
  );
  await db.query(
    `insert into public.trip_headers (trip_id, device_id, start_ts, end_ts, status, odo_start)
     values ($1, 'device-1', '2026-11-10T15:00:00Z', null, 'active', 909090)`,
    [TRIP],
  );
  await db.query(
    `insert into public.trip_events (id, trip_id, device_id, type, ts, address, geo, extras)
     values ('evt-1', $1, 'device-1', 'trip_start', '2026-11-10T15:00:00Z',
             '東京都千代田区丸の内一丁目', $2::jsonb, $3::jsonb)`,
    [TRIP, JSON.stringify({ lat: LAT, lng: LNG }), JSON.stringify({ odoKm: 909090, phone: PHONE })],
  );
  await db.query(
    `insert into public.trip_route_points (id, trip_id, lat, lng) values ('route-point-canary', $1, $2, $3)`,
    [TRIP, LAT, LNG],
  );

  const before = (await db.query(`
    select
      (select count(*) from public.trip_headers) as trips,
      (select count(*) from public.trip_events) as events
  `)).rows[0];
  const active = await call(TRIP);
  assert.deepEqual(active, { closed: false });
  assert.doesNotMatch(JSON.stringify(active), /12\.345678|090-5555-0199|device-1|丸の内|route-point/);

  await db.query(`update public.trip_headers set status = 'closed', end_ts = '2026-11-11T12:00:00Z' where trip_id = $1`, [TRIP]);
  const closed = await call(TRIP);
  assert.equal(closed.closed, true);
  assert.equal(closed.trip_id, TRIP);
  assert.equal(Object.hasOwn(closed, 'device_id'), false);
  assert.equal(closed.events.length, 1);
  assert.equal(closed.events[0].address, '東京都千代田区丸の内一丁目');
  assert.equal(Object.hasOwn(closed.events[0], 'geo'), false);
  const stripped = JSON.parse(JSON.stringify(closed));
  delete stripped.events[0].address;
  assert.doesNotMatch(JSON.stringify(stripped), /12\.345678|090-5555-0199|ops-canary|909090|device-1|route-point|丸の内/);
  const after = (await db.query(`
    select
      (select count(*) from public.trip_headers) as trips,
      (select count(*) from public.trip_events) as events
  `)).rows[0];
  assert.equal(String(before.trips), String(after.trips));
  assert.equal(String(before.events), String(after.events));

  console.log('tracklog-ops-closed-trip sql: closed-only read and privilege checks passed');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.close();
}
