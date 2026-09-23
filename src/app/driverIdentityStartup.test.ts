import assert from 'node:assert/strict';
import type { DriverIdentity } from '../domain/remoteTypes';
import { getNativeAuthorizationEmail, resolveNativeStartupIdentity, startDriverIdentityCheck } from './driverIdentityStartup';

const approved: DriverIdentity = {
  configured: true, deviceId: 'synthetic-device', displayName: 'Test Driver', vehicleLabel: '札幌101か8916',
  email: 'driver@example.com', phone: '09012345678', authInitialized: true, profileComplete: true, approvalStatus: 'approved',
};
const nativeState = {
  identity: approved, authorizationConfigured: true, authorizationBlocked: false,
  authorizationEmail: approved.email, explicitSignOut: false,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

async function run() {
  assert.equal(resolveNativeStartupIdentity(nativeState), approved, 'approved native enrollment is available offline');
  for (const invalid of [
    { explicitSignOut: true }, { authorizationBlocked: true }, { authorizationConfigured: false },
    { authorizationConfigured: false, authorizationBlocked: true }, { authorizationEmail: null },
    { authorizationEmail: 'other@example.com' },
  ]) {
    const identity = resolveNativeStartupIdentity({ ...nativeState, ...invalid });
    assert.equal(identity.authInitialized, false, 'missing, revoked, signed-out, or other-account native credentials cannot unlock');
  }
  for (const approvalStatus of ['pending', 'rejected', 'unregistered'] as const) {
    assert.equal(resolveNativeStartupIdentity({ ...nativeState, identity: { ...approved, approvalStatus } }).approvalStatus,
      approvalStatus, 'local reads never manufacture approval');
  }
  assert.equal(resolveNativeStartupIdentity({ ...nativeState, identity: { ...approved, profileComplete: false } }).profileComplete,
    false, 'incomplete profile stays incomplete');
  assert.equal(resolveNativeStartupIdentity({ ...nativeState, identity: { ...approved, authInitialized: false } }).authInitialized,
    false, 'saved approval alone is not authentication');
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  assert.equal(getNativeAuthorizationEmail(`header.${encode({ sub: 'synthetic-user', email: 'Driver@Example.com', exp: 1 })}.signature`),
    'driver@example.com', 'expired access token still identifies durable offline enrollment without refreshing');
  for (const invalid of ['', 'malformed', `header.${encode({ email: 'driver@example.com' })}.signature`]) {
    assert.equal(getNativeAuthorizationEmail(invalid), null, 'malformed native identity fails closed');
  }

  {
    const remote = deferred<DriverIdentity>();
    const seen: DriverIdentity[] = [];
    let unavailable = 0;
    const check = startDriverIdentityCheck({
      readLocal: async () => approved, refresh: () => remote.promise,
      onIdentity: identity => seen.push(identity), onUnavailable: () => unavailable++, onSettled: () => {}, timeoutMs: 10,
    });
    await tick();
    assert.deepEqual(seen, [approved], 'local home is available while cloud is still unresolved');
    await check.settled;
    assert.equal(unavailable, 0, 'slow cloud does not turn an approved local startup into an error');
    const rejected = { ...approved, approvalStatus: 'rejected' as const };
    remote.resolve(rejected);
    await tick();
    assert.equal(seen[seen.length - 1], rejected, 'late cloud rejection still replaces local approval after the UI deadline');
    check.cancel();
  }
  {
    const local = deferred<DriverIdentity>();
    const rejected = { ...approved, approvalStatus: 'rejected' as const };
    const seen: DriverIdentity[] = [];
    const check = startDriverIdentityCheck({
      readLocal: () => local.promise, refresh: async () => rejected,
      onIdentity: identity => seen.push(identity), onUnavailable: () => {}, onSettled: () => {},
    });
    await check.settled;
    local.resolve(approved);
    await tick();
    assert.deepEqual(seen, [rejected], 'late local approval cannot overwrite a newer cloud rejection');
  }
  {
    const local = deferred<DriverIdentity>();
    let published = 0;
    const check = startDriverIdentityCheck({
      readLocal: () => local.promise, refresh: async () => { throw new Error('revoked'); },
      onIdentity: () => published++, onUnavailable: () => {}, onFailure: () => true, onSettled: () => {},
    });
    await tick();
    local.resolve(approved);
    await check.settled;
    assert.equal(published, 0, 'permanent revocation prevents a later stale local unlock');
  }
  {
    let unavailable = 0;
    let settled = 0;
    const check = startDriverIdentityCheck({
      readLocal: async () => { throw new Error('local database unavailable'); },
      refresh: () => new Promise<DriverIdentity>(() => {}), onIdentity: () => {},
      onUnavailable: () => unavailable++, onSettled: () => settled++, timeoutMs: 10,
    });
    await check.settled;
    assert.equal(unavailable, 1, 'database failure and hung cloud expose retry instead of endless loading');
    assert.equal(settled, 1, 'deadline settles the check once');
    check.cancel();
  }
  {
    const remote = deferred<DriverIdentity>();
    let published = 0;
    const check = startDriverIdentityCheck({
      readLocal: async () => null, refresh: () => remote.promise,
      onIdentity: () => published++, onUnavailable: () => {}, onSettled: () => {},
    });
    check.cancel();
    remote.resolve(approved);
    await tick();
    assert.equal(published, 0, 'cancelled checks cannot overwrite logout, retry, or another login');
  }
  console.log('driverIdentityStartup: offline entry, timeout recovery, revocation, account binding, and races passed');
}
void run();
