import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClaimTestServer } from './test-driver-claim-replay.mjs';

const owner = { id: '11111111-1111-4111-8111-111111111111', email: 'driver@example.test' };
const other = { id: '33333333-3333-4333-8333-333333333333', email: 'other@example.test' };
const start = Date.parse('2026-10-20T00:00:00.000Z');
const clock = { now: start };
const sourceOverride = process.env.CLAIM_TEST_SOURCE ? await readFile(process.env.CLAIM_TEST_SOURCE, 'utf8') : undefined;
const server = await createClaimTestServer({ clock, sourceOverride });
const payload = (deviceId, extra = {}) => ({ deviceId, displayName: 'Synthetic Driver',
  vehicleLabel: '札幌101か1234', driverPhone: '09012345678', driverEmail: owner.email,
  platform: 'android', appVersion: '0.1.79', latestStatus: 'active',
  lastSeenAt: new Date(clock.now).toISOString(), ...extra });
let passed = 0;
async function check(name, fn) { clock.now = start; await fn(); console.log(`[ok] ${name}`); passed++; }
const outcome = p => p.then(value => ({ value }), error => ({ error }));
try {
  await check('first registration, lost-response retry, pending and rejected approval preserved without UPDATE', async () => {
    const first = await server.claim(payload('first'), owner);
    assert.equal(first.approval_status, 'pending');
    const count = await server.updateCount();
    assert.deepEqual(await server.claim(payload('first'), owner), first);
    assert.equal(await server.updateCount(), count);
    const rejected = await server.changeApproval('first', 'rejected');
    const next = await server.updateCount();
    assert.deepEqual(await server.claim(payload('first'), owner), rejected);
    assert.equal(await server.updateCount(), next);
    await assert.rejects(server.claim(payload('first'), other), e => e.status === 403);
  });
  await check('freshness threshold 59999 / 60000 / 60001 ms and refreshed response', async () => {
    for (const age of [59999, 60000, 60001]) {
      clock.now = start;
      const id = `boundary-${age}`;
      await server.claim(payload(id), owner);
      const before = await server.updateCount();
      clock.now += age;
      const result = await server.claim(payload(id), owner);
      assert.equal(await server.updateCount() - before, age < 60000 ? 0 : 1);
      assert.equal(Date.parse(result.last_seen_at), age < 60000 ? start : clock.now);
    }
  });
  await check('each substantive normalized field change writes immediately', async () => {
    const changes = { displayName: 'Changed Driver', vehicleLabel: '札幌101か1235', driverPhone: '09012345679',
      driverEmail: 'changed@example.test', platform: 'web', appVersion: '0.1.80', latestStatus: 'rest',
      latestTripId: 'synthetic-trip', latestLat: 1, latestLng: 2, latestAccuracy: 10,
      latestLocationAt: '2026-10-20T00:00:00.001Z' };
    for (const [key, value] of Object.entries(changes)) {
      const id = `changed-${key}`;
      await server.claim(payload(id), owner);
      await server.changeApproval(id, 'approved');
      const before = await server.updateCount();
      await server.claim(payload(id, { [key]: value }), owner);
      assert.equal(await server.updateCount() - before, 1, key);
    }
  });
  await check('future saved timestamp and backward client clock take ordinary update path', async () => {
    for (const delta of [1, 60001]) {
      const id = `clock-${delta}`;
      await server.claim(payload(id, { lastSeenAt: new Date(start + delta).toISOString() }), owner);
      const before = await server.updateCount();
      await server.claim(payload(id), owner);
      assert.equal(await server.updateCount() - before, 1);
    }
    await server.claim(payload('backward'), owner);
    const before = await server.updateCount();
    await server.claim(payload('backward', { lastSeenAt: new Date(start - 1).toISOString() }), owner);
    assert.equal(await server.updateCount() - before, 1);
  });
  await check('invalid incoming timestamp retains database rejection', async () => {
    await server.claim(payload('invalid'), owner);
    await assert.rejects(server.claim(payload('invalid', { lastSeenAt: 'not-a-date' }), owner), e => e.status === 500);
  });
  await check('concurrent unchanged claims both succeed without updates', async () => {
    await server.claim(payload('same'), owner);
    const before = await server.updateCount();
    const barrier = server.pauseNextRead();
    const delayed = server.claim(payload('same'), owner);
    await barrier.reached;
    const immediate = await server.claim(payload('same'), owner);
    barrier.release();
    assert.deepEqual(await delayed, immediate);
    assert.equal(await server.updateCount(), before);
  });
  await check('approval revocation and location change between reads yield 409; retry observes latest state', async () => {
    for (const change of ['approval', 'location', 'owner']) {
      const id = `race-${change}`;
      await server.claim(payload(id), owner);
      await server.changeApproval(id, 'approved');
      const barrier = server.pauseNextRead();
      const delayed = outcome(server.claim(payload(id), owner));
      await barrier.reached;
      try {
        if (change === 'approval') await server.changeApproval(id, 'rejected');
        else if (change === 'owner') await server.claim(payload(id), other, true);
        else await server.claim(payload(id, { latestLat: 1, latestLng: 2 }), owner);
      } finally { barrier.release(); }
      assert.equal((await delayed).error?.status, 409, change);
      if (change === 'approval') assert.equal((await server.claim(payload(id), owner)).approval_status, 'rejected');
      if (change === 'owner') await assert.rejects(server.claim(payload(id), owner), e => e.status === 403);
      if (change === 'location') assert.equal((await server.getProfile(id)).latest_lat, 1);
    }
  });
  await check('same workload: 80 polls over one hour performs 40 UPDATEs instead of 80', async () => {
    await server.claim(payload('model'), owner);
    const before = await server.updateCount();
    for (let i = 1; i <= 80; i++) {
      clock.now = start + i * 45000;
      const row = await server.claim(payload('model'), owner);
      assert.equal(row.device_id, 'model');
      assert.equal(row.approval_status, 'pending');
    }
    const updates = await server.updateCount() - before;
    assert.equal(updates, 40);
    console.log(JSON.stringify({ scenario: 'claim-only-45s-poll-1h', calls: 80, updates, responses: 80 }));
  });
} finally { await server.close(); }
console.log(`Device claim throttle: ${passed} passed`);
