import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// Synthetic, in-memory PostgreSQL only: no credentials or network.
const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const source = read('supabase/migrations/20260329_tracklog_remote.sql');
assert.doesNotMatch(source, /insert\s+into\s+public\.admin_users/i);
// PGlite lacks pgcrypto; this migration otherwise runs verbatim.
const sql = source.replace('create extension if not exists pgcrypto;', '');
const bootstrap = read('docs/REMOTE_SETUP.md').match(/```sql\n([\s\S]*?)```/)[1];
// The current RLS helper moved to a private schema in a later migration.
// Exercise its actual definition as well, without pretending to replay all migrations.
const privateHelper = read('supabase/migrations/20260708094500_tracklog_edge_function_privileged_lockdown.sql')
  .match(/create or replace function tracklog_private\.is_tracklog_admin\(\)[\s\S]*?\$\$;/)[0];
const db = new PGlite();
try {
  await db.exec(`create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
    $$;`);
  await db.exec(sql);
  await db.exec(`create schema tracklog_private; ${privateHelper}`);
  const rows = async () => (await db.query('select * from public.admin_users order by email')).rows;
  const admin = async email => {
    await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({email})]);
    const result = (await db.query(`select public.is_tracklog_admin() as allowed,
      tracklog_private.is_tracklog_admin() as current_allowed`)).rows[0];
    assert.equal(result.current_allowed, result.allowed);
    return result.allowed;
  };
  assert.deepEqual(await rows(), []);
  assert.equal(await admin('admin@example.test'), false);
  for (const email of ['admin@example.invalid', '', 'invalid', '  ']) {
    await assert.rejects(db.exec(bootstrap.replace('admin@example.invalid', email)), /Set the intended/);
    assert.deepEqual(await rows(), []);
  }
  await db.exec(bootstrap.replace('admin@example.invalid', '  Admin@Example.test  '));
  assert.equal((await rows())[0].email, 'admin@example.test');
  assert.equal(await admin('ADMIN@EXAMPLE.TEST'), true);
  assert.equal(await admin('other@example.test'), false);
  assert.equal(await admin(''), false);
  assert.equal(await admin(undefined), false);
  const before = await rows();
  await assert.rejects(db.exec(bootstrap.replace('admin@example.invalid', 'other@example.test')), /Existing environment/);
  assert.deepEqual(await rows(), before);
  await db.exec(`insert into auth.users (id) values ('00000000-0000-4000-8000-000000000001');
    insert into public.trip_headers (trip_id, device_id, start_ts, odo_start, status)
    values ('synthetic-trip', '00000000-0000-4000-8000-000000000001', '2026-01-01T00:00:00Z', 100, 'active');
    insert into public.trip_events (id, trip_id, device_id, type, ts, extras)
    values ('synthetic-event', 'synthetic-trip', '00000000-0000-4000-8000-000000000001', 'start', '2026-01-01T00:00:00Z', '{"fixture":true}');`);
  const tripData = async () => ({
    trips: (await db.query('select * from public.trip_headers order by trip_id')).rows,
    events: (await db.query('select * from public.trip_events order by id')).rows,
  });
  const dataBefore = await tripData();
  // Replaying only the historical SQL in a disposable test preserves existing rows.
  // This is not a recommendation to replay it in production.
  await db.exec(sql);
  assert.deepEqual(await rows(), before);
  assert.deepEqual(await tripData(), dataBefore);
  assert.equal(await admin('admin@example.test'), true);
  await db.exec("update public.admin_users set enabled = false");
  const disabled = await rows();
  await assert.rejects(db.exec(bootstrap.replace('admin@example.invalid', 'admin@example.test')), /Existing environment/);
  await db.exec(sql);
  assert.deepEqual(await rows(), disabled);
  assert.deepEqual(await tripData(), dataBefore);
  assert.equal(await admin('admin@example.test'), false);
  console.log('PASS: empty bootstrap denial, invalid examples, explicit registration, case-insensitive admin, other/absent denial, existing/disabled admin and trip/event preservation');
} finally {
  await db.close();
}
