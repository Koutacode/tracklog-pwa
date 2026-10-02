import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION_PATH = path.join(
  ROOT,
  "supabase",
  "migrations",
  "20260710043340_tracklog_sync_v2.sql",
);
const DISK_IO_MIGRATION_PATH = path.join(
  ROOT,
  "supabase",
  "migrations",
  "20260930165335_tracklog_sync_v2_reduce_disk_io.sql",
);
const OTHER_WORK_MIGRATION_PATH = path.join(
  ROOT,
  "supabase",
  "migrations",
  "20261002011750_tracklog_other_work_events.sql",
);
const ROLLBACK_PATH = path.join(ROOT, "docs", "sql", "rollback-tracklog-sync-v2-reduce-disk-io.sql");

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const DEVICE_ID = "sync-v2-primary-device";
const OWNER_EMAIL = "driver@example.test";
const ADMIN_EMAIL = "admin@example.test";
const TS = "2026-07-10T01:00:00.000Z";

const BASELINE_SQL = `
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

create schema auth;
create schema tracklog_private;

create table auth.users (
  id uuid primary key,
  email text not null unique
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.role', true), '');
$$;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), ''),
    '{}'
  )::jsonb;
$$;

create table public.admin_users (
  email text primary key,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create or replace function public.is_tracklog_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
  select exists (
    select 1
    from public.admin_users admin
    where admin.enabled = true
      and lower(admin.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

create table public.device_profiles (
  device_id text primary key,
  auth_user_id uuid not null references auth.users (id) on delete cascade,
  display_name text not null,
  vehicle_label text,
  driver_phone text,
  driver_email text,
  platform text not null,
  app_version text,
  latest_status text,
  latest_trip_id text,
  latest_lat double precision,
  latest_lng double precision,
  latest_accuracy double precision,
  latest_location_at timestamptz,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approval_status text not null default 'pending'
    check (approval_status in ('pending', 'approved', 'rejected')),
  approval_requested_at timestamptz default now(),
  approval_decided_at timestamptz,
  approval_decided_by uuid references auth.users (id) on delete set null
);

create table public.trip_headers (
  trip_id text primary key,
  device_id text not null,
  start_ts timestamptz not null,
  end_ts timestamptz,
  odo_start integer not null,
  odo_end integer,
  total_km integer,
  last_leg_km integer,
  status text not null check (status in ('active', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trip_headers_device_id_fkey foreign key (device_id)
    references public.device_profiles (device_id) on delete cascade
);

create table public.trip_events (
  id text primary key,
  trip_id text not null,
  device_id text not null,
  type text not null,
  ts timestamptz not null,
  address text,
  geo jsonb,
  extras jsonb,
  sync_status text not null default 'pending'
    check (sync_status in ('pending', 'synced', 'error')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trip_events_trip_id_fkey foreign key (trip_id)
    references public.trip_headers (trip_id) on delete cascade,
  constraint trip_events_device_id_fkey foreign key (device_id)
    references public.device_profiles (device_id) on delete cascade
);

create table public.trip_route_points (
  id text primary key,
  trip_id text not null,
  device_id text not null,
  ts timestamptz not null,
  lat double precision not null,
  lng double precision not null,
  accuracy double precision,
  speed double precision,
  heading double precision,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trip_route_points_trip_id_fkey foreign key (trip_id)
    references public.trip_headers (trip_id) on delete cascade,
  constraint trip_route_points_device_id_fkey foreign key (device_id)
    references public.device_profiles (device_id) on delete cascade
);

create table public.report_snapshots (
  trip_id text primary key,
  device_id text not null,
  created_at timestamptz not null,
  label text not null,
  payload_json jsonb not null,
  updated_at timestamptz not null default now(),
  constraint report_snapshots_trip_id_fkey foreign key (trip_id)
    references public.trip_headers (trip_id) on delete cascade,
  constraint report_snapshots_device_id_fkey foreign key (device_id)
    references public.device_profiles (device_id) on delete cascade
);

create table public.deleted_trip_tombstones (
  trip_id text primary key,
  device_id text not null,
  deleted_by uuid not null references auth.users (id) on delete cascade,
  deleted_at timestamptz not null default now(),
  constraint deleted_trip_tombstones_device_id_fkey foreign key (device_id)
    references public.device_profiles (device_id) on delete cascade
);

create table public.deleted_event_tombstones (
  event_id text primary key,
  trip_id text not null,
  device_id text not null,
  event_type text,
  event_ts timestamptz,
  deleted_by uuid not null references auth.users (id) on delete cascade,
  deleted_at timestamptz not null default now(),
  constraint deleted_event_tombstones_device_id_fkey foreign key (device_id)
    references public.device_profiles (device_id) on delete cascade
);

create table public.tracklog_admin_messages (
  id uuid primary key,
  target_device_id text references public.device_profiles (device_id) on delete cascade,
  body text not null check (char_length(trim(body)) between 1 and 200),
  request_location boolean not null default true,
  sent_by uuid references auth.users (id) on delete set null,
  sent_at timestamptz not null default now()
);

create table public.tracklog_admin_message_receipts (
  message_id uuid not null references public.tracklog_admin_messages (id) on delete cascade,
  device_id text not null references public.device_profiles (device_id) on delete cascade,
  received_at timestamptz not null default now(),
  location_requested_at timestamptz,
  primary key (message_id, device_id)
);

create table public.tracklog_push_registrations (
  id uuid primary key,
  device_id text not null references public.device_profiles (device_id) on delete cascade,
  auth_user_id uuid references auth.users (id) on delete cascade,
  provider text not null default 'fcm' check (provider in ('fcm')),
  platform text not null check (platform in ('android', 'web')),
  token text not null,
  token_hash text not null,
  enabled boolean not null default true,
  failure_count integer not null default 0 check (failure_count >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (provider, token_hash)
);

insert into auth.users (id, email) values
  ('${OWNER_ID}', '${OWNER_EMAIL}'),
  ('${ADMIN_ID}', '${ADMIN_EMAIL}');

insert into public.admin_users (email, enabled)
values ('${ADMIN_EMAIL}', true);

insert into public.device_profiles (
  device_id, auth_user_id, display_name, platform, approval_status,
  approval_requested_at, approval_decided_at, approval_decided_by
) values (
  '${DEVICE_ID}', '${OWNER_ID}', 'Primary test device', 'android', 'approved',
  now(), now(), '${ADMIN_ID}'
);
`;

let mutationSequence = 1;
function nextMutationId() {
  const suffix = String(mutationSequence).padStart(12, "0");
  mutationSequence += 1;
  return `00000000-0000-4000-8000-${suffix}`;
}

function tripMutation(mutationId, tripId, baseRevision = 0, overrides = {}) {
  return {
    mutationId,
    entityType: "trip",
    entityId: tripId,
    operation: "upsert",
    baseRevision,
    payload: {
      start_ts: TS,
      end_ts: "2026-07-10T02:00:00.000Z",
      odo_start: 1000,
      odo_end: 1025,
      total_km: 25,
      last_leg_km: 25,
      status: "closed",
      ...overrides,
    },
  };
}

function eventMutation(mutationId, eventId, tripId, baseRevision = 0, overrides = {}) {
  return {
    mutationId,
    entityType: "event",
    entityId: eventId,
    operation: "upsert",
    baseRevision,
    payload: {
      trip_id: tripId,
      type: "point_mark",
      ts: "2026-07-10T01:15:00.000Z",
      address: "Initial point",
      geo: { lat: 35.6812, lng: 139.7671, accuracy: 5 },
      extras: { source: "pglite-test" },
      ...overrides,
    },
  };
}

function routeMutation(mutationId, pointId, tripId, baseRevision = 0) {
  return {
    mutationId,
    entityType: "routePoint",
    entityId: pointId,
    operation: "upsert",
    baseRevision,
    payload: {
      trip_id: tripId,
      ts: "2026-07-10T01:20:00.000Z",
      lat: 35.68,
      lng: 139.76,
      accuracy: 4,
      speed: 12,
      heading: 90,
      source: "background",
    },
  };
}

function reportMutation(mutationId, tripId, baseRevision = 0, overrides = {}) {
  return {
    mutationId,
    entityType: "report",
    entityId: tripId,
    operation: "upsert",
    baseRevision,
    payload: {
      trip_id: tripId,
      created_at: "2026-07-10T02:05:00.000Z",
      label: `Report ${tripId}`,
      payload_json: { tripId, source: "pglite-test" },
      ...overrides,
    },
  };
}

function tripDeleteMutation(mutationId, tripId, baseRevision) {
  return {
    mutationId,
    entityType: "tripDelete",
    entityId: tripId,
    operation: "delete",
    baseRevision,
    payload: { deleted_at: "2026-07-10T03:00:00.000Z" },
  };
}

function eventDeleteMutation(mutationId, eventId, tripId, baseRevision) {
  return {
    mutationId,
    entityType: "eventDelete",
    entityId: eventId,
    operation: "delete",
    baseRevision,
    payload: {
      trip_id: tripId,
      deleted_at: "2026-07-10T03:05:00.000Z",
    },
  };
}

function reportDeleteMutation(mutationId, tripId, baseRevision) {
  return {
    mutationId,
    entityType: "reportDelete",
    entityId: tripId,
    operation: "delete",
    baseRevision,
    payload: {
      trip_id: tripId,
      deleted_at: "2026-07-10T03:10:00.000Z",
    },
  };
}

function decodeJson(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function asNumber(value) {
  return Number(value);
}

function assertEmptyChanges(changes) {
  for (const rows of Object.values(changes)) {
    assert.deepEqual(rows, []);
  }
}

const db = new PGlite();
let passed = 0;
let cursor = 0;
let originalSyncFunctionSql;
let optimizedSyncSql;
let otherWorkMigrationSql;

async function check(name, run) {
  await run();
  passed += 1;
  console.log(`[ok] ${name}`);
}

async function firstRow(sql, params = []) {
  const result = await db.query(sql, params);
  assert.ok(result.rows.length > 0, `Expected a row from: ${sql}`);
  return result.rows[0];
}

async function mutationFunctionMetadata() {
  return firstRow(`select pg_get_functiondef(oid) as definition,
    proacl::text as acl, proowner::regrole::text as owner,
    prosecdef as security_definer, proconfig as config
    from pg_proc
    where oid = 'tracklog_private.apply_tracklog_sync_mutation(uuid,text,jsonb)'::regprocedure`);
}

async function countRows(sql, params = []) {
  const row = await firstRow(sql, params);
  return asNumber(row.count);
}

async function setAuth(userId, email, role = "authenticated") {
  await db.query(
    `select
       set_config('request.jwt.claim.sub', $1, false),
       set_config('request.jwt.claim.role', $2, false),
       set_config('request.jwt.claims', $3, false)`,
    [userId, role, JSON.stringify({ sub: userId, role, email })],
  );
}

async function sync(mutations, options = {}) {
  const deviceId = options.deviceId ?? DEVICE_ID;
  const fromCursor = options.cursor ?? cursor;
  const advance = options.advance ?? true;
  const row = await firstRow(
    `select public.tracklog_sync_v2(
       $1::uuid,
       $2::text,
       $3::bigint,
       $4::jsonb
     ) as response`,
    [OWNER_ID, deviceId, fromCursor, JSON.stringify(mutations)],
  );
  const response = decodeJson(row.response);
  assert.equal(response.ok, true);
  assert.equal(response.data.protocolVersion, 2);
  const nextCursor = asNumber(response.data.cursor);
  assert.ok(nextCursor >= fromCursor, "sync cursor must not move backwards");
  if (advance) {
    assert.ok(nextCursor >= cursor, "owner cursor must be monotonic");
    cursor = nextCursor;
  }
  return response.data;
}

async function receiptCount(mutationId) {
  return countRows(
    `select count(*)::integer as count
     from public.tracklog_sync_mutations
     where owner_user_id = $1::uuid and mutation_id = $2::uuid`,
    [OWNER_ID, mutationId],
  );
}

async function expectSqlState(run, code, messagePattern) {
  let error;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `Expected SQLSTATE ${code}`);
  assert.equal(error.code, code);
  assert.match(error.message, messagePattern);
}

async function insertApprovedDevice(deviceId, label) {
  await db.query(
    `insert into public.device_profiles (
       device_id, auth_user_id, display_name, platform, approval_status,
       approval_requested_at, approval_decided_at, approval_decided_by
     ) values ($1, $2::uuid, $3, 'android', 'approved', now(), now(), $4::uuid)`,
    [deviceId, OWNER_ID, label, ADMIN_ID],
  );
}

try {
  await db.exec(`begin;\n${BASELINE_SQL}\ncommit;`);
  await setAuth(OWNER_ID, OWNER_EMAIL);

  await check("applies the complete sync-v2 migration", async () => {
    const migrationSql = await readFile(MIGRATION_PATH, "utf8");
    assert.match(migrationSql, /create or replace function public\.tracklog_sync_v2/);
    assert.match(migrationSql, /create or replace function public\.migrate_tracklog_device_records/);
    await db.exec(`begin;\n${migrationSql}\ncommit;`);

    const row = await firstRow(
      `select
         to_regprocedure('public.tracklog_sync_v2(uuid,text,bigint,jsonb)') is not null as sync_exists,
         to_regprocedure('public.tracklog_admin_delete_trip_v2(uuid,text)') is not null as admin_delete_exists,
         auth.uid() as current_uid,
         auth.role() as current_role`,
    );
    assert.equal(row.sync_exists, true);
    assert.equal(row.admin_delete_exists, true);
    assert.equal(row.current_uid, OWNER_ID);
    assert.equal(row.current_role, "authenticated");
  });

  await check("applies the reversible function-only disk IO optimization without schema or grant drift", async () => {
    const original = (await readFile(MIGRATION_PATH, "utf8")).replace(/\r\n/g, "\n");
    const functionStart = original.indexOf("create or replace function public.tracklog_sync_v2(");
    const grantsEnd = "grant execute on function public.tracklog_sync_v2(uuid, text, bigint, jsonb) to service_role;";
    originalSyncFunctionSql = original.slice(functionStart, original.indexOf(grantsEnd, functionStart) + grantsEnd.length);
    optimizedSyncSql = await readFile(DISK_IO_MIGRATION_PATH, "utf8");
    const rollbackSql = (await readFile(ROLLBACK_PATH, "utf8")).replace(/\r\n/g, "\n");
    assert.ok(rollbackSql.includes(originalSyncFunctionSql), "rollback must restore the exact previous function and grants");
    assert.doesNotMatch(optimizedSyncSql, /\b(?:delete from|drop|create index|alter table)\b/i);
    const metadataSql = `select jsonb_build_object(
      'indexes', (select jsonb_agg(indexdef order by indexname) from pg_indexes where schemaname = 'public'),
      'constraints', (select jsonb_agg(pg_get_constraintdef(oid) order by conname) from pg_constraint where connamespace = 'public'::regnamespace),
      'rls', (select jsonb_agg(jsonb_build_array(relname, relrowsecurity, relforcerowsecurity) order by relname) from pg_class where relnamespace = 'public'::regnamespace),
      'policies', (select jsonb_agg(to_jsonb(policy) order by tablename, policyname) from pg_policies policy where schemaname = 'public'),
      'syncAcl', (select proacl from pg_proc where oid = 'public.tracklog_sync_v2(uuid,text,bigint,jsonb)'::regprocedure)
    ) as metadata`;
    const before = (await firstRow(metadataSql)).metadata;
    await db.exec(optimizedSyncSql);
    assert.deepEqual((await firstRow(metadataSql)).metadata, before);

    // All existing mutation handling stays byte-for-byte identical.
    const optimizedStart = optimizedSyncSql.indexOf("create or replace function public.tracklog_sync_v2(");
    assert.equal(
      optimizedSyncSql.slice(optimizedStart, optimizedSyncSql.indexOf("  update public.device_profiles", optimizedStart)),
      originalSyncFunctionSql.slice(0, originalSyncFunctionSql.indexOf("  update public.device_profiles")),
    );
  });

  await check("adds other work event allowlists idempotently without changing unrelated mutation handling or RPC grants", async () => {
    otherWorkMigrationSql = await readFile(OTHER_WORK_MIGRATION_PATH, "utf8");
    const before = await mutationFunctionMetadata();
    const syncBefore = await firstRow(`select pg_get_functiondef(oid) as definition, proacl::text as acl
      from pg_proc where oid = 'public.tracklog_sync_v2(uuid,text,bigint,jsonb)'::regprocedure`);
    const oldTail = "'expressway_end', 'point_mark'";
    const newTail = "'expressway_end', 'point_mark', 'work_start', 'work_end'";
    assert.equal(before.definition.split(oldTail).length - 1, 2);
    await db.exec(otherWorkMigrationSql);
    const applied = await mutationFunctionMetadata();
    assert.deepEqual(applied, {
      ...before,
      definition: before.definition.replaceAll(oldTail, newTail),
    });
    await db.exec(otherWorkMigrationSql);
    assert.deepEqual(await mutationFunctionMetadata(), applied, "reapplying must leave function and metadata unchanged");
    assert.deepEqual(await firstRow(`select pg_get_functiondef(oid) as definition, proacl::text as acl
      from pg_proc where oid = 'public.tracklog_sync_v2(uuid,text,bigint,jsonb)'::regprocedure`), syncBefore);
  });

  await check("fails closed for unknown or partially updated event allowlists", async () => {
    const applied = await mutationFunctionMetadata();
    const newTail = "'expressway_end', 'point_mark', 'work_start', 'work_end'";
    const fixtures = [
      {
        definition: applied.definition.replaceAll(newTail, "'expressway_end', 'unexpected_test_event'"),
        message: /Unexpected sync event allowlists/,
      },
      {
        definition: applied.definition.replace(newTail, "'expressway_end', 'point_mark'"),
        message: /Other work event allowlists are incomplete/,
      },
    ];
    for (const fixture of fixtures) {
      await db.exec("begin");
      try {
        await db.exec(fixture.definition);
        await expectSqlState(() => db.exec(otherWorkMigrationSql), "P0001", fixture.message);
      } finally {
        await db.exec("rollback");
      }
      assert.deepEqual(await mutationFunctionMetadata(), applied);
    }
  });

  await check("retains service-role-only RPC access, device approval, owner and input validation", async () => {
    const privileges = await firstRow(`select
      has_function_privilege('anon', 'public.tracklog_sync_v2(uuid,text,bigint,jsonb)', 'EXECUTE') as anon,
      has_function_privilege('authenticated', 'public.tracklog_sync_v2(uuid,text,bigint,jsonb)', 'EXECUTE') as authenticated,
      has_function_privilege('service_role', 'public.tracklog_sync_v2(uuid,text,bigint,jsonb)', 'EXECUTE') as service_role`);
    assert.deepEqual(privileges, { anon: false, authenticated: false, service_role: true });
    await db.exec("set role authenticated");
    try {
      await expectSqlState(() => sync([]), "42501", /permission denied/);
    } finally {
      await db.exec("reset role");
    }
    await expectSqlState(() => sync([], { deviceId: "missing-device" }), "42501", /approved device/);
    const pendingDevice = "pending-disk-io-test";
    await insertApprovedDevice(pendingDevice, "Pending device");
    await db.query("update public.device_profiles set approval_status = 'pending' where device_id = $1", [pendingDevice]);
    await expectSqlState(() => sync([], { deviceId: pendingDevice }), "42501", /approved device/);
    await expectSqlState(
      () => db.query("select public.tracklog_sync_v2($1::uuid, $2, 0, '[]'::jsonb)", [ADMIN_ID, DEVICE_ID]),
      "42501", /approved device/,
    );
    await expectSqlState(() => sync([], { cursor: 1 }), "22023", /ahead of the owner/);
    await expectSqlState(() => sync(Array.from({ length: 421 }, () => ({}))), "22023", /at most 420/);
  });

  await check("refreshes first sync and protocol upgrades immediately while suppressing repeated profile writes for 60 seconds", async () => {
    await db.exec(`
      create temporary table profile_sync_update_log (device_id text);
      create function pg_temp.capture_profile_sync_update() returns trigger language plpgsql as $$
      begin
        insert into profile_sync_update_log values (new.device_id);
        return new;
      end;
      $$;
      create trigger test_capture_profile_sync_update after update on public.device_profiles
      for each row execute function pg_temp.capture_profile_sync_update();
    `);
    const getProfile = () => firstRow(`select sync_protocol_version, last_sync_v2_at, last_seen_at
      from public.device_profiles where device_id = $1`, [DEVICE_ID]);
    const writes = () => countRows("select count(*)::integer as count from profile_sync_update_log");
    const initial = await getProfile();
    assert.equal(initial.sync_protocol_version, 1);
    assert.equal(initial.last_sync_v2_at, null);
    await sync([]);
    const first = await getProfile();
    assert.equal(first.sync_protocol_version, 2);
    assert.ok(first.last_sync_v2_at);
    assert.equal(await writes(), 1);
    for (let n = 0; n < 20; n += 1) await sync([]);
    assert.equal(await writes(), 1, "20 rapid RPCs must not rewrite the profile");
    assert.deepEqual(await getProfile(), first);

    await db.query(`update public.device_profiles
      set last_sync_v2_at = clock_timestamp() - interval '61 seconds',
          last_seen_at = clock_timestamp() - interval '61 seconds'
      where device_id = $1`, [DEVICE_ID]);
    await db.exec("truncate profile_sync_update_log");
    await sync([]);
    assert.equal(await writes(), 1, "a sync after 60 seconds must refresh the profile");

    await db.query("update public.device_profiles set sync_protocol_version = 1 where device_id = $1", [DEVICE_ID]);
    await db.exec("truncate profile_sync_update_log");
    await sync([]);
    assert.equal((await getProfile()).sync_protocol_version, 2);
    assert.equal(await writes(), 1, "protocol upgrades must not wait for the throttle");

    await db.query("update public.device_profiles set last_sync_v2_at = null where device_id = $1", [DEVICE_ID]);
    await db.exec("truncate profile_sync_update_log");
    await sync([]);
    assert.ok((await getProfile()).last_sync_v2_at);
    assert.equal(await writes(), 1, "a missing timestamp must be initialized immediately");
    await db.exec("drop trigger test_capture_profile_sync_update on public.device_profiles; drop function pg_temp.capture_profile_sync_update(); drop table profile_sync_update_log;");
  });

  await check("rejects a non-UUID mutation without a receipt", async () => {
    const beforeCursor = cursor;
    const invalid = tripMutation("not-a-uuid", "invalid-uuid-trip");
    const data = await sync([invalid]);
    assert.equal(data.acks[0].status, "rejected");
    assert.equal(data.acks[0].message, "mutationId must be a UUID");
    assert.equal(cursor, beforeCursor);
    assert.equal(
      await countRows(
        "select count(*)::integer as count from public.trip_headers where trip_id = 'invalid-uuid-trip'",
      ),
      0,
    );
  });

  await check("reports missing_parent for an orphan report without storing it", async () => {
    const tripId = "orphan-report-trip";
    const mutationId = nextMutationId();
    const data = await sync([reportMutation(mutationId, tripId)]);
    assert.equal(data.acks[0].status, "conflict");
    assert.equal(data.acks[0].code, "missing_parent");
    assert.equal(await receiptCount(mutationId), 0);
    assert.equal(
      await countRows(
        "select count(*)::integer as count from public.report_snapshots where trip_id = $1",
        [tripId],
      ),
      0,
    );
  });

  const workTripId = "other-work-trip";
  const workEvents = [
    { id: "other-work-start", type: "work_start", ts: "2026-07-10T01:20:00.000Z" },
    { id: "other-work-end", type: "work_end", ts: "2026-07-10T01:45:00.000Z" },
  ];
  await check("upserts and reads back other work start and end events with their notes and timestamps", async () => {
    const beforeCursor = cursor;
    const mutations = workEvents.map((event) => eventMutation(nextMutationId(), event.id, workTripId, 0, {
      type: event.type,
      ts: event.ts,
      address: "Test depot",
      extras: { note: "タイヤ交換" },
    }));
    const data = await sync([tripMutation(nextMutationId(), workTripId), ...mutations]);
    assert.deepEqual(data.acks.map((ack) => ack.status), ["applied", "applied", "applied"]);
    assert.equal(data.changes.events.length, 2);
    for (const [index, event] of workEvents.entries()) {
      event.revision = asNumber(data.acks[index + 1].revision);
      const stored = await firstRow("select * from public.trip_events where id = $1", [event.id]);
      assert.equal(stored.trip_id, workTripId);
      assert.equal(stored.type, event.type);
      assert.equal(new Date(stored.ts).toISOString(), event.ts);
      assert.equal(stored.address, "Test depot");
      assert.deepEqual(decodeJson(stored.extras), { note: "タイヤ交換" });
      assert.equal(stored.sync_status, "synced");
      assert.equal(await receiptCount(mutations[index].mutationId), 1);
      const returned = data.changes.events.find((row) => row.id === event.id);
      assert.ok(returned);
      assert.equal(returned.type, event.type);
      assert.equal(new Date(returned.ts).toISOString(), event.ts);
      assert.deepEqual(returned.extras, { note: "タイヤ交換" });
    }
    const fetched = await sync([], { cursor: beforeCursor, advance: false });
    assert.deepEqual(fetched.changes, data.changes, "work events must be available in later feed reads");
  });

  await check("deletes synced and unsynced other work events and preserves terminal typed tombstones", async () => {
    const targets = workEvents.flatMap((event) => [
      event,
      { ...event, id: `${event.id}-offline`, revision: 0 },
    ]);
    const mutations = targets.map((event) => {
      const mutation = eventDeleteMutation(nextMutationId(), event.id, workTripId, event.revision);
      mutation.payload.event_type = event.type;
      mutation.payload.event_ts = event.ts;
      return mutation;
    });
    const beforeCursor = cursor;
    const data = await sync(mutations);
    assert.deepEqual(data.acks.map((ack) => ack.status), ["deleted", "deleted", "deleted", "deleted"]);
    assert.equal(data.changes.deletedEvents.length, 4);
    assert.equal(await countRows("select count(*)::integer as count from public.trip_events where trip_id = $1", [workTripId]), 0);
    for (const [index, event] of targets.entries()) {
      const stored = await firstRow("select * from public.deleted_event_tombstones where event_id = $1", [event.id]);
      assert.equal(stored.trip_id, workTripId);
      assert.equal(stored.event_type, event.type);
      assert.equal(new Date(stored.event_ts).toISOString(), event.ts);
      assert.equal(stored.owner_user_id, OWNER_ID);
      assert.equal(await receiptCount(mutations[index].mutationId), 1);
      const returned = data.changes.deletedEvents.find((row) => row.event_id === event.id);
      assert.ok(returned);
      assert.equal(returned.event_type, event.type);
      assert.equal(new Date(returned.event_ts).toISOString(), event.ts);
    }
    const fetched = await sync([], { cursor: beforeCursor, advance: false });
    assert.deepEqual(fetched.changes, data.changes);
    const stableCursor = cursor;
    const resurrection = await sync(targets.map((event) => eventMutation(nextMutationId(), event.id, workTripId, 0, {
      type: event.type,
      ts: event.ts,
    })));
    assert.ok(resurrection.acks.every((ack) => ack.status === "deleted" && /permanently deleted/.test(ack.message)));
    assert.equal(cursor, stableCursor);
    assertEmptyChanges(resurrection.changes);
  });

  await check("rejects unknown event types for both upserts and deletion tombstones without receipts or changes", async () => {
    const upsert = eventMutation(nextMutationId(), "unknown-work-upsert", workTripId, 0, { type: "unknown_work_type" });
    const deletion = eventDeleteMutation(nextMutationId(), "unknown-work-delete", workTripId, 0);
    deletion.payload.event_type = "unknown_work_type";
    deletion.payload.event_ts = TS;
    const stableCursor = cursor;
    const data = await sync([upsert, deletion]);
    assert.deepEqual(data.acks.map((ack) => ack.status), ["rejected", "rejected"]);
    assert.ok(data.acks.every((ack) => ack.message === "Unsupported event type"));
    for (const mutation of [upsert, deletion]) assert.equal(await receiptCount(mutation.mutationId), 0);
    assert.equal(await countRows("select count(*)::integer as count from public.trip_events where id = $1", [upsert.entityId]), 0);
    assert.equal(await countRows("select count(*)::integer as count from public.deleted_event_tombstones where event_id = $1", [deletion.entityId]), 0);
    assert.equal(cursor, stableCursor);
    assertEmptyChanges(data.changes);
  });

  let firstReportTombstoneSeq;
  let coreEventRevision;
  await check("upserts trip, event, and report and restores from a report tombstone", async () => {
    const tripId = "core-upsert-trip";
    const trip = tripMutation(nextMutationId(), tripId);
    const report = reportMutation(nextMutationId(), tripId);
    let data = await sync([trip, report]);
    assert.deepEqual(data.acks.map((ack) => ack.status), ["applied", "applied"]);
    assert.equal(data.changes.trips.length, 1);
    assert.equal(data.changes.reports.length, 1);

    const event = eventMutation(nextMutationId(), "core-upsert-event", tripId);
    data = await sync([event]);
    assert.equal(data.acks[0].status, "applied");
    coreEventRevision = asNumber(data.acks[0].revision);
    assert.equal(data.changes.events.length, 1);
    assert.equal(data.changes.deletedReports.length, 1);
    assert.equal(
      await countRows(
        "select count(*)::integer as count from public.report_snapshots where trip_id = $1",
        [tripId],
      ),
      0,
    );

    const tombstone = await firstRow(
      `select change_seq, reason
       from public.deleted_report_tombstones
       where trip_id = $1`,
      [tripId],
    );
    firstReportTombstoneSeq = asNumber(tombstone.change_seq);
    assert.equal(tombstone.reason, "event_changed");

    const restore = reportMutation(nextMutationId(), tripId, 0, {
      restore: true,
      restore_from_change_seq: firstReportTombstoneSeq,
      label: "Restored core report",
    });
    data = await sync([restore]);
    assert.equal(data.acks[0].status, "applied");
    assert.equal(data.changes.reports.length, 1);
    assert.equal(
      await countRows(
        "select count(*)::integer as count from public.deleted_report_tombstones where trip_id = $1",
        [tripId],
      ),
      0,
    );
  });

  await check("rejects an old report restore token and retries the same mutation UUID", async () => {
    const tripId = "core-upsert-trip";
    const updateEvent = eventMutation(
      nextMutationId(),
      "core-upsert-event",
      tripId,
      coreEventRevision,
      { address: "Updated point" },
    );
    let data = await sync([updateEvent]);
    assert.equal(data.acks[0].status, "applied");

    const currentTombstone = await firstRow(
      "select change_seq from public.deleted_report_tombstones where trip_id = $1",
      [tripId],
    );
    const currentToken = asNumber(currentTombstone.change_seq);
    assert.ok(currentToken > firstReportTombstoneSeq);

    const retryId = nextMutationId();
    const staleRestore = reportMutation(retryId, tripId, 0, {
      restore: true,
      restore_from_change_seq: firstReportTombstoneSeq,
      label: "Stale restore",
    });
    data = await sync([staleRestore]);
    assert.equal(data.acks[0].status, "conflict");
    assert.equal(data.acks[0].code, "report_tombstone_conflict");
    assert.equal(await receiptCount(retryId), 0);

    const validRestore = reportMutation(retryId, tripId, 0, {
      restore: true,
      restore_from_change_seq: currentToken,
      label: "Fresh restore",
    });
    data = await sync([validRestore]);
    assert.equal(data.acks[0].status, "applied");
    assert.equal(await receiptCount(retryId), 1);

    const stableCursor = cursor;
    data = await sync([validRestore]);
    assert.equal(data.acks[0].status, "duplicate");
    assert.equal(cursor, stableCursor);
    assertEmptyChanges(data.changes);
  });

  await check("enforces trip CAS, allows conflict resend, and deduplicates its receipt", async () => {
    const tripId = "trip-cas";
    let data = await sync([tripMutation(nextMutationId(), tripId)]);
    assert.equal(data.acks[0].revision, 1);

    const retryId = nextMutationId();
    const staleUpdate = tripMutation(retryId, tripId, 0, { total_km: 30 });
    data = await sync([staleUpdate]);
    assert.equal(data.acks[0].status, "conflict");
    assert.equal(data.acks[0].code, "revision_conflict");
    assert.equal(await receiptCount(retryId), 0);

    const validUpdate = tripMutation(retryId, tripId, 1, { total_km: 30 });
    data = await sync([validUpdate]);
    assert.equal(data.acks[0].status, "applied");
    assert.equal(data.acks[0].revision, 2);
    assert.equal(await receiptCount(retryId), 1);

    const stableCursor = cursor;
    data = await sync([validUpdate]);
    assert.equal(data.acks[0].status, "duplicate");
    assert.equal(data.acks[0].revision, 2);
    assert.equal(cursor, stableCursor);
    assertEmptyChanges(data.changes);
    assert.equal(await receiptCount(retryId), 1);
  });

  await check("enforces event CAS and accepts a same-UUID resend after conflict", async () => {
    const tripId = "event-cas-trip";
    const eventId = "event-cas-event";
    await sync([tripMutation(nextMutationId(), tripId)]);
    let data = await sync([eventMutation(nextMutationId(), eventId, tripId)]);
    assert.equal(data.acks[0].revision, 1);

    const retryId = nextMutationId();
    data = await sync([
      eventMutation(retryId, eventId, tripId, 0, { address: "Stale event update" }),
    ]);
    assert.equal(data.acks[0].status, "conflict");
    assert.equal(data.acks[0].code, "revision_conflict");
    assert.equal(await receiptCount(retryId), 0);

    const validUpdate = eventMutation(retryId, eventId, tripId, 1, {
      address: "Accepted event update",
    });
    data = await sync([validUpdate]);
    assert.equal(data.acks[0].status, "applied");
    assert.equal(data.acks[0].revision, 2);
    assert.equal(await receiptCount(retryId), 1);

    data = await sync([validUpdate]);
    assert.equal(data.acks[0].status, "duplicate");
  });

  await check("enforces reportDelete CAS and accepts a same-UUID resend", async () => {
    const tripId = "report-delete-cas-trip";
    await sync([
      tripMutation(nextMutationId(), tripId),
      reportMutation(nextMutationId(), tripId),
    ]);

    const retryId = nextMutationId();
    let data = await sync([reportDeleteMutation(retryId, tripId, 0)]);
    assert.equal(data.acks[0].status, "conflict");
    assert.equal(data.acks[0].code, "revision_conflict");
    assert.equal(await receiptCount(retryId), 0);

    const validDelete = reportDeleteMutation(retryId, tripId, 1);
    data = await sync([validDelete]);
    assert.equal(data.acks[0].status, "deleted");
    assert.equal(await receiptCount(retryId), 1);
    assert.equal(
      await countRows(
        "select count(*)::integer as count from public.report_snapshots where trip_id = $1",
        [tripId],
      ),
      0,
    );

    data = await sync([validDelete]);
    assert.equal(data.acks[0].status, "duplicate");
    const tombstone = await firstRow(
      "select reason from public.deleted_report_tombstones where trip_id = $1",
      [tripId],
    );
    assert.equal(tombstone.reason, "user_deleted");
  });

  await check("keeps v1 report regeneration compatible without reviving user-deleted reports", async () => {
    const v1Device = "legacy-v1-report-device";
    const v1Trip = "legacy-v1-report-trip";
    await insertApprovedDevice(v1Device, "Legacy v1 report device");
    await db.query(
      `insert into public.trip_headers (
         trip_id, device_id, start_ts, end_ts, odo_start, odo_end,
         total_km, last_leg_km, status
       ) values ($1, $2, $3::timestamptz, $4::timestamptz, 100, 110, 10, 10, 'closed')`,
      [v1Trip, v1Device, TS, "2026-07-10T02:00:00.000Z"],
    );
    await db.query(
      `insert into public.trip_events (
         id, trip_id, device_id, type, ts, address, geo, extras, sync_status
       ) values ($1, $2, $3, 'point_mark', $4::timestamptz, 'Legacy event', null, null, 'synced')`,
      ["legacy-v1-report-event", v1Trip, v1Device, TS],
    );
    await db.query(
      `insert into public.report_snapshots (
         trip_id, device_id, created_at, label, payload_json
       ) values ($1, $2, $3::timestamptz, 'Legacy regenerated report', $4::jsonb)`,
      [v1Trip, v1Device, TS, JSON.stringify({ tripId: v1Trip, legacy: true })],
    );
    assert.equal(
      await countRows(
        "select count(*)::integer as count from public.report_snapshots where trip_id = $1",
        [v1Trip],
      ),
      1,
    );

    await db.query(
      `select tracklog_private.invalidate_tracklog_report(
         $1::uuid, $2::text, $3::text, 'user_deleted', now()
       )`,
      [OWNER_ID, v1Trip, v1Device],
    );
    await expectSqlState(
      () =>
        db.query(
          `insert into public.report_snapshots (
             trip_id, device_id, created_at, label, payload_json
           ) values ($1, $2, $3::timestamptz, 'Must remain deleted', $4::jsonb)`,
          [v1Trip, v1Device, TS, JSON.stringify({ tripId: v1Trip })],
        ),
      "40001",
      /latest tombstone token/,
    );

    const v2Device = "v2-token-required-device";
    const v2Trip = "v2-token-required-trip";
    await insertApprovedDevice(v2Device, "V2 token device");
    await db.query(
      "update public.device_profiles set sync_protocol_version = 2 where device_id = $1",
      [v2Device],
    );
    await db.query(
      `insert into public.trip_headers (
         trip_id, device_id, start_ts, end_ts, odo_start, odo_end,
         total_km, last_leg_km, status
       ) values ($1, $2, $3::timestamptz, $4::timestamptz, 200, 210, 10, 10, 'closed')`,
      [v2Trip, v2Device, TS, "2026-07-10T02:00:00.000Z"],
    );
    await db.query(
      `insert into public.trip_events (
         id, trip_id, device_id, type, ts, address, geo, extras, sync_status
       ) values ($1, $2, $3, 'point_mark', $4::timestamptz, 'V2 event', null, null, 'synced')`,
      ["v2-token-required-event", v2Trip, v2Device, TS],
    );
    await expectSqlState(
      () =>
        db.query(
          `insert into public.report_snapshots (
             trip_id, device_id, created_at, label, payload_json
           ) values ($1, $2, $3::timestamptz, 'V2 tokenless report', $4::jsonb)`,
          [v2Trip, v2Device, TS, JSON.stringify({ tripId: v2Trip })],
        ),
      "40001",
      /latest tombstone token/,
    );
  });

  await check("blocks v1 reinsertion after terminal trip and event tombstones", async () => {
    const tripId = "terminal-trip";
    await sync([tripMutation(nextMutationId(), tripId)]);
    let data = await sync([tripDeleteMutation(nextMutationId(), tripId, 1)]);
    assert.equal(data.acks[0].status, "deleted");
    await expectSqlState(
      () =>
        db.query(
          `insert into public.trip_headers (
             trip_id, device_id, start_ts, end_ts, odo_start, odo_end,
             total_km, last_leg_km, status
           ) values ($1, $2, $3::timestamptz, $4::timestamptz, 1, 2, 1, 1, 'closed')`,
          [tripId, DEVICE_ID, TS, "2026-07-10T02:00:00.000Z"],
        ),
      "40001",
      /trip was permanently deleted/,
    );

    const parentTripId = "terminal-event-parent";
    const eventId = "terminal-event";
    await sync([tripMutation(nextMutationId(), parentTripId)]);
    await sync([eventMutation(nextMutationId(), eventId, parentTripId)]);
    data = await sync([eventDeleteMutation(nextMutationId(), eventId, parentTripId, 1)]);
    assert.equal(data.acks[0].status, "deleted");
    await expectSqlState(
      () =>
        db.query(
          `insert into public.trip_events (
             id, trip_id, device_id, type, ts, address, geo, extras, sync_status
           ) values ($1, $2, $3, 'point_mark', $4::timestamptz, null, null, null, 'synced')`,
          [eventId, parentTripId, DEVICE_ID, TS],
        ),
      "40001",
      /event or parent trip was permanently deleted/,
    );
  });

  await check("deletes an owner trip through the administrator RPC", async () => {
    const tripId = "admin-delete-trip";
    await sync([tripMutation(nextMutationId(), tripId)]);
    const row = await firstRow(
      "select public.tracklog_admin_delete_trip_v2($1::uuid, $2::text) as deleted_count",
      [ADMIN_ID, tripId],
    );
    assert.equal(asNumber(row.deleted_count), 1);
    assert.equal(
      await countRows(
        "select count(*)::integer as count from public.trip_headers where trip_id = $1",
        [tripId],
      ),
      0,
    );
    const tombstone = await firstRow(
      `select owner_user_id, deleted_by
       from public.deleted_trip_tombstones
       where trip_id = $1`,
      [tripId],
    );
    assert.equal(tombstone.owner_user_id, OWNER_ID);
    assert.equal(tombstone.deleted_by, ADMIN_ID);
  });

  await check("migrates live, tombstone, sync receipt, push, and message references", async () => {
    const oldDevice = "migration-old-device";
    const newDevice = "migration-new-device";
    const liveTripId = "migration-live-trip";
    const liveEventId = "migration-live-event";
    const livePointId = "migration-live-point";
    await insertApprovedDevice(oldDevice, "Old migration device");
    await insertApprovedDevice(newDevice, "New migration device");

    let data = await sync(
      [
        tripMutation(nextMutationId(), liveTripId),
        eventMutation(nextMutationId(), liveEventId, liveTripId),
        routeMutation(nextMutationId(), livePointId, liveTripId),
      ],
      { deviceId: oldDevice },
    );
    assert.deepEqual(data.acks.map((ack) => ack.status), ["applied", "applied", "applied"]);
    const liveReportTombstone = await firstRow(
      "select change_seq from public.deleted_report_tombstones where trip_id = $1",
      [liveTripId],
    );
    data = await sync(
      [
        reportMutation(nextMutationId(), liveTripId, 0, {
          restore: true,
          restore_from_change_seq: asNumber(liveReportTombstone.change_seq),
        }),
      ],
      { deviceId: oldDevice },
    );
    assert.equal(data.acks[0].status, "applied");

    await db.query(
      `insert into public.deleted_trip_tombstones (
         trip_id, device_id, owner_user_id, deleted_by, deleted_at
       ) values ($1, $2, $3::uuid, $3::uuid, $4::timestamptz)`,
      ["migration-deleted-trip", oldDevice, OWNER_ID, TS],
    );
    await db.query(
      `insert into public.deleted_event_tombstones (
         event_id, trip_id, device_id, owner_user_id, event_type,
         event_ts, deleted_by, deleted_at
       ) values ($1, $2, $3, $4::uuid, 'point_mark', $5::timestamptz, $4::uuid, $5::timestamptz)`,
      ["migration-deleted-event", "migration-deleted-parent", oldDevice, OWNER_ID, TS],
    );

    const messageOne = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const messageTwo = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
    await db.query(
      `insert into public.tracklog_admin_messages (id, target_device_id, body, sent_by)
       values
         ($1::uuid, $3, 'First migration message', $4::uuid),
         ($2::uuid, $3, 'Second migration message', $4::uuid)`,
      [messageOne, messageTwo, oldDevice, ADMIN_ID],
    );
    await db.query(
      `insert into public.tracklog_admin_message_receipts (message_id, device_id)
       values
         ($1::uuid, $3),
         ($1::uuid, $4),
         ($2::uuid, $3)`,
      [messageOne, messageTwo, oldDevice, newDevice],
    );
    await db.query(
      `insert into public.tracklog_push_registrations (
         id, device_id, auth_user_id, platform, token, token_hash
       ) values ($1::uuid, $2, $3::uuid, 'android', 'test-token', 'test-token-hash')`,
      ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", oldDevice, OWNER_ID],
    );

    const oldReceiptCount = await countRows(
      `select count(*)::integer as count
       from public.tracklog_sync_mutations
       where device_id = $1`,
      [oldDevice],
    );
    assert.ok(oldReceiptCount >= 4);

    await db.query(
      "select public.tracklog_migrate_device_v2($1::uuid, $2::text, $3::text)",
      [OWNER_ID, oldDevice, newDevice],
    );

    assert.equal(
      await countRows(
        "select count(*)::integer as count from public.device_profiles where device_id = $1",
        [oldDevice],
      ),
      0,
    );
    for (const [table, key, value] of [
      ["trip_headers", "trip_id", liveTripId],
      ["trip_events", "id", liveEventId],
      ["trip_route_points", "id", livePointId],
      ["report_snapshots", "trip_id", liveTripId],
      ["deleted_trip_tombstones", "trip_id", "migration-deleted-trip"],
      ["deleted_event_tombstones", "event_id", "migration-deleted-event"],
      ["deleted_report_tombstones", "trip_id", "migration-deleted-parent"],
    ]) {
      const row = await firstRow(
        `select device_id from public.${table} where ${key} = $1`,
        [value],
      );
      assert.equal(row.device_id, newDevice, `${table}.${key} did not migrate`);
    }

    assert.equal(
      await countRows(
        "select count(*)::integer as count from public.tracklog_sync_mutations where device_id = $1",
        [newDevice],
      ),
      oldReceiptCount,
    );
    assert.equal(
      await countRows(
        "select count(*)::integer as count from public.tracklog_sync_mutations where device_id = $1",
        [oldDevice],
      ),
      0,
    );
    assert.equal(
      await countRows(
        "select count(*)::integer as count from public.tracklog_admin_messages where target_device_id = $1",
        [newDevice],
      ),
      2,
    );
    assert.equal(
      await countRows(
        "select count(*)::integer as count from public.tracklog_admin_message_receipts where device_id = $1",
        [newDevice],
      ),
      2,
    );
    assert.equal(
      await countRows(
        "select count(*)::integer as count from public.tracklog_push_registrations where device_id = $1 and auth_user_id = $2::uuid",
        [newDevice, OWNER_ID],
      ),
      1,
    );

    const preFeedCursor = cursor;
    data = await sync([], { deviceId: newDevice });
    assert.ok(cursor > preFeedCursor);
    assert.ok(data.changes.trips.some((trip) => trip.trip_id === liveTripId));
    const stableCursor = cursor;
    data = await sync([], { deviceId: newDevice });
    assert.equal(cursor, stableCursor);
    assertEmptyChanges(data.changes);
  });

  await check("keeps the active-trip owner constraint across devices", async () => {
    const secondDevice = "active-trip-second-device";
    await insertApprovedDevice(secondDevice, "Second active trip device");
    const firstActive = tripMutation(nextMutationId(), "active-owner-first", 0, {
      end_ts: null, odo_end: null, total_km: null, last_leg_km: null, status: "active",
    });
    let data = await sync([firstActive]);
    assert.equal(data.acks[0].status, "applied");
    data = await sync([tripMutation(nextMutationId(), "active-owner-second", 0, {
      end_ts: null, odo_end: null, total_km: null, last_leg_km: null, status: "active",
    })], { deviceId: secondDevice });
    assert.equal(data.acks[0].status, "conflict");
    assert.equal(data.acks[0].code, "active_trip_conflict");
    data = await sync([tripMutation(nextMutationId(), "active-owner-first", 1)]);
    assert.equal(data.acks[0].status, "applied");
  });

  await check("matches the original feed across all seven buckets and multiple 1500-row pages", async () => {
    const rowsPerBucket = 1602;
    const fixtureCursor = cursor;
    // Synthetic rows stay in the in-memory database. Use normal triggers so
    // owner serialization, report invalidation and tombstones remain active.
    await db.query(`insert into public.trip_headers (
        trip_id, device_id, start_ts, end_ts, odo_start, odo_end, total_km, last_leg_km, status
      ) select 'feed-trip-' || n, $1, $2::timestamptz, $2::timestamptz + interval '1 hour',
        100, 110, 10, 10, 'closed' from generate_series(0, $3::integer) n`,
    [DEVICE_ID, TS, rowsPerBucket]);
    await db.query(`insert into public.trip_events (id, trip_id, device_id, type, ts, sync_status)
      select 'feed-event-' || n, 'feed-trip-0', $1, 'point_mark', $2::timestamptz, 'synced'
      from generate_series(1, $3::integer) n`, [DEVICE_ID, TS, rowsPerBucket]);
    await db.query(`insert into public.trip_route_points (id, trip_id, device_id, ts, lat, lng, accuracy, source)
      select 'feed-point-' || n, 'feed-trip-0', $1, $2::timestamptz + n * interval '15 seconds',
        35.0, 139.0, 5, 'synthetic-test' from generate_series(1, $3::integer) n`,
    [DEVICE_ID, TS, rowsPerBucket + 201]);
    await db.query(`insert into public.report_snapshots (trip_id, device_id, created_at, label, payload_json)
      select 'feed-trip-' || n, $1, $2::timestamptz, 'Synthetic report', jsonb_build_object('fixture', n)
      from generate_series(1, $3::integer) n`, [DEVICE_ID, TS, rowsPerBucket]);
    await db.query(`insert into public.deleted_trip_tombstones (trip_id, device_id, owner_user_id, deleted_by, deleted_at)
      select 'feed-deleted-trip-' || n, $1, $2::uuid, $2::uuid, $3::timestamptz
      from generate_series(1, $4::integer) n`, [DEVICE_ID, OWNER_ID, TS, rowsPerBucket]);
    await db.query(`insert into public.deleted_event_tombstones (
        event_id, trip_id, device_id, owner_user_id, event_type, event_ts, deleted_by, deleted_at
      ) select 'feed-deleted-event-' || n, 'feed-deleted-event-parent', $1, $2::uuid,
        'point_mark', $3::timestamptz, $2::uuid, $3::timestamptz
      from generate_series(1, $4::integer) n`, [DEVICE_ID, OWNER_ID, TS, rowsPerBucket]);
    await db.query(`insert into public.deleted_report_tombstones (trip_id, device_id, owner_user_id, reason, deleted_at)
      select 'feed-deleted-report-' || n, $1, $2::uuid, 'user_deleted', $3::timestamptz
      from generate_series(1, $4::integer) n`, [DEVICE_ID, OWNER_ID, TS, rowsPerBucket]);

    const bucketTables = {
      trips: "trip_headers", events: "trip_events", routePoints: "trip_route_points", reports: "report_snapshots",
      deletedTrips: "deleted_trip_tombstones", deletedEvents: "deleted_event_tombstones", deletedReports: "deleted_report_tombstones",
    };
    const expected = {};
    for (const [bucket, table] of Object.entries(bucketTables)) {
      const result = await db.query(`select change_seq from public.${table}
        where owner_user_id = $1::uuid and change_seq > $2 order by change_seq`, [OWNER_ID, fixtureCursor]);
      expected[bucket] = result.rows.map((row) => asNumber(row.change_seq));
      assert.ok(expected[bucket].length > 1501, `${bucket} must exercise its branch limit`);
    }
    const seen = Object.fromEntries(Object.keys(bucketTables).map((bucket) => [bucket, []]));
    let fromCursor = fixtureCursor;
    let pages = 0;
    let hasMore;
    do {
      await db.exec(originalSyncFunctionSql);
      const original = await sync([], { cursor: fromCursor, advance: false });
      await db.exec(optimizedSyncSql);
      const optimized = await sync([], { cursor: fromCursor, advance: false });
      assert.deepEqual(optimized, original, `optimized page ${pages} must match the original function`);
      const pageRows = Object.values(optimized.changes).flat();
      assert.ok(pageRows.length <= 1500);
      if (optimized.hasMore) assert.equal(pageRows.length, 1500);
      for (const [bucket, rows] of Object.entries(optimized.changes)) {
        for (const row of rows) {
          assert.ok(asNumber(row.change_seq) > fromCursor);
          assert.ok(asNumber(row.change_seq) <= asNumber(optimized.cursor));
          seen[bucket].push(asNumber(row.change_seq));
        }
      }
      fromCursor = asNumber(optimized.cursor);
      hasMore = optimized.hasMore;
      pages += 1;
      assert.ok(pages < 15, "feed must terminate");
    } while (hasMore);
    assert.ok(pages > 7);
    assert.deepEqual(seen, expected, "all rows must arrive once without gaps, including tombstones");
    const allSequences = Object.values(seen).flat();
    assert.equal(new Set(allSequences).size, allSequences.length, "owner sequence numbers must be unique across buckets");
    const idle = await sync([], { cursor: fromCursor, advance: false });
    assert.equal(asNumber(idle.cursor), fromCursor);
    assert.equal(idle.hasMore, false);
    assertEmptyChanges(idle.changes);
    cursor = fromCursor;
    console.log(`[feed-fixture] ${allSequences.length} changes, ${pages} pages, all seven buckets identical`);
  });

  await check("receives later same-owner writes on a second device and still deduplicates a 420-mutation batch", async () => {
    const secondDevice = "late-feed-second-device";
    await insertApprovedDevice(secondDevice, "Late feed second device");
    const beforeLate = cursor;
    const mutations = Array.from({ length: 420 }, (_, n) => routeMutation(nextMutationId(), `late-feed-point-${n}`, "feed-trip-0"));
    // A device may modify this owner's existing trip; attribution remains the
    // trip's device under the unchanged ownership rules.
    const written = await sync(mutations, { deviceId: secondDevice });
    assert.equal(written.acks.length, 420);
    assert.ok(written.acks.every((ack) => ack.status === "applied"));
    assert.equal(written.changes.routePoints.length, 420);
    assert.ok(cursor > beforeLate);
    const fetched = await sync([], { cursor: beforeLate, advance: false });
    assert.equal(fetched.changes.routePoints.length, 420);
    assert.deepEqual(fetched.changes, written.changes);
    const stableCursor = cursor;
    const duplicate = await sync(mutations, { deviceId: secondDevice });
    assert.ok(duplicate.acks.every((ack) => ack.status === "duplicate"));
    assert.equal(cursor, stableCursor);
    assertEmptyChanges(duplicate.changes);
    for (const mutation of [mutations[0], mutations[419]]) assert.equal(await receiptCount(mutation.mutationId), 1);
  });

  await check("manual rollback restores the original RPC and can be re-applied without data changes", async () => {
    const stableCursor = cursor;
    const before = await firstRow("select count(*)::integer as count from public.tracklog_sync_mutations");
    const workAllowlistBefore = await mutationFunctionMetadata();
    await db.exec(await readFile(ROLLBACK_PATH, "utf8"));
    assert.deepEqual(await mutationFunctionMetadata(), workAllowlistBefore, "disk IO rollback must preserve other work allowlists");
    const rolledBack = await sync([]);
    assert.equal(cursor, stableCursor);
    assertEmptyChanges(rolledBack.changes);
    await db.exec(optimizedSyncSql);
    await db.exec(otherWorkMigrationSql);
    assert.deepEqual(await mutationFunctionMetadata(), workAllowlistBefore);
    assert.deepEqual(await firstRow("select count(*)::integer as count from public.tracklog_sync_mutations"), before);
    const restored = await sync([]);
    assert.deepEqual(restored, rolledBack);
  });

  console.log(`TrackLog sync v2 integration checks passed: ${passed}`);
} finally {
  await db.close();
}
