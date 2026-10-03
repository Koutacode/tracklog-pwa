import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { publishRelease, productionClient } from './publish-android-release.mjs';
import { releaseTargets, removableAssets, SOURCE_REPOSITORY as source, DISTRIBUTION_REPOSITORY as dist, APK_NAME } from './release-targets.mjs';

const pkg = { version: '0.1.67', tracklogRelease: { githubOwner: 'Koutacode', githubRepo: 'tracklog-releases', apkAssetName: APK_NAME, migrationPhase: 'bridge' } };
function fixture(failures = []) {
  const calls = [];
  const client = Object.fromEntries(['preflight', 'createDraft', 'upload', 'verifyDraft', 'publish', 'verifyLatest', 'rollback', 'cleanup'].map(method => [method, async repo => {
    const key = `${method}:${repo}`;
    calls.push(key);
    if (failures.includes(key)) throw new Error(key);
    if (method === 'createDraft') return { id: 100, draft: true, tag_name: 'v0.1.67' };
  }]));
  return { calls, client };
}
test('bridge verifies new public latest before publishing identical bytes to legacy, then cleans only new repo', async () => {
  const { calls, client } = fixture();
  await publishRelease(pkg, client);
  assert.deepEqual(calls, [
    `preflight:${dist}`, `preflight:${source}`,
    ...[dist, source].flatMap(repo => ['createDraft', 'upload', 'verifyDraft', 'publish', 'verifyLatest'].map(method => `${method}:${repo}`)),
    `cleanup:${dist}`,
  ]);
});
for (const method of ['preflight', 'upload', 'verifyDraft', 'publish', 'verifyLatest']) {
  test(`${method} failure preserves legacy latest and prevents cleanup`, async () => {
    const { calls, client } = fixture([`${method}:${dist}`]);
    await assert.rejects(publishRelease(pkg, client));
    assert.ok(!calls.includes(`createDraft:${source}`));
    assert.ok(!calls.includes(`cleanup:${dist}`));
    assert.equal(calls.includes(`rollback:${dist}`), ['publish', 'verifyLatest'].includes(method));
  });
}
test('legacy publication failure rolls back only legacy; verified distribution stays public', async () => {
  const { calls, client } = fixture([`verifyLatest:${source}`]);
  await assert.rejects(publishRelease(pkg, client), /returned to draft/);
  assert.ok(calls.includes(`rollback:${source}`));
  assert.ok(!calls.includes(`rollback:${dist}`));
  assert.ok(!calls.includes(`cleanup:${dist}`));
});
test('rollback failure is critical, never claimed to be restored', async () => {
  const { client } = fixture([`publish:${dist}`, `rollback:${dist}`]);
  await assert.rejects(publishRelease(pkg, client), /CRITICAL.*manual recovery/);
});
test('cleanup failure does not unpublish latest after partial deletion', async () => {
  const { client, calls } = fixture([`cleanup:${dist}`]);
  await assert.rejects(publishRelease(pkg, client));
  assert.ok(!calls.some(value => value.startsWith('rollback:')));
});
test('distribution phase never accesses legacy repo', async () => {
  const { client, calls } = fixture();
  await publishRelease({ ...pkg, tracklogRelease: { ...pkg.tracklogRelease, migrationPhase: 'distribution' } }, client);
  assert.ok(!calls.some(value => value.endsWith(source)));
});
test('cleanup excludes current, draft, non-APK assets and ALL legacy assets', () => {
  const releases = [
    { tag_name: 'v1', assets: [{ id: 1, name: APK_NAME }, { id: 2, name: `${APK_NAME}.sha256` }, { id: 3, name: 'notes.txt' }] },
    { tag_name: 'v2', assets: [{ id: 4, name: APK_NAME }] },
    { tag_name: 'v3', draft: true, assets: [{ id: 5, name: APK_NAME }] },
  ];
  assert.deepEqual(removableAssets(releases, 'v2', source), []);
  assert.deepEqual(removableAssets(releases, 'v2', dist).map(a => a.id), [1, 2]);
});
test('unreviewed repository, phase or asset cannot be published', () => {
  for (const override of [{ githubRepo: 'other' }, { migrationPhase: 'oops' }, { apkAssetName: 'other.apk' }]) {
    assert.throws(() => releaseTargets({ ...pkg, tracklogRelease: { ...pkg.tracklogRelease, ...override } }));
  }
});
test('JS configuration and exact native URL remain aligned; token only enters publication step', () => {
  const real = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  releaseTargets(real);
  const native = readFileSync(new URL('../android/app/src/main/java/com/tracklog/assist/AppUpdatePlugin.java', import.meta.url), 'utf8');
  assert.ok(native.includes(`https://github.com/${dist}/releases/latest/download/${APK_NAME}`));
  const workflow = readFileSync(new URL('../.github/workflows/android-release.yml', import.meta.url), 'utf8');
  assert.equal((workflow.match(/secrets\.TRACKLOG_DISTRIBUTION_TOKEN/g) ?? []).length, 2, 'only presence check and publish step reference the secret');
  assert.ok(workflow.includes('node scripts/publish-android-release.mjs'));
});

test('PAT is injected only for publication with no App/default credential fallback', () => {
  const workflow = readFileSync(new URL('../.github/workflows/android-release.yml', import.meta.url), 'utf8');
  const publish = workflow.split('      - name: Publish and verify distribution then legacy bridge\n')[1];
  assert.match(publish, /timeout-minutes: 45/);
  assert.match(publish, /DISTRIBUTION_RELEASE_TOKEN: \$\{\{ secrets\.TRACKLOG_DISTRIBUTION_TOKEN \}\}/);
  assert.doesNotMatch(publish, /\|\||continue-on-error|if:/);
  assert.doesNotMatch(workflow, /create-github-app-token|TRACKLOG_DISTRIBUTION_APP_|distribution-app-token/);
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(ci, /TRACKLOG_DISTRIBUTION_TOKEN|create-github-app-token|APP_PRIVATE_KEY|publish-android-release\.mjs/);
});

test('PAT configuration preflight rejects absent inputs without requiring any real secrets', () => {
  const workflow = readFileSync(new URL('../.github/workflows/android-release.yml', import.meta.url), 'utf8');
  const check = workflow.split('      - name: Validate distribution PAT configuration\n')[1].split('      - name: Set up JDK 21')[0];
  assert.match(check, /DISTRIBUTION_PAT_CONFIGURED: \$\{\{ secrets\.TRACKLOG_DISTRIBUTION_TOKEN != '' \}\}/);
  const script = check.split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
  for (const [configured, expectedStatus] of [['false', 1], ['', 1], ['TRUE', 1], ['synthetic-token', 1], ['true', 0]]) {
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: {
      PATH: process.env.PATH, DISTRIBUTION_PAT_CONFIGURED: configured,
    } });
    assert.equal(result.status, expectedStatus);
    assert.ok(!(result.stdout + result.stderr).includes('synthetic-token'), 'input values are never logged');
  }
});

test('production adapter routes authenticated writes, clean target, anonymous downloads and cleanup correctly', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tracklog-publish-adapter-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('Synthetic APK bytes, no secrets');
  const sidecar = `${createHash('sha256').update(bytes).digest('hex')}  ${APK_NAME}\n`;
  writeFileSync(join(directory, APK_NAME), bytes);
  writeFileSync(join(directory, `${APK_NAME}.sha256`), sidecar);
  const old = () => ({ id: 1, tag_name: 'v0.1.66', draft: false, prerelease: false, assets: [{ id: 2, name: APK_NAME }, { id: 3, name: `${APK_NAME}.sha256` }] });
  const state = new Map([dist, source].map(repo => [repo, { releases: [old()], latest: 1 }]));
  const calls = [];
  const execute = (command, args, options) => {
    calls.push({ command, args });
    if (command === 'curl') {
      assert.ok(!args.includes('--header'), 'public verification has no auth headers');
      const url = args.at(-1);
      const repo = url.includes(`/${dist}/`) ? dist : source;
      if (args.includes('--output')) {
        writeFileSync(args[args.indexOf('--output') + 1], url.endsWith('.sha256') ? sidecar : bytes);
        return '';
      }
      return JSON.stringify(state.get(repo).releases.find(r => r.id === state.get(repo).latest));
    }
    assert.equal(command, 'gh');
    const repo = args.includes('--repo') ? args[args.indexOf('--repo') + 1] : args.find(arg => arg.startsWith('repos/')).split('/').slice(1, 3).join('/');
    assert.equal(options.env.GH_TOKEN, repo === dist ? 'synthetic-dist-token' : 'synthetic-source-token');
    const item = state.get(repo);
    if (args[0] === 'release') {
      if (args[1] === 'create') {
        assert.equal(args[args.indexOf('--target') + 1], (repo === dist ? 'b' : 'a').repeat(40));
        assert.ok(!args.includes('--generate-notes'));
        item.releases.push({ id: 100, tag_name: args[2], draft: true, prerelease: false, assets: [] });
      } else if (args[1] === 'download') {
        const dest = args[args.indexOf('--dir') + 1];
        writeFileSync(join(dest, APK_NAME), bytes);
        writeFileSync(join(dest, `${APK_NAME}.sha256`), sidecar);
      } else if (args[1] === 'upload') {
        assert.deepEqual(readFileSync(args[3]), bytes);
        assert.equal(readFileSync(args[4], 'utf8'), sidecar);
      } else assert.fail(`Unexpected release operation: ${args[1]}`);
      return '';
    }
    const path = args.find(arg => arg.startsWith('repos/')).slice(`repos/${repo}`.length);
    if (!path) return JSON.stringify({ private: false, archived: false, permissions: { push: true }, default_branch: 'main' });
    if (path.startsWith('/commits/')) return JSON.stringify({ sha: (repo === dist ? 'b' : 'a').repeat(40) });
    if (path.startsWith('/releases?')) return JSON.stringify([item.releases]);
    if (path === '/releases/latest') return JSON.stringify(item.releases.find(r => r.id === item.latest));
    if (path.startsWith('/releases/assets/')) {
      assert.equal(repo, dist, 'legacy APKs must never be deleted');
      assert.ok(args.includes('DELETE'));
      const id = Number(path.split('/').at(-1));
      for (const release of item.releases) release.assets = release.assets.filter(a => a.id !== id);
      return '';
    }
    const release = item.releases.find(r => r.id === Number(path.split('/').at(-1)));
    assert.ok(release);
    if (args.includes('draft=false')) release.draft = false;
    if (args.includes('draft=true')) release.draft = true;
    if (args.includes('make_latest=true')) item.latest = release.id;
    return JSON.stringify(release);
  };
  const client = productionClient({ execute, artifactDirectory: directory, environment: {
    SOURCE_RELEASE_TOKEN: 'synthetic-source-token', DISTRIBUTION_RELEASE_TOKEN: 'synthetic-dist-token', GITHUB_SHA: 'a'.repeat(40),
  } });
  await publishRelease(pkg, client);
  assert.equal(state.get(source).releases[0].assets.length, 2);
  assert.equal(state.get(dist).releases[0].assets.length, 0);
  assert.equal(calls.filter(c => c.command === 'curl').length, 6);
  await client.rollback(source, 100);
  assert.equal(state.get(source).latest, 1, 'rollback restores previous latest by ID');
  assert.equal(state.get(source).releases[1].draft, true);
  await assert.rejects(async () => productionClient({ execute: () => assert.fail('must not invoke gh'), artifactDirectory: directory, environment: {} }).preflight(dist, 'v0.1.67'), /Missing release credential/);
  await assert.rejects(async () => productionClient({ execute: () => assert.fail('must not invoke gh'), artifactDirectory: directory, environment: {
    SOURCE_RELEASE_TOKEN: 'synthetic-source-token', GH_TOKEN: 'synthetic-default-token', TRACKLOG_DISTRIBUTION_TOKEN: 'synthetic-old-pat',
  } }).preflight(dist, 'v0.1.67'), /Missing release credential/, 'missing publication credential cannot fall back to another credential');
});
