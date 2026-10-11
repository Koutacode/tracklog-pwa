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
  const rows = async () => (await db.query('select * from public.admin_users order by email')).rows;
  const admin = async email => {
    await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({email})]);
    return (await db.query('select public.is_tracklog_admin() as allowed')).rows[0].allowed;
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
  const before = await rows();
  await assert.rejects(db.exec(bootstrap.replace('admin@example.invalid', 'other@example.test')), /Existing environment/);
  assert.deepEqual(await rows(), before);
  // Replaying only the historical SQL in a disposable test preserves existing rows.
  // This is not a recommendation to replay it in production.
  await db.exec(sql);
  assert.deepEqual(await rows(), before);
  assert.equal(await admin('admin@example.test'), true);
  await db.exec("update public.admin_users set enabled = false");
  const disabled = await rows();
  await assert.rejects(db.exec(bootstrap.replace('admin@example.invalid', 'admin@example.test')), /Existing environment/);
  await db.exec(sql);
  assert.deepEqual(await rows(), disabled);
  assert.equal(await admin('admin@example.test'), false);
  console.log('PASS: empty bootstrap denial, invalid examples, explicit registration, case-insensitive admin, other/absent denial, existing/disabled row preservation');
} finally {
  await db.close();
}
