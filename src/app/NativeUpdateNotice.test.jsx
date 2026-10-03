import assert from 'node:assert/strict';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { Capacitor, registerPlugin } from '@capacitor/core';

async function run() {
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(globalThis, {
  __APP_VERSION__: '0.1.67', __BUILD_DATE__: 'test',
  __TRACKLOG_GITHUB_OWNER__: 'Koutacode', __TRACKLOG_GITHUB_REPO__: 'tracklog-pwa',
});
const windowEvents = new EventTarget();
const documentEvents = new EventTarget();
let interval;
globalThis.window = Object.assign(windowEvents, { setInterval: callback => { interval = callback; return 1; }, clearInterval: () => {} });
globalThis.document = Object.assign(documentEvents, { visibilityState: 'visible' });
Capacitor.isNativePlatform = () => true;
let install = async () => { throw new Error('HTTP 404'); };
registerPlugin('AppUpdate', { web: () => ({ installFromUrl: () => install() }) });
let tag = 'v0.1.68';
let status = 200;
globalThis.fetch = async () => new Response(JSON.stringify({
  tag_name: tag, assets: [{ name: 'tracklog-assist-debug.apk', browser_download_url: 'https://github.com/example' }],
}), { status });
const { default: Notice } = await import('./NativeUpdateNotice');
let renderer;
const flush = async callback => act(async () => { await callback(); await new Promise(resolve => setImmediate(resolve)); });
const buttons = () => modal()[0].findAllByType('button');
const modal = () => renderer.root.findAllByProps({ role: 'dialog' });

function Harness() {
  const [count, setCount] = React.useState(0);
  return <><button data-testid="ordinary-action" onClick={() => setCount(count + 1)}>通常操作:{count}</button><Notice /></>;
}
await flush(() => { renderer = create(<Harness />); });
assert.equal(modal().length, 1);
await flush(() => buttons()[0].props.onClick());
assert.match(renderer.root.findByProps({ role: 'status' }).children.join(''), /HTTP 404/);
assert.equal(buttons()[0].props.disabled, false);
await flush(() => buttons()[1].props.onClick());
assert.equal(modal().length, 0, 'failed update can be dismissed to use the app');
await flush(() => renderer.root.findByProps({ 'data-testid': 'ordinary-action' }).props.onClick());
assert.equal(renderer.root.findByProps({ 'data-testid': 'ordinary-action' }).children.join(''), '通常操作:1');
await flush(() => interval());
await flush(() => window.dispatchEvent(new Event('focus')));
await flush(() => document.dispatchEvent(new Event('visibilitychange')));
assert.equal(modal().length, 0, 'same release stays dismissed on timer/focus/resume');
tag = 'v0.1.69';
await flush(() => interval());
assert.equal(modal().length, 1, 'a newer release may notify again');
install = async () => ({ requiresPermission: true });
await flush(() => buttons()[0].props.onClick());
assert.match(renderer.root.findByProps({ role: 'status' }).children.join(''), /インストール許可/);
await flush(() => buttons()[1].props.onClick());
assert.equal(modal().length, 0, 'permission refusal does not block ordinary use');
await flush(() => renderer.unmount());
for (status of [403, 404, 500]) {
  await flush(() => { renderer = create(<Notice />); });
  assert.equal(modal().length, 0, `release check HTTP ${status} leaves normal UI available`);
  await flush(() => renderer.unmount());
}
console.log('NativeUpdateNotice: update failure, permission, dismissal and check failures passed');

}
void run().catch(error => { console.error(error); process.exitCode = 1; });
