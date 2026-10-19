import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
test('runtime and release verification use only the original repository', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.tracklogRelease.githubOwner, 'Koutacode');
  assert.equal(pkg.tracklogRelease.githubRepo, 'tracklog-pwa');
  assert.equal(pkg.tracklogRelease.migrationPhase, undefined);
  for (const path of ['src/app/releaseInfo.ts', 'vite.config.ts', 'scripts/verify-latest-release-apk.mjs', 'scripts/verify-latest-release-apk.ps1']) {
    assert.ok(read(path).includes('tracklog-pwa'), path);
    assert.ok(!read(path).includes('tracklog-releases'), path);
  }
  const native = read('android/app/src/main/java/com/tracklog/assist/AppUpdatePlugin.java');
  assert.ok(native.includes('https://github.com/Koutacode/tracklog-pwa/releases/latest/download/tracklog-assist-debug.apk'));
  assert.ok(!native.includes('tracklog-releases'));
});

test('release workflow uses existing repo token and all publication phases target the source repository', () => {
  const workflow = read('.github/workflows/android-release.yml');
  assert.ok(!/TRACKLOG_DISTRIBUTION|create-github-app-token|tracklog-releases/.test(workflow));
  assert.ok(workflow.includes("tags:\n      - 'v*'"));
  assert.ok(workflow.includes('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}'));
  for (const name of ['Create draft GitHub Release', 'Verify draft release APK', 'Publish verified GitHub Release', 'Preserve previously published APK assets']) {
    assert.ok(workflow.includes(name), name);
  }
  assert.ok(!/gh api --method DELETE/.test(workflow), 'release must retain previous APK assets');
  assert.ok(workflow.includes('https://github.com/${GITHUB_REPOSITORY}/releases/latest/download/tracklog-assist-debug.apk'));
  assert.ok(workflow.includes('repos/${GITHUB_REPOSITORY}/releases/${TRACKLOG_RELEASE_ID}'));
  assert.ok(!existsSync(new URL('../.github/workflows/distribution-access-check.yml', import.meta.url)));
});

test('next candidate never reuses the failed migration tag or decreases versionCode', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const properties = read('android/gradle.properties');
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  assert.ok(major > 0 || minor > 1 || (minor === 1 && patch > 67));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.ok(properties.includes(`tracklogVersionName=${pkg.version}`));
  assert.ok(Number(properties.match(/^tracklogVersionCode=(\d+)$/m)?.[1]) > 65);
});


// Exercise the release orchestration against a deterministic in-memory GitHub.
// No real tag, release, token, APK or production connection is used.
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RECOVERY, validateRecoveryDraft, guardMainAndCi, REPOSITORY, validateContext, validateCi, validateNewVersion, githubClient,
  guardCandidate, createCandidate, validateDraft, validateAssets, validateUploadedAsset, verifyDraft, reportRetainedState,
} from './android-release-control.mjs';

const sha = 'a'.repeat(40);
const expected = { tag: 'v0.1.77', version: '0.1.77', versionCode: '75', packageName: 'com.tracklog.assist', assetName: 'tracklog-assist-debug.apk' };
const env = { GITHUB_REPOSITORY: REPOSITORY, GITHUB_SHA: sha, GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch', EXPECTED_SHA: sha, EXPECTED_TAG: expected.tag,
  GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1' };
const context = validateContext(env, expected, sha);
const run = { id: 22, path: '.github/workflows/ci.yml', head_repository: { full_name: REPOSITORY },
  head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', run_attempt: 1 };
const jobs = ['validate', 'android-validation', 'temporary-workspaces'].map(name => ({
  name, head_sha: sha, status: 'completed', conclusion: 'success', run_attempt: 1,
}));
const oldRelease = { id: 10, tag_name: 'v0.1.76', draft: false };
const previous = new Map([['v0.1.76', 'tracklogVersionCode=74\n']]);

function fixture(options = {}) {
  const data = { main: sha, tag: null, releases: [structuredClone(oldRelease)],
    run: structuredClone(run), jobs: structuredClone(jobs), mutations: [], ...options };
  const api = async (path, request = {}) => {
    if (request.method === 'POST') {
      data.mutations.push({ path, body: structuredClone(request.body) });
      if (path === '/git/refs') {
        if (data.tag) throw new Error('HTTP 422');
        data.tag = request.body.sha;
        return { ref: request.body.ref, object: { type: 'commit', sha: data.tag } };
      }
      if (path === '/releases') {
        if (data.failCreate) throw new Error('HTTP 422');
        const release = { ...request.body, id: 11, assets: [] };
        data.releases.push(release);
        return structuredClone(release);
      }
      throw new Error(`Unexpected mutation ${path}`);
    }
    if (path === '/git/ref/heads/main') return { object: { type: 'commit', sha: data.main } };
    if (path.startsWith('/actions/workflows/ci.yml/runs?')) {
      assert.equal(request.publicRead, true);
      return { workflow_runs: [structuredClone(data.run)] };
    }
    if (path.startsWith('/actions/runs/22/jobs?')) {
      assert.equal(request.publicRead, true);
      return { jobs: structuredClone(data.jobs) };
    }
    if (path === '/git/ref/tags/v0.1.77') return data.tag ? { object: { type: 'commit', sha: data.tag } } : null;
    if (path.startsWith('/releases?')) return structuredClone(data.releases);
    if (path === '/contents/android/gradle.properties?ref=v0.1.76') {
      return { encoding: 'base64', content: Buffer.from(previous.get('v0.1.76')).toString('base64') };
    }
    if (path === '/releases/11') return structuredClone(data.releases.find(r => r.id === 11));
    if (path.startsWith('/releases/assets/')) return data.bytes[Number(path.split('/').at(-1))];
    throw new Error(`Unexpected read ${path}`);
  };
  return { api, data };
}

test('manual inputs confirm fixed main code; push supports the exact version tag', () => {
  assert.equal(validateContext(env, expected, sha).sha, sha);
  for (const change of [
    { GITHUB_REPOSITORY: 'other/repo' }, { GITHUB_REF: 'refs/heads/feature' },
    { EXPECTED_SHA: 'b'.repeat(40) }, { EXPECTED_SHA: '$(command)' },
    { EXPECTED_TAG: 'v0.1.77\ninjected=true' }, { EXPECTED_TAG: 'v0.1.76' },
    { GITHUB_EVENT_NAME: 'pull_request' },
  ]) assert.throws(() => validateContext({ ...env, ...change }, expected, sha));
  assert.throws(() => validateContext(env, expected, 'b'.repeat(40)));
  const push = { ...env, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v0.1.77' };
  assert.equal(validateContext(push, expected, sha).event, 'push');
  assert.throws(() => validateContext({ ...push, GITHUB_REF: 'refs/tags/v0.1.76' }, expected, sha));
});

test('only all successful jobs from the latest exact main CI attempt qualify', () => {
  validateCi([run], jobs, context);
  for (const change of [{ head_sha: 'b'.repeat(40) }, { event: 'pull_request' }, { head_branch: 'feature' },
    { conclusion: 'failure' }, { status: 'in_progress' }, { run_attempt: 2 }, { path: 'other.yml' }]) {
    assert.throws(() => validateCi([{ ...run, ...change }, run], jobs, context));
  }
  assert.throws(() => validateCi([], jobs, context));
  assert.throws(() => validateCi([run], jobs.slice(1), context));
  assert.throws(() => validateCi([run], [...jobs, jobs[0]], context));
  for (const conclusion of ['skipped', 'failure', 'cancelled']) {
    assert.throws(() => validateCi([run], [{ ...jobs[0], conclusion }, ...jobs.slice(1)], context));
  }
});

test('existing draft, prerelease and published releases or nonincreasing versions stop', () => {
  validateNewVersion(context, [oldRelease], previous);
  for (const draft of [true, false]) for (const prerelease of [true, false]) {
    assert.throws(() => validateNewVersion(context, [oldRelease, { tag_name: context.tag, draft, prerelease }], previous));
  }
  assert.throws(() => validateNewVersion({ ...context, versionCode: '74' }, [oldRelease], previous));
  assert.throws(() => validateNewVersion({ ...context, tag: 'v0.1.75' }, [oldRelease], previous));
  assert.throws(() => validateNewVersion(context, [oldRelease], new Map()));
});

test('preflight is read-only and a manual existing tag never gets reused', async () => {
  const { api, data } = fixture();
  await guardCandidate(api, context);
  assert.deepEqual(data.mutations, []);
  data.tag = sha;
  await assert.rejects(guardCandidate(api, context), /tag already exists/);
  assert.deepEqual(data.mutations, []);
  await guardCandidate(api, { ...context, event: 'push' });
  data.tag = 'b'.repeat(40);
  await assert.rejects(guardCandidate(api, { ...context, event: 'push' }), /tag SHA/);
});

test('manual creation creates only the exact tag and a new unpublished draft', async () => {
  const { api, data } = fixture(); const states = [];
  const state = await createCandidate(api, context, async s => states.push(s));
  assert.deepEqual(data.mutations.map(m => m.path), ['/git/refs', '/releases']);
  assert.deepEqual(data.mutations[0].body, { ref: 'refs/tags/v0.1.77', sha });
  assert.deepEqual(data.mutations[1].body, { tag_name: context.tag, target_commitish: sha,
    name: `Release ${context.tag}`, draft: true, prerelease: false, make_latest: 'false' });
  assert.deepEqual(states.map(s => s.phase), ['tag-created', 'draft-created']);
  assert.equal(state.releaseId, 11);
  assert.deepEqual(data.releases[0], oldRelease, 'old releases remain unchanged');
});

test('tag push reuses only its trigger tag and creates no tag mutation', async () => {
  const { api, data } = fixture({ tag: sha });
  await createCandidate(api, { ...context, event: 'push' }, async () => {});
  assert.deepEqual(data.mutations.map(m => m.path), ['/releases']);
});

test('main/CI changes and existing releases fail before any mutation', async () => {
  for (const options of [{ main: 'b'.repeat(40) }, { run: { ...run, conclusion: 'failure' } },
    { releases: [oldRelease, { id: 99, tag_name: context.tag, draft: true }] }]) {
    const { api, data } = fixture(options);
    await assert.rejects(createCandidate(api, context, async () => {}));
    assert.deepEqual(data.mutations, []);
  }
});

test('main changes after tag creation stop; created tags are retained', async () => {
  const { api, data } = fixture();
  await assert.rejects(createCandidate(api, context, async state => {
    if (state.phase === 'tag-created') data.main = 'b'.repeat(40);
  }), /main moved/);
  assert.equal(data.tag, sha);
  assert.deepEqual(data.mutations.map(m => m.path), ['/git/refs']);
});

test('draft creation failure never updates or deletes the tag or any old release', async () => {
  const { api, data } = fixture({ failCreate: true }); const states = [];
  await assert.rejects(createCandidate(api, context, async s => states.push(s)), /422/);
  assert.equal(data.tag, sha);
  assert.deepEqual(data.releases, [oldRelease]);
  assert.equal(states.at(-1).phase, 'tag-created');
  assert.deepEqual(data.mutations.map(m => m.path), ['/git/refs', '/releases']);
});

test('only this run-owned exact draft and the official asset names/URLs qualify', () => {
  const state = { ...context, releaseId: 11 };
  const release = { id: 11, tag_name: context.tag, target_commitish: sha, draft: true, prerelease: false };
  validateDraft(release, state);
  for (const change of [{ id: 99 }, { draft: false }, { prerelease: true }, { target_commitish: 'main' }, { tag_name: 'v0.1.76' }]) {
    assert.throws(() => validateDraft({ ...release, ...change }, state));
  }
  assert.throws(() => validateAssets({ assets: [] }, state));
});

test('GitHub client uses no authentication for public CI and fails closed on errors', async () => {
  const calls = [];
  const api = githubClient('synthetic-token', async (url, options) => {
    calls.push({ url, options });
    return { status: 200, ok: true, json: async () => ({}) };
  });
  await api('/actions/workflows/ci.yml/runs', { publicRead: true });
  assert.equal(calls[0].options.headers.Authorization, undefined);
  await api('/git/ref/heads/main');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer synthetic-token');
  assert.equal(calls[1].options.redirect, 'error');
  for (const status of [401, 403, 429, 500]) {
    const failed = githubClient('synthetic-token', async () => ({ status, ok: false }));
    await assert.rejects(failed('/git/ref/tags/v0.1.77', { missing: true }), new RegExp(String(status)));
  }
});

test('draft APK bytes must be re-inspected and equal the build before publication', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tracklog-control-test-'));
  try {
    const { api, data } = fixture();
    const state = await createCandidate(api, context, async () => {});
    const apk = Buffer.from('synthetic apk bytes');
    const sha256 = createHash('sha256').update(apk).digest('hex');
    const sidecar = Buffer.from(`${sha256}  ${state.assetName}\n`);
    state.built = { sha256, size: apk.length };
    data.bytes = { 100: apk, 101: sidecar };
    const release = data.releases.at(-1);
    release.assets = [apk, sidecar].map((bytes, index) => {
      const name = index ? `${state.assetName}.sha256` : state.assetName;
      return { id: 100 + index, name, size: bytes.length, state: 'uploaded',
        url: `https://api.github.com/repos/${REPOSITORY}/releases/assets/${100 + index}`,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        browser_download_url: `https://github.com/${REPOSITORY}/releases/download/untagged-ef7b8222da7b24f07097/${name}` };
    });
    state.uploadedAssets = release.assets.map((asset, i) => validateUploadedAsset(asset, asset.name, [apk, sidecar][i]));
    let inspections = 0;
    const inspect = async (apkPath, sidecarPath) => {
      inspections++;
      assert.deepEqual(await readFile(apkPath), apk);
      assert.deepEqual(await readFile(sidecarPath), sidecar);
      return state.built;
    };
    const verified = await verifyDraft(api, context, state, { RUNNER_TEMP: dir }, inspect);
    assert.equal(verified.phase, 'verified'); assert.equal(inspections, 1);
    await assert.rejects(verifyDraft(api, context, state, { RUNNER_TEMP: dir }, async () => {
      throw new Error('signer mismatch');
    }), /signer mismatch/);
    await assert.rejects(verifyDraft(api, context, state, { RUNNER_TEMP: dir }, async () => ({ ...state.built, sha256: 'bad' })), /differs/);
    for (const change of [{ id: 999 }, { size: apk.length + 1 }, { digest: null }, { digest: `sha256:${'0'.repeat(64)}` }, { state: 'new' }, { url: 'https://example.com/asset' }]) {
      const original = release.assets[0];
      release.assets[0] = { ...original, ...change };
      await assert.rejects(verifyDraft(api, context, state, { RUNNER_TEMP: dir }, inspect));
      release.assets[0] = original;
    }
    data.bytes[100] = Buffer.alloc(apk.length, 0);
    await assert.rejects(verifyDraft(api, context, state, { RUNNER_TEMP: dir }, inspect), /checksum mismatch/);
    data.bytes[100] = Buffer.from('tampered');
    await assert.rejects(verifyDraft(api, context, state, { RUNNER_TEMP: dir }, inspect), /size mismatch/);
    assert.deepEqual(data.mutations.map(m => m.path), ['/git/refs', '/releases'], 'verification cannot publish or mutate');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('workflow keeps permissions, fixed checkout, validation order and ID-only publication', () => {
  const workflow = read('.github/workflows/android-release.yml');
  assert.ok(workflow.includes("github.ref == 'refs/heads/main'"));
  assert.ok(workflow.includes('ref: ${{ github.sha }}'));
  assert.ok(!/ref:.*inputs|run:.*inputs/.test(workflow));
  assert.ok(workflow.includes('EXPECTED_TAG: ${{ inputs.expected_tag }}'));
  assert.ok(workflow.includes('EXPECTED_SHA: ${{ inputs.expected_sha }}'));
  assert.ok(!/actions: write|actions: read|workflows:|id-token:|softprops|gh release edit|GITHUB_REF_NAME/.test(workflow));
  assert.ok(workflow.includes('contents: write'));
  const ordered = ['preflight', 'npm ci', 'npm run typecheck', 'npm run test:logic', 'npm run test:sync',
    'npm run test:release-apk', 'npm run check:csp', 'npm run build', 'npm run check:offline',
    'Restore TrackLog Android debug keystore', 'Build Android APK', 'Verify release APK signer',
    'create-draft', 'verify-draft', 'publication-check', '-F draft=false', 'node scripts/verify-latest-release-apk.mjs'];
  let position = -1;
  for (const value of ordered) {
    const next = workflow.indexOf(value, position + 1);
    assert.ok(next > position, `Missing/out-of-order ${value}`); position = next;
  }
  const control = read('scripts/android-release-control.mjs');
  assert.ok(!/method: 'DELETE'|method: 'PATCH'/.test(control));
  assert.ok(control.includes("same(env.VITE_TRACKLOG_NATIVE_PUSH_ENABLED, 'true'"));
  assert.ok(control.includes("'assets/public/version.json'"));
  assert.ok(control.includes("parseSigner(await runCommand"));
});


test('failure report handles absent state and accepted-but-timed-out creations without adopting IDs', async () => {
  const { api, data } = fixture({ tag: sha,
    releases: [oldRelease, { id: 11, tag_name: context.tag, draft: true, prerelease: false, assets: [] }] });
  const unknown = await reportRetainedState(api, context, undefined);
  assert.equal(unknown.localPhase, 'no-local-state');
  assert.equal(unknown.remoteTag, sha);
  assert.equal(unknown.recordedReleaseId, null);
  assert.equal(unknown.remoteReleases[0].ownership, 'unconfirmed');
  const known = await reportRetainedState(api, context, { ...context, phase: 'draft-created', releaseId: 11 });
  assert.equal(known.remoteReleases[0].ownership, 'recorded-by-this-run');
  assert.deepEqual(data.mutations, []);
  const unavailable = await reportRetainedState(async () => { throw new Error('unavailable'); }, context, undefined);
  assert.equal(unavailable.remoteTag, 'unknown');
  assert.equal(unavailable.remoteReleases, 'unknown');
  assert.ok(unavailable.tagReadError && unavailable.releaseReadError);
});

test('all release APK inspection phases use pinned Build Tools 36.0.0', () => {
  const workflow = read('.github/workflows/android-release.yml');
  assert.ok(workflow.includes("packages: 'platform-tools build-tools;36.0.0'"));
  assert.ok(workflow.includes('AAPT="$ANDROID_HOME/build-tools/36.0.0/aapt"'));
  assert.ok(workflow.includes('APKSIGNER="$ANDROID_HOME/build-tools/36.0.0/apksigner"'));
  assert.ok(!workflow.includes('sort -V'));
  const control = read('scripts/android-release-control.mjs');
  assert.ok(control.includes("locateAndroidTool('apksigner', env)"));
  assert.ok(control.includes("locateAndroidTool('aapt', env)"));
  assert.ok(!control.includes('readdir'));
});

test('upload receipts require the exact asset identity, bytes and GitHub API endpoint', () => {
  const bytes = Buffer.from('synthetic uploaded content');
  const name = 'tracklog-assist-debug.apk';
  const asset = { id: 100, name, state: 'uploaded', size: bytes.length,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    url: `https://api.github.com/repos/${REPOSITORY}/releases/assets/100` };
  assert.equal(validateUploadedAsset(asset, name, bytes).id, 100);
  for (const change of [{ id: -1 }, { name: 'other.apk' }, { state: 'new' }, { size: 0 },
    { digest: null }, { digest: `sha256:${'0'.repeat(64)}` }, { url: 'https://example.com/asset' }]) {
    assert.throws(() => validateUploadedAsset({ ...asset, ...change }, name, bytes));
  }
});

function recoveryFixture() {
  const controlSha = 'c'.repeat(40);
  const env = { GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main', GITHUB_SHA: controlSha, EXPECTED_SHA: controlSha,
    EXPECTED_TAG: RECOVERY.tag, EXPECTED_RECOVERY_RELEASE_ID: String(RECOVERY.releaseId),
    GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
  const expected = { ...context, tag: RECOVERY.tag, version: '0.1.78', versionCode: '76' };
  const target = validateContext(env, expected, RECOVERY.sha);
  const release = { id: RECOVERY.releaseId, tag_name: RECOVERY.tag, target_commitish: RECOVERY.sha,
    author: { login: RECOVERY.author }, draft: true, prerelease: false, assets: [] };
  const data = { release, main: controlSha, ciFailure: null, calls: [] };
  const api = async (path, request = {}) => {
    data.calls.push(path);
    assert.equal(request.method, undefined, 'recovery adoption must never create or mutate a release/tag');
    if (path === '/git/ref/heads/main') return { object: { type: 'commit', sha: data.main } };
    if (path === `/git/ref/tags/${RECOVERY.tag}`) return { object: { type: 'commit', sha: RECOVERY.sha } };
    if (path.startsWith('/actions/workflows/ci.yml/runs?')) {
      const head = new URL(`https://example.test${path}`).searchParams.get('head_sha');
      return { workflow_runs: [{ ...run, id: head === controlSha ? 33 : 22, head_sha: head,
        conclusion: data.ciFailure === head ? 'failure' : 'success' }] };
    }
    if (path.startsWith('/actions/runs/')) {
      const head = path.includes('/33/') ? controlSha : RECOVERY.sha;
      return { jobs: jobs.map(j => ({ ...j, head_sha: head })) };
    }
    if (path === `/releases/${RECOVERY.releaseId}`) return structuredClone(data.release);
    if (path.startsWith('/releases?')) return [oldRelease, structuredClone(data.release)];
    if (path.startsWith('/contents/android/gradle.properties')) return { encoding: 'base64', content: Buffer.from('tracklogVersionCode=74\n').toString('base64') };
    throw new Error(`Unexpected recovery read ${path}`);
  };
  return { target, expected, env, data, api };
}

test('recovery requires exact confirmed ID, source, tag, code and manual main control SHA', () => {
  const { env, expected } = recoveryFixture();
  for (const change of [{ EXPECTED_RECOVERY_RELEASE_ID: '1' }, { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REF: 'refs/heads/other' }, { EXPECTED_SHA: 'b'.repeat(40) }, { EXPECTED_TAG: 'v0.1.79' }]) {
    assert.throws(() => validateContext({ ...env, ...change }, expected, RECOVERY.sha));
  }
  assert.throws(() => validateContext(env, expected, 'b'.repeat(40)));
  assert.throws(() => validateContext(env, { ...expected, versionCode: '77' }, RECOVERY.sha));
});

test('recovery adopts only the explicitly approved empty draft without any POST', async () => {
  const { api, target, data } = recoveryFixture();
  const states = [];
  const state = await createCandidate(api, target, async s => states.push(s));
  assert.equal(state.releaseId, RECOVERY.releaseId);
  assert.equal(state.controlSha, target.controlSha);
  assert.equal(states.length, 1);
  assert.ok(data.calls.some(p => p.includes(`head_sha=${RECOVERY.sha}`)));
  assert.ok(data.calls.some(p => p.includes(`head_sha=${target.controlSha}`)));
  for (const change of [{ id: 1 }, { draft: false }, { prerelease: true }, { tag_name: 'v0.1.77' },
    { target_commitish: 'b'.repeat(40) }, { author: { login: 'other' } }, { assets: [{ id: 1 }] }]) {
    assert.throws(() => validateRecoveryDraft({ ...data.release, ...change }, target));
  }
});

test('recovery stops on either CI failure, moved control main or populated draft', async () => {
  for (const failure of ['source', 'control', 'main', 'assets']) {
    const { api, target, data } = recoveryFixture();
    if (failure === 'source') data.ciFailure = RECOVERY.sha;
    if (failure === 'control') data.ciFailure = target.controlSha;
    if (failure === 'main') data.main = 'd'.repeat(40);
    if (failure === 'assets') data.release.assets = [{ id: 1 }];
    let saved = false;
    await assert.rejects(createCandidate(api, target, async () => { saved = true; }));
    assert.equal(saved, false);
  }
});

test('recovery workflow preserves reviewed controls before checking out the fixed build source', () => {
  const w = read('.github/workflows/android-release.yml');
  assert.ok(w.indexOf('Preserve reviewed release controls') < w.indexOf('Checkout exact approved recovery source'));
  assert.ok(w.includes(`git checkout --detach ${RECOVERY.sha}`));
  assert.ok(w.includes('node "$RUNNER_TEMP/tracklog-release-controls/android-release-control.mjs" preflight'));
  assert.ok(w.indexOf('Preserve signed APK and checksum') < w.indexOf('Create draft GitHub Release'));
  assert.ok(w.includes('actions/upload-artifact@v4'));
});
