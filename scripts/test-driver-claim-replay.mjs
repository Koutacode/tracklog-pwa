import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import * as ts from 'typescript';

const OWNER = { id: '11111111-1111-4111-8111-111111111111', email: 'driver@example.test' };
const OTHER = { id: '33333333-3333-4333-8333-333333333333', email: 'other@example.test' };
const ADMIN = { id: '22222222-2222-4222-8222-222222222222', email: 'admin@example.test' };

// Extract the actual declarations and their local dependencies. Imports, Deno
// startup, real clients and unrelated handlers never execute in this harness.
function extractExports(source, names, injected = {}) {
  const file = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
  const declarations = new Map();
  for (const statement of file.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      declarations.set(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, statement);
      }
    }
  }
  const selected = new Set();
  function include(name) {
    if (Object.hasOwn(injected, name)) return;
    const declaration = declarations.get(name);
    if (!declaration || selected.has(declaration)) return;
    selected.add(declaration);
    const visit = node => {
      if (ts.isIdentifier(node)) include(node.text);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(declaration, visit);
  }
  for (const name of names) {
    assert.ok(declarations.has(name), `Missing source declaration: ${name}`);
    include(name);
  }
  const text = file.statements.filter(statement => selected.has(statement))
    .map(statement => statement.getText(file)).join('\n');
  const javascript = ts.transpileModule(`${text}\nglobalThis.exports = { ${names.join(', ')} };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const context = vm.createContext({
    ...injected,
    fetch: () => { throw new Error('Network is forbidden in claim replay tests'); },
  });
  vm.runInContext(javascript, context);
  return context.exports;
}

function sqlIdentifier(value) {
  assert.match(value, /^[a-z_][a-z0-9_]*$/i, 'Only simple fixture SQL identifiers are supported');
  return `"${value}"`;
}

// A small PostgREST-shaped adapter executes relational operations in PGlite.
// row_to_json preserves timestamp microseconds, as real PostgREST does. JS Date
// conversion would truncate updated_at and invalidate compare-and-swap tests.
function createAdapter(db, afterRead) {
  return {
    from(table) {
      assert.equal(table, 'device_profiles', 'Claim handlers may only access device_profiles');
      let operation = 'select', row, options = {}, cardinality = 'many', execution;
      const filters = [];
      const builder = {
        select(columns = '*') { assert.equal(columns, '*'); return builder; },
        insert(value) { operation = 'insert'; row = value; return builder; },
        upsert(value, nextOptions = {}) { operation = 'upsert'; row = value; options = nextOptions; return builder; },
        update(value) { operation = 'update'; row = value; return builder; },
        eq(key, value) { filters.push({ key, value, operator: '=' }); return builder; },
        is(key, value) { assert.equal(value, null); filters.push({ key, value, operator: 'is null' }); return builder; },
        single() { cardinality = 'one'; return builder; },
        maybeSingle() { cardinality = 'optional'; return builder; },
        then(resolve, reject) { execution ??= execute(); return execution.then(resolve, reject); },
      };
      async function execute() {
        const params = [];
        const parameter = value => { params.push(value); return `$${params.length}`; };
        const where = () => filters.length ? ` where ${filters.map(({ key, value, operator }) =>
          `${sqlIdentifier(key)} ${operator === 'is null' ? operator : `= ${parameter(value)}`}`,
        ).join(' and ')}` : '';
        let query;
        if (operation === 'select') {
          query = `select row_to_json(profile) as row from public.device_profiles profile${where()}`;
        } else if (operation === 'update') {
          const sets = Object.entries(row).map(([key, value]) => `${sqlIdentifier(key)} = ${parameter(value)}`);
          query = `with changed as (update public.device_profiles set ${sets.join(', ')}${where()} returning *) select row_to_json(changed) as row from changed`;
        } else {
          const entries = Object.entries(row);
          const columns = entries.map(([key]) => sqlIdentifier(key));
          const values = entries.map(([, value]) => parameter(value));
          let conflict = '';
          if (operation === 'upsert') {
            const conflictColumns = (options.onConflict ?? 'device_id').split(',').map(sqlIdentifier);
            conflict = ` on conflict (${conflictColumns.join(', ')}) do `;
            conflict += options.ignoreDuplicates ? 'nothing' : `update set ${columns.map(column => `${column} = excluded.${column}`).join(', ')}`;
          }
          query = `with changed as (insert into public.device_profiles (${columns.join(', ')}) values (${values.join(', ')})${conflict} returning *) select row_to_json(changed) as row from changed`;
        }
        let rows;
        try {
          rows = (await db.query(query, params)).rows.map(result => result.row);
        } catch (error) {
          return { data: null, error: { code: error.code, message: error.message } };
        }
        if (operation === 'select') await afterRead({ filters, rows });
        if (cardinality === 'one' && rows.length !== 1 || cardinality === 'optional' && rows.length > 1) {
          return { data: null, error: { code: 'PGRST116', message: `Expected single row, received ${rows.length}` } };
        }
        return { data: cardinality === 'many' ? rows : rows[0] ?? null, error: null };
      }
      return builder;
    },
  };
}

/** Local synthetic server, also used by the Google registration fixture.
 * claim(payload, user, admin=false), getProfile(deviceId), profiles(),
 * changeApproval(deviceId, status, adminUser=ADMIN), pauseNextRead(), close().
 * profiles can be passed back to a new server to restore accepted server state.
 */
export async function createClaimTestServer({ root = process.cwd(), profiles = [], sourceOverride, clock } = {}) {
  const read = relative => readFile(path.join(root, relative), 'utf8');
  const [source, syncTestSource, syncMigration, baseMigration, lockdownMigration, stableMigration] = await Promise.all([
    sourceOverride ?? read('supabase/functions/tracklog-privileged/index.ts'),
    read('scripts/test-tracklog-sync-v2.mjs'),
    read('supabase/migrations/20260710043340_tracklog_sync_v2.sql'),
    read('supabase/migrations/20260329_tracklog_remote.sql'),
    read('supabase/migrations/20260702133621_tracklog_security_lockdown.sql'),
    read('supabase/migrations/20260330_tracklog_stable_device_profiles.sql'),
  ]);
  const { BASELINE_SQL } = extractExports(syncTestSource, ['BASELINE_SQL']);
  const db = new PGlite();
  try {
    await db.exec(`begin;\n${BASELINE_SQL}\ncommit;`);
    // Correct the older sync fixture's NOT NULL / CASCADE owner approximation
    // to the repository's nullable / SET NULL device owner definition.
    const ownerConstraint = stableMigration.match(/alter table public\.device_profiles\s+add constraint device_profiles_auth_user_id_fkey[\s\S]*?;/)?.[0];
    const updatedAtFunction = lockdownMigration.match(/create or replace function public\.set_updated_at\(\)[\s\S]*?\$\$;/)?.[0];
    const updatedAtTrigger = baseMigration.match(/create trigger trg_device_profiles_updated_at[\s\S]*?;/)?.[0];
    assert.ok(ownerConstraint && updatedAtFunction && updatedAtTrigger, 'Actual profile schema definitions must be present');
    await db.exec(`alter table public.device_profiles alter column auth_user_id drop not null;
      alter table public.device_profiles drop constraint device_profiles_auth_user_id_fkey;
      ${ownerConstraint}\n${updatedAtFunction}\n${updatedAtTrigger}`);
    await db.exec(`begin;\n${syncMigration}\ncommit;`);
    await db.exec('delete from public.device_profiles;');

    await db.exec(`create table claim_test_updates (id integer);
      create function count_claim_test_update() returns trigger language plpgsql as $$
      begin insert into claim_test_updates values (1); return new; end $$;
      create trigger count_claim_test_update after update on device_profiles
      for each row execute function count_claim_test_update();`);
    let nextPause = null;
    const adminClient = createAdapter(db, async () => {
      if (!nextPause) return;
      const pause = nextPause;
      nextPause = null;
      pause.reached();
      await pause.released;
    });
    const handlers = extractExports(source, ['claimDeviceProfile', 'setDeviceApproval'], { adminClient, ...(clock ? { Date: class extends Date { static now() { return clock.now; } } } : {}) });
    async function ensureUser(user) {
      if (user?.id) await db.query('insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing', [user.id, `${user.id}@example.test`]);
    }
    for (const profile of profiles) {
      await ensureUser({ id: profile.auth_user_id });
      await ensureUser({ id: profile.approval_decided_by });
      const result = await adminClient.from('device_profiles').insert(profile);
      assert.equal(result.error, null);
    }
    return {
      async claim(payload, user, admin = false) {
        await ensureUser(user);
        return handlers.claimDeviceProfile(payload, user, admin);
      },
      async updateCount() {
        return (await db.query('select count(*)::integer as count from claim_test_updates')).rows[0].count;
      },
      async getProfile(deviceId) {
        const result = await db.query('select row_to_json(profile) as row from public.device_profiles profile where device_id = $1', [deviceId]);
        return result.rows[0]?.row ?? null;
      },
      async profiles() {
        return (await db.query('select row_to_json(profile) as row from public.device_profiles profile order by device_id')).rows.map(result => result.row);
      },
      async changeApproval(deviceId, status, adminUser = ADMIN) {
        await ensureUser(adminUser);
        return handlers.setDeviceApproval({ deviceId, approvalStatus: status }, adminUser, true);
      },
      pauseNextRead() {
        assert.equal(nextPause, null, 'Only one read barrier may be armed');
        let reached, release;
        const ready = new Promise(resolve => { reached = resolve; });
        const released = new Promise(resolve => { release = resolve; });
        nextPause = { reached, released };
        return { reached: ready, release };
      },
      close: () => db.close(),
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}

const payloadFor = deviceId => ({
  deviceId, displayName: 'Synthetic Driver', vehicleLabel: '札幌101か1234',
  driverPhone: '09012345678', driverEmail: OWNER.email, platform: 'android', appVersion: '0.1.72',
  latestStatus: 'active', latestTripId: 'synthetic-trip', lastSeenAt: '2026-10-11T01:00:00.000Z',
});

function invariantProfile(profile) {
  const { updated_at, last_seen_at, ...invariants } = profile;
  return invariants;
}

async function main() {
  const server = await createClaimTestServer();
  let passed = 0, failed = 0;
  const check = async (name, run) => {
    try { await run(); passed++; console.log(`[ok] ${name}`); }
    catch (error) { failed++; console.error(`[fail] ${name}: ${error.message}`); }
  };
  const outcome = promise => promise.then(value => ({ value }), error => ({ error }));
  try {
    await check('accepted claim followed by lost response and sequential retry preserves profile and approval request', async () => {
      const payload = payloadFor('accepted-response-lost');
      await assert.rejects(async () => { await server.claim(payload, OWNER); throw new Error('Synthetic response lost'); }, /response lost/);
      const accepted = await server.getProfile(payload.deviceId);
      const replayed = await server.claim(payload, OWNER);
      assert.deepEqual(invariantProfile(replayed), invariantProfile(accepted));
      assert.equal((await server.profiles()).filter(profile => profile.device_id === payload.deviceId).length, 1);
    });

    await check('approved existing profile remains approved across duplicate claim', async () => {
      const payload = payloadFor('approved-retry');
      await server.claim(payload, OWNER);
      const approved = await server.changeApproval(payload.deviceId, 'approved');
      const replayed = await server.claim(payload, OWNER);
      assert.deepEqual(invariantProfile(replayed), invariantProfile(approved));
    });

    await check('same-owner overlapping first claims converge without replacing first approval request', async () => {
      const payload = payloadFor('same-owner-overlap');
      const barrier = server.pauseNextRead();
      const delayed = outcome(server.claim(payload, OWNER));
      await barrier.reached;
      let winner;
      try { winner = await server.claim(payload, OWNER); } finally { barrier.release(); }
      const loser = await delayed;
      if (loser.error) assert.equal(loser.error.status, 409);
      assert.deepEqual(invariantProfile(await server.getProfile(payload.deviceId)), invariantProfile(winner));
      assert.deepEqual(invariantProfile(await server.claim(payload, OWNER)), invariantProfile(winner));
    });

    await check('different-owner overlapping first claims cannot replace the accepted owner', async () => {
      const payload = payloadFor('different-owner-overlap');
      const barrier = server.pauseNextRead();
      const delayed = outcome(server.claim(payload, OWNER));
      await barrier.reached;
      let winner;
      try { winner = await server.claim({ ...payload, driverEmail: OTHER.email }, OTHER); } finally { barrier.release(); }
      const loser = await delayed;
      assert.ok(loser.error, 'A stale first claim must fail after another owner creates the device profile');
      assert.ok([403, 409].includes(loser.error.status));
      assert.deepEqual(invariantProfile(await server.getProfile(payload.deviceId)), invariantProfile(winner));
      await assert.rejects(server.claim(payload, OWNER), error => error.status === 403);
    });

    await check('same email does not allow a different authenticated ID to claim an existing device', async () => {
      const payload=payloadFor('same-email-different-id');
      const accepted=await server.claim(payload,OWNER);
      await assert.rejects(server.claim(payload,{...OTHER,email:OWNER.email}),error=>error.status===403);
      assert.deepEqual(invariantProfile(await server.getProfile(payload.deviceId)),invariantProfile(accepted));
    });

    for (const status of ['approved', 'rejected']) {
      await check(`administrator ${status} decision after claim read survives retry`, async () => {
        const payload = payloadFor(`approval-race-${status}`);
        await server.claim(payload, OWNER);
        const barrier = server.pauseNextRead();
        const delayed = outcome(server.claim(payload, OWNER));
        await barrier.reached;
        let decision;
        try { decision = await server.changeApproval(payload.deviceId, status); } finally { barrier.release(); }
        const stale = await delayed;
        if (stale.error) assert.equal(stale.error.status, 409);
        assert.deepEqual(invariantProfile(await server.getProfile(payload.deviceId)), invariantProfile(decision));
        assert.deepEqual(invariantProfile(await server.claim(payload, OWNER)), invariantProfile(decision));
      });
    }

    await check('accepted server profile survives reconstruction and repeated claim', async () => {
      const payload = payloadFor('restored-server-retry');
      await server.claim(payload, OWNER);
      await server.changeApproval(payload.deviceId, 'approved');
      const saved = await server.profiles();
      const restored = await createClaimTestServer({ profiles: saved });
      try {
        const before = await restored.getProfile(payload.deviceId);
        assert.deepEqual(invariantProfile(await restored.claim(payload, OWNER)), invariantProfile(before));
      } finally { await restored.close(); }
    });
  } finally { await server.close(); }
  console.log(`Driver claim replay: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

// The Google fixture bundles this module as CJS; importing it must not run CLI tests.
if (path.basename(process.argv[1] ?? '') === 'test-driver-claim-replay.mjs') {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
