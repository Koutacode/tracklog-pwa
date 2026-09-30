import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  OFFICIAL_SIGNER_SHA256,
  parseManifest,
  parseSidecar,
  parseSigner,
  readExpectedRelease,
  runCommand,
  verifyLatestRelease,
} from './verify-latest-release-apk.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// These fixtures intentionally contain no real APK or private app data. Android
// inspector output and public HTTP responses are injected; no network is used.
async function fixture(t) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'tracklog-release-test-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(join(projectRoot, 'android'));
  await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ version: '0.1.63' }));
  await writeFile(join(projectRoot, 'android/gradle.properties'), 'tracklogVersionName=0.1.63\ntracklogVersionCode=61\n');
  const assetName = 'tracklog-assist-debug.apk';
  const bytes = Buffer.from('Offline fixture, intentionally not an APK.\n');
  const sidecar = `${sha256(bytes)}  ${assetName}\n`;
  const state = {
    bytes,
    sidecar,
    manifest: "package: name='com.tracklog.assist' versionCode='61' versionName='0.1.63' platformBuildVersionName='16'\n",
    signer: `Signer #1 certificate SHA-256 digest: ${OFFICIAL_SIGNER_SHA256}\n`,
    embedded: JSON.stringify({ version: '0.1.63', buildDate: '2026-09-30T15:00:00.000Z' }),
    mutateRelease: () => {},
    inspectorCalls: 0,
    fetchCalls: [],
    downloadUrls: [],
    downloadPaths: [],
  };
  const release = {
    id: 123,
    tag_name: 'v0.1.63',
    draft: false,
    prerelease: false,
    assets: [
      { id: 456, name: assetName, size: bytes.length, digest: `sha256:${sha256(bytes)}` },
      { id: 457, name: `${assetName}.sha256`, size: Buffer.byteLength(sidecar), digest: `sha256:${sha256(sidecar)}` },
    ].map(asset => ({ ...asset, state: 'uploaded', browser_download_url: `https://github.com/Koutacode/tracklog-pwa/releases/download/v0.1.63/${asset.name}` })),
  };
  const inputs = {
    projectRoot,
    fetchRelease: async selector => {
      state.fetchCalls.push(selector);
      const response = structuredClone(release);
      state.mutateRelease(response, selector, state.fetchCalls.length);
      return response;
    },
    download: async (url, path) => {
      state.downloadUrls.push(url);
      state.downloadPaths.push(path);
      await writeFile(path, url.endsWith('.sha256') ? state.sidecar : state.bytes);
    },
    tools: {
      manifest: async () => { state.inspectorCalls++; return state.manifest; },
      signer: async () => { state.inspectorCalls++; return state.signer; },
      embeddedVersion: async () => { state.inspectorCalls++; return state.embedded; },
    },
  };
  return { inputs, state, release };
}

async function assertTemporaryFilesRemoved(state) {
  assert.ok(state.downloadPaths.length > 0);
  await assert.rejects(stat(dirname(state.downloadPaths[0])), { code: 'ENOENT' });
}

test('offline success verifies latest twice, records official conditions, and preserves checkout/output', async t => {
  const { inputs, state } = await fixture(t);
  const packageBefore = await readFile(join(inputs.projectRoot, 'package.json'), 'utf8');
  const propsBefore = await readFile(join(inputs.projectRoot, 'android/gradle.properties'), 'utf8');
  await mkdir(join(inputs.projectRoot, 'output'));
  const officialOutput = join(inputs.projectRoot, 'output/tracklog-assist-debug.apk');
  await writeFile(officialOutput, 'existing output must remain intact');
  const result = await verifyLatestRelease(inputs);
  assert.deepEqual(result, {
    tag: 'v0.1.63', releaseId: 123, packageName: 'com.tracklog.assist', versionName: '0.1.63', versionCode: '61',
    sha256: sha256(state.bytes), signerSha256: OFFICIAL_SIGNER_SHA256, buildDate: '2026-09-30T15:00:00.000Z',
    downloadUrl: 'https://github.com/Koutacode/tracklog-pwa/releases/latest/download/tracklog-assist-debug.apk',
  });
  assert.deepEqual(state.fetchCalls, ['latest', 'tags/v0.1.63', 'latest']);
  assert.deepEqual(state.downloadUrls, [result.downloadUrl, `${result.downloadUrl}.sha256`]);
  assert.equal(await readFile(officialOutput, 'utf8'), 'existing output must remain intact');
  assert.equal(await readFile(join(inputs.projectRoot, 'package.json'), 'utf8'), packageBefore);
  assert.equal(await readFile(join(inputs.projectRoot, 'android/gradle.properties'), 'utf8'), propsBefore);
  await assertTemporaryFilesRemoved(state);
});

for (const [label, mutate, message] of [
  ['old latest tag', release => { release.tag_name = 'v0.1.62'; }, /release tag/],
  ['draft', release => { release.draft = true; }, /release draft/],
  ['prerelease', release => { release.prerelease = true; }, /release prerelease/],
  ['missing sidecar', release => { release.assets.pop(); }, /exactly one release asset/],
  ['duplicate APK asset', release => { release.assets.push(release.assets[0]); }, /exactly one release asset/],
  ['unuploaded asset', release => { release.assets[0].state = 'new'; }, /asset state/],
  ['foreign download URL', release => { release.assets[0].browser_download_url = 'https://example.test/app.apk'; }, /asset URL/],
  ['invalid GitHub digest', release => { release.assets[0].digest = 'sha256:unknown'; }, /asset SHA-256 digest/],
]) {
  test(`rejects ${label} before any APK download`, async t => {
    const { inputs, state } = await fixture(t);
    state.mutateRelease = mutate;
    await assert.rejects(verifyLatestRelease(inputs), message);
    assert.equal(state.downloadPaths.length, 0);
    assert.equal(state.inspectorCalls, 0);
  });
}

test('latest and explicit tag must identify the same assets', async t => {
  const { inputs, state } = await fixture(t);
  state.mutateRelease = (release, selector) => { if (selector.startsWith('tags/')) release.assets[0].id++; };
  await assert.rejects(verifyLatestRelease(inputs), /Latest \/ tag release assets/);
  assert.equal(state.downloadPaths.length, 0);
});

for (const [label, mutate, message] of [
  ['same-size APK tampering', (state) => { state.bytes = Buffer.from(state.bytes); state.bytes[0] ^= 1; }, /GitHub asset digest/],
  ['APK size mismatch', state => { state.bytes = Buffer.from('truncated'); }, /asset size/],
  ['SHA sidecar tampering', state => { state.sidecar = `${'0'.repeat(64)}  tracklog-assist-debug.apk\n`; }, /GitHub asset digest/],
]) {
  test(`rejects ${label}, cleans temporary download, and does not run inspectors`, async t => {
    const { inputs, state } = await fixture(t);
    mutate(state);
    await assert.rejects(verifyLatestRelease(inputs), message);
    assert.equal(state.inspectorCalls, 0);
    await assertTemporaryFilesRemoved(state);
  });
}

test('SHA sidecar remains required when GitHub asset digest is unavailable', async t => {
  const { inputs, state, release } = await fixture(t);
  release.assets.forEach(asset => { asset.digest = null; });
  assert.equal((await verifyLatestRelease(inputs)).sha256, sha256(state.bytes));
  state.sidecar = `${'0'.repeat(64)}  tracklog-assist-debug.apk\n`;
  await assert.rejects(verifyLatestRelease(inputs), /APK \/ sidecar SHA-256/);
  await assertTemporaryFilesRemoved(state);
});

for (const [label, mutate, message] of [
  ['different package', state => { state.manifest = state.manifest.replace('com.tracklog.assist', 'com.example.debug'); }, /APK packageName/],
  ['different versionName', state => { state.manifest = state.manifest.replace("versionName='0.1.63'", "versionName='0.1.62'"); }, /APK versionName/],
  ['different versionCode', state => { state.manifest = state.manifest.replace("versionCode='61'", "versionCode='60'"); }, /APK versionCode/],
  ['ordinary local debug signer', state => { state.signer = `Signer #1 certificate SHA-256 digest: ${'a'.repeat(64)}\n`; }, /Official APK signer SHA-256/],
  ['multiple signers', state => { state.signer += `Signer #2 certificate SHA-256 digest: ${OFFICIAL_SIGNER_SHA256}\n`; }, /exactly one APK signer/],
  ['missing signer digest', state => { state.signer = 'Verified\n'; }, /exactly one APK signer/],
  ['different embedded version', state => { state.embedded = JSON.stringify({ version: '0.1.62' }); }, /Embedded APK version/],
  ['missing embedded version', state => { state.embedded = '{}'; }, /Embedded APK version/],
]) {
  test(`rejects ${label} and cleans the APK fixture`, async t => {
    const { inputs, state } = await fixture(t);
    mutate(state);
    await assert.rejects(verifyLatestRelease(inputs), message);
    await assertTemporaryFilesRemoved(state);
  });
}

test('a failed signature verifier cannot be treated as successful inspection', async t => {
  const { inputs, state } = await fixture(t);
  inputs.tools.signer = async () => { throw new Error('apksigner failed'); };
  await assert.rejects(verifyLatestRelease(inputs), /apksigner failed/);
  await assertTemporaryFilesRemoved(state);
});

test('a failed download is cleaned without modifying any output artifact', async t => {
  const { inputs, state } = await fixture(t);
  const originalDownload = inputs.download;
  inputs.download = async (url, path) => {
    await originalDownload(url, path);
    throw new Error('download interrupted');
  };
  await assert.rejects(verifyLatestRelease(inputs), /download interrupted/);
  assert.equal(state.inspectorCalls, 0);
  await assertTemporaryFilesRemoved(state);
});

test('changing latest assets during download prevents a success result', async t => {
  const { inputs, state } = await fixture(t);
  state.mutateRelease = (release, _selector, call) => { if (call === 3) release.assets[0].id++; };
  await assert.rejects(verifyLatestRelease(inputs), /Latest release changed/);
  await assertTemporaryFilesRemoved(state);
});

test('invalid local release versions prevent public API access', async t => {
  const { inputs, state } = await fixture(t);
  await writeFile(join(inputs.projectRoot, 'android/gradle.properties'), 'tracklogVersionName=0.1.62\ntracklogVersionCode=61\n');
  await assert.rejects(verifyLatestRelease(inputs), /Android versionName/);
  assert.equal(state.fetchCalls.length, 0);
  await writeFile(join(inputs.projectRoot, 'android/gradle.properties'), 'tracklogVersionName=0.1.63\ntracklogVersionCode=0\n');
  await assert.rejects(readExpectedRelease(inputs.projectRoot), /versionCode is invalid/);
});

test('ambiguous manifest, malformed sidecar, and ambiguous certificate information are rejected', () => {
  assert.throws(() => parseManifest("package: name='com.tracklog.assist' name='com.other.app' versionCode='61' versionName='0.1.63'"), /ambiguous/);
  assert.throws(() => parseManifest('no package line'), /exactly one package line/);
  assert.throws(() => parseSidecar(`${'a'.repeat(64)}  other.apk`, 'tracklog-assist-debug.apk'), /sidecar filename/);
  assert.throws(() => parseSidecar(`${'a'.repeat(64)}  tracklog-assist-debug.apk\nextra`, 'tracklog-assist-debug.apk'), /Invalid APK SHA-256 sidecar/);
  assert.throws(() => parseSigner('Signer #1 certificate SHA-256 digest: aa:bb\n'), /Invalid APK signer/);
  const colonDigest = OFFICIAL_SIGNER_SHA256.toUpperCase().match(/.{2}/g).join(':');
  assert.equal(parseSigner(`Signer #1 certificate SHA-256 digest: ${colonDigest}\nSigner #1 public key SHA-256 digest: ${'b'.repeat(64)}\n`), OFFICIAL_SIGNER_SHA256);
});

test('actual subprocess failures are surfaced even when the command prints plausible output', async () => {
  assert.equal(await runCommand(process.execPath, ['-e', 'process.stdout.write("ok")']), 'ok');
  await assert.rejects(runCommand(process.execPath, ['-e', 'console.log("Verified"); process.exitCode = 17;']), /failed \(17\)/);
});
