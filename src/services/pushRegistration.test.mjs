import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('./pushRegistration.ts', import.meta.url), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `${startMarker} must exist`);
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return source.slice(start, end).replace(/^export /, '');
}

const helperSource = [
  sourceBetween('export function decodeVapidPublicKey', '\n\nexport function normalizeWebPushSubscriptionJson'),
  sourceBetween('export function normalizeWebPushSubscriptionJson', '\n\nfunction applicationServerKeyMatches'),
].join('\n\n');
const javascript = ts.transpileModule(helperSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.None,
  },
}).outputText;
const context = vm.createContext({ URL, Uint8Array, atob, btoa, Error, Number });
vm.runInContext(
  `${javascript}\nthis.helpers = { decodeVapidPublicKey, normalizeWebPushSubscriptionJson };`,
  context,
);
const { decodeVapidPublicKey, normalizeWebPushSubscriptionJson } = context.helpers;

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

const publicKeyBytes = new Uint8Array(65);
publicKeyBytes[0] = 0x04;
for (let index = 1; index < publicKeyBytes.length; index++) publicKeyBytes[index] = index;
const decodedPublicKey = decodeVapidPublicKey(toBase64Url(publicKeyBytes));
assert.equal(decodedPublicKey.length, 65, 'VAPID public key must decode to 65 bytes');
assert.deepEqual([...decodedPublicKey], [...publicKeyBytes], 'VAPID public key bytes must round-trip');
assert.throws(() => decodeVapidPublicKey('invalid'), /invalid/, 'malformed VAPID public key must be rejected');

const subscription = normalizeWebPushSubscriptionJson({
  endpoint: ' https://push.example.test/subscription/123 ',
  expirationTime: null,
  keys: {
    auth: 'auth-key',
    p256dh: 'p256dh-key',
  },
});
assert.equal(subscription.endpoint, 'https://push.example.test/subscription/123', 'subscription endpoint must be trimmed');
assert.equal(subscription.expirationTime, null, 'subscription expiration must preserve null');
assert.equal(subscription.keys.auth, 'auth-key', 'subscription auth key must be preserved');
assert.equal(subscription.keys.p256dh, 'p256dh-key', 'subscription p256dh key must be preserved');
assert.throws(
  () => normalizeWebPushSubscriptionJson({
    endpoint: 'http://push.example.test/subscription/123',
    keys: { auth: 'auth-key', p256dh: 'p256dh-key' },
  }),
  /invalid/,
  'non-HTTPS subscription endpoint must be rejected',
);

console.log('pushRegistration: 7 tests passed');
