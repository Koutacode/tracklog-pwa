import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readExpectedRelease, parseManifest, parseSigner, runCommand, locateAndroidTool } from './verify-latest-release-apk.mjs';

export const REPOSITORY = 'Koutacode/tracklog-pwa';
const CI_JOBS = ['android-validation', 'temporary-workspaces', 'validate'];
const SHA = /^[0-9a-f]{40}$/;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (actual, expected, message) => assert.deepEqual(actual, expected, message);

export function validateContext(env, expected, checkoutSha) {
  same(env.GITHUB_REPOSITORY, REPOSITORY, 'Unexpected repository');
  assert.ok(SHA.test(env.GITHUB_SHA ?? ''), 'Invalid workflow SHA');
  same(checkoutSha, env.GITHUB_SHA, 'Checkout must be the workflow SHA');
  assert.ok(TAG.test(expected.tag), 'Only stable version tags are supported');
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    same(env.GITHUB_REF, 'refs/heads/main', 'Manual releases require main');
    assert.ok(SHA.test(env.EXPECTED_SHA ?? ''), 'Expected SHA must be a full lowercase SHA');
    same(env.EXPECTED_SHA, checkoutSha, 'Manual SHA confirmation mismatch');
    same(env.EXPECTED_TAG, expected.tag, 'Manual tag confirmation mismatch');
  } else {
    same(env.GITHUB_EVENT_NAME, 'push', 'Unsupported release event');
    same(env.GITHUB_REF, `refs/tags/${expected.tag}`, 'Push must be the exact version tag');
  }
  return { ...expected, sha: checkoutSha, event: env.GITHUB_EVENT_NAME,
    runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT };
}

export function validateCi(runs, jobs, context) {
  const run = runs[0]; // API order is newest first; a newer failed/pending run cannot be bypassed.
  assert.ok(run, 'No main CI run for this SHA');
  same(run.path, '.github/workflows/ci.yml', 'Unexpected CI workflow');
  same(run.head_repository?.full_name, REPOSITORY, 'Unexpected CI repository');
  same(run.head_sha, context.sha, 'CI SHA mismatch');
  same(run.head_branch, 'main', 'CI must run on main');
  same(run.event, 'push', 'CI must be a main push');
  same(run.status, 'completed', 'CI is not completed');
  same(run.conclusion, 'success', 'CI did not succeed');
  same(jobs.map(job => job.name).sort(), CI_JOBS, 'All three CI jobs are required');
  for (const job of jobs) {
    same(job.head_sha, context.sha, 'CI job SHA mismatch');
    same(job.run_attempt, run.run_attempt, 'CI job attempt mismatch');
    same(job.status, 'completed', 'CI job not completed');
    same(job.conclusion, 'success', 'CI job did not succeed');
  }
}

export function validateNewVersion(context, releases, previousProperties) {
  assert.ok(!releases.some(release => release.tag_name === context.tag), 'Release already exists (including drafts)');
  const versions = releases.filter(release => !release.draft && TAG.test(release.tag_name));
  assert.ok(versions.length > 0, 'Cannot establish previous published versions');
  const target = context.tag.slice(1).split('.').map(Number);
  for (const release of versions) {
    const parts = release.tag_name.slice(1).split('.').map(Number);
    const firstDifference = target.findIndex((value, i) => value !== parts[i]);
    assert.ok(firstDifference >= 0 && target[firstDifference] > parts[firstDifference], 'Version must exceed every published version');
    const props = previousProperties.get(release.tag_name);
    const previousCode = Number(props?.match(/^tracklogVersionCode=(\d+)\s*$/m)?.[1]);
    assert.ok(Number.isSafeInteger(previousCode) && previousCode > 0, 'Missing previous versionCode');
    assert.ok(Number(context.versionCode) > previousCode, 'versionCode must increase');
  }
}

// The token is used only on fixed GitHub endpoints. Public CI reads deliberately
// omit it: the existing contents:write permission does not grant actions:read.
export function githubClient(token, fetchImpl = fetch) {
  return async (path, { method = 'GET', body, publicRead = false, missing = false, binary = false } = {}) => {
    assert.ok(path.startsWith('/') && !path.includes('..'), 'Invalid API path');
    const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}${path}`, {
      method, redirect: binary ? 'follow' : 'error', signal: AbortSignal.timeout(120_000),
      headers: { Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(!publicRead ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (missing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    if (method === 'POST') same(response.status, 201, 'Creation must return HTTP 201');
    return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
  };
}

async function pages(api, path, key) {
  const result = [];
  for (let page = 1; ; page++) {
    const data = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
      { publicRead: Boolean(key) });
    const items = key ? data[key] : data;
    assert.ok(Array.isArray(items), 'Invalid paginated response');
    result.push(...items);
    if (items.length < 100) return result;
    assert.ok(page < 100, 'Pagination exceeded safe limit');
  }
}

export async function guardMainAndCi(api, context) {
  const main = await api('/git/ref/heads/main');
  same(main.object?.type, 'commit', 'main must resolve to a commit');
  same(main.object.sha, context.sha, 'main moved; stop and revalidate');
  const runs = await api(`/actions/workflows/ci.yml/runs?head_sha=${context.sha}&branch=main&event=push&per_page=1`, { publicRead: true });
  const run = runs.workflow_runs?.[0];
  assert.ok(Number.isSafeInteger(run?.id) && run.id > 0, 'No valid CI run');
  const jobs = await pages(api, `/actions/runs/${run.id}/jobs?filter=latest`, 'jobs');
  validateCi(runs.workflow_runs, jobs, context);
}

async function tagCommit(api, tag) {
  const ref = await api(`/git/ref/tags/${tag}`, { missing: true });
  if (!ref) return null;
  let object = ref.object;
  for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) {
    assert.ok(SHA.test(object.sha), 'Invalid annotated tag');
    object = (await api(`/git/tags/${object.sha}`)).object;
  }
  same(object?.type, 'commit', 'Tag must resolve to a commit');
  assert.ok(SHA.test(object.sha), 'Invalid tag commit');
  return object.sha;
}

export async function guardCandidate(api, context, { tagCreated = false, ownedReleaseId } = {}) {
  await guardMainAndCi(api, context);
  const tagSha = await tagCommit(api, context.tag);
  if (context.event === 'workflow_dispatch' && !tagCreated) same(tagSha, null, 'Manual release tag already exists');
  else same(tagSha, context.sha, 'Release tag SHA mismatch');
  const releases = await pages(api, '/releases');
  const others = releases.filter(release => release.id !== ownedReleaseId);
  if (ownedReleaseId) {
    same(releases.filter(release => release.id === ownedReleaseId).length, 1, 'Owned release missing');
  }
  const properties = new Map();
  for (const release of others.filter(release => !release.draft && TAG.test(release.tag_name))) {
    const file = await api(`/contents/android/gradle.properties?ref=${release.tag_name}`);
    same(file.encoding, 'base64', 'Cannot read previous version metadata');
    properties.set(release.tag_name, Buffer.from(file.content, 'base64').toString('utf8'));
  }
  validateNewVersion(context, others, properties);
}

export async function createCandidate(api, context, saveState) {
  await guardCandidate(api, context);
  if (context.event === 'workflow_dispatch') {
    await api('/git/refs', { method: 'POST', body: { ref: `refs/tags/${context.tag}`, sha: context.sha } });
    await saveState({ ...context, phase: 'tag-created' });
  }
  // Recheck after the tag mutation, including any competing release creation.
  await guardCandidate(api, context, { tagCreated: true });
  const release = await api('/releases', { method: 'POST', body: {
    tag_name: context.tag, target_commitish: context.sha, name: `Release ${context.tag}`,
    draft: true, prerelease: false, make_latest: 'false',
  } });
  assert.ok(Number.isSafeInteger(release.id) && release.id > 0, 'Invalid new release ID');
  const state = { ...context, releaseId: release.id, phase: 'draft-created' };
  await saveState(state); // Retain the exact ID even if subsequent verification/upload fails.
  validateDraft(release, state);
  return state;
}

export function validateDraft(release, state) {
  same(release.id, state.releaseId, 'Not the release created by this run');
  same(release.tag_name, state.tag, 'Draft tag mismatch');
  same(release.target_commitish, state.sha, 'Draft commit mismatch');
  same(release.draft, true, 'Release must remain draft');
  same(release.prerelease, false, 'Unexpected prerelease');
}

async function inspectApk(apk, sidecar, context, env) {
  const bytes = await readFile(apk);
  const sha256 = hash(bytes);
  same(await readFile(sidecar, 'utf8'), `${sha256}  ${context.assetName}\n`, 'APK checksum sidecar mismatch');
  const aapt = await locateAndroidTool('aapt', env);
  const apksigner = await locateAndroidTool('apksigner', env);
  same(parseManifest(await runCommand(aapt, ['dump', 'badging', apk])), {
    packageName: context.packageName, versionName: context.version, versionCode: context.versionCode,
  }, 'APK manifest mismatch');
  parseSigner(await runCommand(apksigner, ['verify', '--print-certs', apk]));
  const embedded = JSON.parse(await runCommand('unzip', ['-p', apk, 'assets/public/version.json']));
  same(embedded.version, context.version, 'Embedded update version mismatch');
  same(env.VITE_TRACKLOG_NATIVE_PUSH_ENABLED, 'true', 'Official build must retain native push');
  return { sha256, size: bytes.length };
}

export function validateUploadedAsset(asset, name, bytes) {
  assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0, 'Invalid asset ID');
  same(asset.name, name, 'Uploaded asset name mismatch');
  same(asset.state, 'uploaded', 'Incomplete asset');
  same(asset.url, `https://api.github.com/repos/${REPOSITORY}/releases/assets/${asset.id}`, 'Asset API URL mismatch');
  same(asset.size, bytes.length, 'Uploaded asset size mismatch');
  same(asset.digest, `sha256:${hash(bytes)}`, 'Uploaded asset digest mismatch');
  return { id: asset.id, name, size: asset.size, digest: asset.digest };
}

export function validateAssets(release, state) {
  const names = [state.assetName, `${state.assetName}.sha256`].sort();
  same(release.assets.map(asset => asset.name).sort(), names, 'Draft must have exactly APK and checksum');
  same(state.uploadedAssets?.map(asset => asset.name).sort(), names, 'Upload receipts missing');
  assert.equal(new Set(state.uploadedAssets.map(asset => asset.id)).size, 2, 'Duplicate uploaded asset ID');
  for (const asset of release.assets) {
    same(asset.state, 'uploaded', 'Incomplete asset');
    same(asset.url, `https://api.github.com/repos/${REPOSITORY}/releases/assets/${asset.id}`, 'Asset API URL mismatch');
    // Draft browser URLs may contain GitHub's temporary untagged-* identifier.
    // They are never followed. Download only the API ID recorded on upload;
    // the existing public verifier enforces the final tagged and latest URLs.
    const receipt = state.uploadedAssets.find(item => item.name === asset.name);
    same({ id: asset.id, name: asset.name, size: asset.size, digest: asset.digest }, receipt, 'Draft asset differs from upload receipt');
  }
  return release.assets.map(({ id, name, size, digest }) => ({ id, name, size, digest })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function verifyDraft(api, context, state, env, inspect = inspectApk) {
  validateDraft(await api(`/releases/${state.releaseId}`), state);
  await guardCandidate(api, context, { tagCreated: true, ownedReleaseId: state.releaseId });
  const release = await api(`/releases/${state.releaseId}`);
  validateDraft(release, state);
  const assets = validateAssets(release, state);
  const dir = await mkdtemp(join(env.RUNNER_TEMP, 'tracklog-draft-'));
  try {
    for (const asset of assets) {
      const bytes = await api(`/releases/assets/${asset.id}`, { binary: true });
      same(bytes.length, asset.size, 'Downloaded asset size mismatch');
      same(asset.digest, `sha256:${hash(bytes)}`, 'GitHub asset checksum mismatch');
      await writeFile(join(dir, asset.name), bytes, { flag: 'wx' });
    }
    const verified = await inspect(join(dir, state.assetName), join(dir, `${state.assetName}.sha256`), context, env);
    same(verified, state.built, 'Draft APK differs from the verified build');
    const finalRelease = await api(`/releases/${state.releaseId}`);
    validateDraft(finalRelease, state);
    same(validateAssets(finalRelease, state), assets, 'Draft assets changed during verification');
    same(await tagCommit(api, context.tag), context.sha, 'Release tag moved during verification');
    await guardMainAndCi(api, context);
    return { ...state, assets, phase: 'verified' };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function reportRetainedState(api, context, state) {
  const summary = { tag: context.tag, sha: context.sha, localPhase: state?.phase ?? 'no-local-state',
    recordedReleaseId: state?.releaseId ?? null, remoteTag: 'unknown', remoteReleases: 'unknown' };
  // Read only: a timed-out POST may have succeeded. Never adopt a remotely found ID.
  try { summary.remoteTag = await tagCommit(api, context.tag); }
  catch { summary.tagReadError = 'GitHub tag state could not be confirmed'; }
  try {
    summary.remoteReleases = (await pages(api, '/releases')).filter(r => r.tag_name === context.tag)
      .map(r => ({ id: r.id, draft: r.draft, prerelease: r.prerelease,
        ownership: r.id === state?.releaseId ? 'recorded-by-this-run' : 'unconfirmed',
        assets: (r.assets ?? []).map(a => ({ id: a.id, name: a.name, size: a.size })) }));
  } catch { summary.releaseReadError = 'GitHub release state could not be confirmed'; }
  return summary;
}

export async function main(command, env = process.env) {
  const expected = await readExpectedRelease(process.cwd());
  if (command === 'report') {
    same(env.GITHUB_REPOSITORY, REPOSITORY, 'Unexpected repository');
    assert.ok(SHA.test(env.GITHUB_SHA ?? '') && TAG.test(expected.tag), 'Invalid report target');
    let state;
    try {
      state = JSON.parse(await readFile(join(env.RUNNER_TEMP, 'tracklog-release-state.json'), 'utf8'));
      if (state.runId !== env.GITHUB_RUN_ID || state.attempt !== env.GITHUB_RUN_ATTEMPT) state = undefined;
    } catch { /* Preflight can fail before a state file exists. Report remote state independently. */ }
    console.log(JSON.stringify(await reportRetainedState(githubClient(env.GH_TOKEN),
      { ...expected, sha: env.GITHUB_SHA }, state)));
    console.log('No tag, draft or asset was deleted. Unknown ownership is not permission to reuse an ID; inspect before recovery.');
    return;
  }
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  same([lock.version, lock.packages[''].version], [expected.version, expected.version], 'Lockfile version mismatch');
  const context = validateContext(env, expected, (await runCommand('git', ['rev-parse', 'HEAD'])).trim());
  assert.ok(/^\d+$/.test(context.runId ?? '') && /^\d+$/.test(context.attempt ?? ''), 'Invalid run identity');
  assert.ok(env.GH_TOKEN, 'Existing GITHUB_TOKEN is required');
  const api = githubClient(env.GH_TOKEN);
  const statePath = join(env.RUNNER_TEMP, 'tracklog-release-state.json');
  const saveState = state => writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  if (command === 'preflight') {
    await guardCandidate(api, context);
    await writeFile(statePath, JSON.stringify({ ...context, phase: 'preflight' }), { flag: 'wx', mode: 0o600 });
    await appendFile(env.GITHUB_ENV, `TRACKLOG_RELEASE_TAG=${context.tag}\n`);
    console.log(`Preflight passed: ${context.tag} at ${context.sha}`);
    return;
  }
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  for (const key of Object.keys(context)) same(state[key], context[key], `Release state mismatch: ${key}`);
  if (command === 'create-draft') {
    same(state.phase, 'preflight', 'Release creation is not repeatable');
    const built = await inspectApk(context.assetName, `${context.assetName}.sha256`, context, env);
    const created = await createCandidate(api, context, saveState);
    const uploadedAssets = [];
    await saveState({ ...created, built, uploadedAssets });
    await appendFile(env.GITHUB_ENV, `TRACKLOG_RELEASE_ID=${created.releaseId}\n`);
    // Upload to the newly created ID only. No lookup-by-tag, replacement or deletion.
    for (const name of [context.assetName, `${context.assetName}.sha256`]) {
      const bytes = await readFile(name);
      const response = await fetch(`https://uploads.github.com/repos/${REPOSITORY}/releases/${created.releaseId}/assets?name=${encodeURIComponent(name)}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
        headers: { Authorization: `Bearer ${env.GH_TOKEN}`, 'Content-Type': 'application/octet-stream' },
        body: bytes,
      });
      same(response.status, 201, 'New asset upload failed; draft retained');
      uploadedAssets.push(validateUploadedAsset(await response.json(), name, bytes));
      await saveState({ ...created, built, uploadedAssets });
    }
  } else if (command === 'verify-draft') {
    same(state.phase, 'draft-created', 'Draft not created by this run');
    await saveState(await verifyDraft(api, context, state, env));
  } else if (command === 'publication-check') {
    same(state.phase, 'verified', 'Draft verification must succeed before publication');
    same(env.TRACKLOG_RELEASE_ID, String(state.releaseId), 'Publication ID mismatch');
    const checked = await verifyDraft(api, context, state, env);
    same(checked.assets, state.assets, 'Draft assets changed after verification');
  } else throw new Error('Unknown release-control command');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
