import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as ts from 'typescript';

const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
const migration = await readFile(
  new URL('../../migrations/20260710071821_tracklog_standard_web_push.sql', import.meta.url),
  'utf8',
);

function functionSource(name, nextName) {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`\nasync function ${nextName}`, start + 1);
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return source.slice(start, end);
}

const adminCheck = functionSource('isTracklogAdmin', 'getDeviceProfile');
assert.doesNotMatch(adminCheck, /\.ilike\s*\(/, 'admin email lookup must not use wildcard matching');
assert.match(adminCheck, /\.eq\('enabled', true\)/, 'admin lookup must only load enabled rows');
assert.match(adminCheck, /sameEmailAddress/, 'admin lookup must use normalized exact email comparison');

const migrationHandler = functionSource('migrateDeviceRecords', 'requireAdmin');
assert.match(migrationHandler, /\.rpc\('tracklog_migrate_device_v2'/, 'device migration must call the v2 RPC');
assert.equal((migrationHandler.match(/\.rpc\s*\(/g) ?? []).length, 1, 'device migration must make one RPC call');
assert.doesNotMatch(migrationHandler, /\.(?:from|upsert|update|delete)\s*\(/, 'device migration must not issue REST table mutations');
assert.match(migrationHandler, /_actor_user_id: user\.id/, 'device migration must pass the authenticated actor');

assert.match(source, /npm:web-push@3\.6\.7/, 'Edge function must pin the Web Push package');
assert.match(source, /statusCode === 404 \|\| statusCode === 410/, '404 and 410 must be permanent Web Push failures');
assert.match(migration, /provider in \('fcm', 'webpush'\)/, 'provider constraint must allow FCM and Web Push');

const registrationHandler = functionSource('registerPushToken', 'unregisterPushToken');
assert.ok(
  registrationHandler.indexOf('requireApprovedPushDevice') <
    registrationHandler.indexOf('normalizeWebPushSubscription'),
  'Web Push subscriptions must only be parsed after the approved-device check',
);
assert.match(
  source,
  /function parseStoredWebPushSubscription[\s\S]*normalizeWebPushSubscription/,
  'stored subscriptions must be revalidated before delivery',
);

const validatorStart = source.indexOf('function parseCanonicalIpv4Literal');
const validatorEnd = source.indexOf('\nfunction normalizeWebPushSubscription', validatorStart);
assert.notEqual(validatorStart, -1, 'Web Push endpoint validator helpers must exist');
assert.notEqual(validatorEnd, -1, 'Web Push endpoint validator helpers must be contiguous');

const validatorJavascript = ts.transpileModule(
  `${source.slice(validatorStart, validatorEnd)}\n` +
    '(globalThis).__validateWebPushEndpoint = validateWebPushEndpoint;',
  {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

class TestHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const validatorContext = vm.createContext({ URL, HttpError: TestHttpError });
vm.runInContext(validatorJavascript, validatorContext);
const validateWebPushEndpoint = validatorContext.__validateWebPushEndpoint;
assert.equal(typeof validateWebPushEndpoint, 'function', 'Web Push endpoint validator must be executable');

const allowedEndpoints = [
  'https://web.push.apple.com/QH_public-token',
  'https://fcm.googleapis.com/fcm/send/public-token',
  'https://updates.push.services.mozilla.com/wpush/v2/public-token',
  'https://web.push.apple.com:443/QH_public-token',
  'https://8.8.8.8/push/public-token',
  'https://[2606:4700:4700::1111]/push/public-token',
];
for (const endpoint of allowedEndpoints) {
  assert.doesNotThrow(
    () => validateWebPushEndpoint(endpoint),
    `${endpoint} should be accepted as a public HTTPS Push endpoint`,
  );
}

const blockedEndpoints = [
  'http://fcm.googleapis.com/fcm/send/token',
  'https://user:password@fcm.googleapis.com/fcm/send/token',
  'https://@fcm.googleapis.com/fcm/send/token',
  'https://fcm.googleapis.com:8443/fcm/send/token',
  'https://localhost/push/token',
  'https://localhost./push/token',
  'https://intranet/push/token',
  'https://printer.local/push/token',
  'https://printer.local./push/token',
  'https://10.0.0.1/push/token',
  'https://172.16.0.1/push/token',
  'https://172.31.255.255/push/token',
  'https://192.168.1.1/push/token',
  'https://127.0.0.1/push/token',
  'https://127.1/push/token',
  'https://2130706433/push/token',
  'https://169.254.169.254/push/token',
  'https://[::]/push/token',
  'https://[::1]/push/token',
  'https://[fe80::1]/push/token',
  'https://[febf::1]/push/token',
  'https://[fc00::1]/push/token',
  'https://[fdff::1]/push/token',
  'https://[::ffff:127.0.0.1]/push/token',
  'https://[::ffff:10.0.0.1]/push/token',
];
for (const endpoint of blockedEndpoints) {
  assert.throws(
    () => validateWebPushEndpoint(endpoint),
    error => error instanceof TestHttpError && error.status === 400,
    `${endpoint} should be rejected as an unsafe Push endpoint`,
  );
}

console.log('tracklog-privileged static and endpoint execution checks passed');
