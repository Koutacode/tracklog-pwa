import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// Public certificate fingerprint pinned by the existing Android Release workflow.
// A local debug keystore or APK must never establish the company distribution signer.
export const OFFICIAL_SIGNER_SHA256 = '14121cbf70043af3bd2fe17dd57833ed51b7f5dbf326459dde6b830f07cbb99c';
const OWNER = 'Koutacode';
const REPOSITORY = 'tracklog-releases';
const ASSET_NAME = 'tracklog-assist-debug.apk';
const PACKAGE_NAME = 'com.tracklog.assist';
const execute = promisify(execFile);

function requireMatch(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, received ${actual}`);
}

export async function readExpectedRelease(projectRoot) {
  const pkg = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  const props = await readFile(join(projectRoot, 'android/gradle.properties'), 'utf8');
  const version = pkg.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('package.json version is invalid');
  }
  const versionName = props.match(/^tracklogVersionName=(.+)$/m)?.[1].trim();
  const versionCode = props.match(/^tracklogVersionCode=(.+)$/m)?.[1].trim();
  requireMatch(versionName, version, 'Android versionName / package.json version');
  if (!/^[1-9]\d*$/.test(versionCode ?? '') || !Number.isSafeInteger(Number(versionCode))) {
    throw new Error('Android versionCode is invalid');
  }
  for (const [key, value] of Object.entries({ githubOwner: OWNER, githubRepo: REPOSITORY, apkAssetName: ASSET_NAME })) {
    requireMatch(pkg.tracklogRelease?.[key] ?? value, value, `tracklogRelease.${key}`);
  }
  return { version, versionCode, tag: `v${version}`, packageName: PACKAGE_NAME, assetName: ASSET_NAME };
}

export function validateRelease(release, expected) {
  requireMatch(release?.tag_name, expected.tag, 'GitHub release tag');
  requireMatch(release.draft, false, 'GitHub release draft');
  requireMatch(release.prerelease, false, 'GitHub release prerelease');
  if (!Number.isSafeInteger(release.id) || release.id <= 0) throw new Error('GitHub release ID is invalid');
  const assets = [expected.assetName, `${expected.assetName}.sha256`].map(name => {
    const matches = release.assets?.filter(asset => asset.name === name) ?? [];
    if (matches.length !== 1) throw new Error(`Expected exactly one release asset: ${name}`);
    const asset = matches[0];
    if (!Number.isSafeInteger(asset.id) || asset.id <= 0 || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
      throw new Error(`Invalid release asset ID or size: ${name}`);
    }
    requireMatch(asset.state, 'uploaded', `Release asset state (${name})`);
    requireMatch(asset.browser_download_url, `https://github.com/${OWNER}/${expected.repository ?? REPOSITORY}/releases/download/${encodeURIComponent(expected.tag)}/${name}`, `Release asset URL (${name})`);
    if (asset.digest != null && !/^sha256:[0-9a-f]{64}$/i.test(asset.digest)) {
      throw new Error(`Invalid release asset SHA-256 digest: ${name}`);
    }
    return { id: asset.id, name, size: asset.size, digest: asset.digest?.toLowerCase() ?? null };
  });
  return { id: release.id, tag: release.tag_name, assets };
}

export function parseManifest(badging) {
  const lines = badging.split(/\r?\n/).filter(line => line.startsWith('package:'));
  if (lines.length !== 1) throw new Error('aapt must report exactly one package line');
  const field = name => {
    const matches = [...lines[0].matchAll(new RegExp(`(?:^|\\s)${name}='([^']*)'`, 'g'))];
    if (matches.length !== 1) throw new Error(`aapt package field is missing or ambiguous: ${name}`);
    return matches[0][1];
  };
  return { packageName: field('name'), versionName: field('versionName'), versionCode: field('versionCode') };
}

export function parseSigner(output) {
  const matches = [...output.matchAll(/^Signer #\d+ certificate SHA-256 digest:\s*([0-9a-f:]+)\s*$/gim)];
  if (matches.length !== 1) throw new Error(`Expected exactly one APK signer, received ${matches.length}`);
  const digest = matches[0][1].replaceAll(':', '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('Invalid APK signer certificate SHA-256 digest');
  requireMatch(digest, OFFICIAL_SIGNER_SHA256, 'Official APK signer SHA-256');
  return digest;
}

export function parseSidecar(text, assetName) {
  const match = /^([0-9a-f]{64})[ \t]+\*?([^\r\n]+)$/i.exec(text.trim());
  if (!match) throw new Error('Invalid APK SHA-256 sidecar');
  requireMatch(match[2], assetName, 'SHA-256 sidecar filename');
  return match[1].toLowerCase();
}

async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function runCommand(command, args) {
  try {
    const { stdout } = await execute(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 180_000 });
    return stdout;
  } catch (error) {
    // Do not echo inherited credentials or full tool output on failure.
    throw new Error(`${command} failed (${error.code ?? error.signal ?? 'unknown'}); APK verification was not completed`);
  }
}

async function locateAndroidTool(name, env) {
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try SDK paths. */ }
  }
  const sdkRoots = [...new Set([env.ANDROID_HOME, env.ANDROID_SDK_ROOT].filter(Boolean))];
  for (const root of sdkRoots) {
    let versions;
    try { versions = await readdir(join(root, 'build-tools')); } catch { continue; }
    versions.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
    for (const version of versions) {
      const candidate = join(root, 'build-tools', version, name);
      try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try next version. */ }
    }
  }
  throw new Error(`${name} was not found; install Android SDK Build-Tools and set ANDROID_HOME or ANDROID_SDK_ROOT`);
}

async function defaultTools() {
  const [aapt, apksigner] = await Promise.all([
    locateAndroidTool('aapt', process.env),
    locateAndroidTool('apksigner', process.env),
  ]);
  return {
    manifest: path => runCommand(aapt, ['dump', 'badging', path]),
    signer: path => runCommand(apksigner, ['verify', '--print-certs', path]),
    embeddedVersion: path => runCommand('unzip', ['-p', path, 'assets/public/version.json']),
  };
}

const curlArguments = ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '15', '--max-time', '120'];

async function fetchPublicRelease(selector, repository = REPOSITORY) {
  const json = await runCommand('curl', [...curlArguments, '--header', 'Accept: application/vnd.github+json', '--header', 'X-GitHub-Api-Version: 2022-11-28', '--user-agent', 'TrackLog-release-verifier', `https://api.github.com/repos/${OWNER}/${repository}/releases/${selector}`]);
  return JSON.parse(json);
}

async function downloadPublicAsset(url, path) {
  await runCommand('curl', [...curlArguments, '--output', path, url]);
}

async function saveVerifiedArtifacts({ projectRoot, apkPath, sidecarPath, sha256, sizeBytes, sidecarBytes, confirmLatest, fileOperations }) {
  const outputDirectory = join(resolve(projectRoot), 'output');
  await mkdir(outputDirectory, { recursive: true });
  if (!(await lstat(outputDirectory)).isDirectory()) throw new Error('APK output must be a real directory');
  // Staging must share the output filesystem for atomic per-file rename.
  // A pair of files cannot be replaced in one atomic operation: ordinary errors
  // roll back both, while an interrupted process can require manual recovery.
  const stage = await mkdtemp(join(outputDirectory, '.tracklog-release-apk-'));
  let retainRecovery = false;
  const files = [
    { source: apkPath, destination: join(outputDirectory, ASSET_NAME), staged: join(stage, ASSET_NAME), backup: join(stage, `${ASSET_NAME}.previous`) },
    { source: sidecarPath, destination: join(outputDirectory, `${ASSET_NAME}.sha256`), staged: join(stage, `${ASSET_NAME}.sha256`), backup: join(stage, `${ASSET_NAME}.sha256.previous`) },
  ];
  try {
    for (const file of files) {
      await fileOperations.copyFile(file.source, file.staged, constants.COPYFILE_EXCL);
      let current;
      try { current = await lstat(file.destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current && !current.isFile()) throw new Error('Existing APK output must be a regular file');
      file.existed = Boolean(current);
      if (file.existed) await fileOperations.copyFile(file.destination, file.backup, constants.COPYFILE_EXCL);
    }
    // Re-hash the actual staged bytes after all inspectors/copies. Never publish
    // bytes that changed after the first download verification.
    requireMatch((await stat(files[0].staged)).size, sizeBytes, 'Saved APK size');
    requireMatch(await fileSha256(files[0].staged), sha256, 'Saved APK SHA-256');
    requireMatch((await readFile(files[1].staged)).equals(sidecarBytes), true, 'Saved SHA-256 sidecar bytes');
    await confirmLatest();
    try {
      for (const file of files) {
        await fileOperations.rename(file.staged, file.destination);
        file.published = true;
      }
    } catch (error) {
      const recoveryErrors = [];
      for (const file of files.toReversed()) {
        if (!file.published) continue;
        try {
          if (file.existed) await fileOperations.rename(file.backup, file.destination);
          else await rm(file.destination);
        } catch (recoveryError) { recoveryErrors.push(recoveryError); }
      }
      if (recoveryErrors.length) {
        retainRecovery = true;
        throw new Error(`APK save rollback was incomplete; recovery files retained at ${stage}`);
      }
      throw error;
    }
    return { outputPath: files[0].destination, sidecarPath: files[1].destination, sizeBytes, fileUri: pathToFileURL(files[0].destination).href };
  } finally {
    if (!retainRecovery) await rm(stage, { recursive: true, force: true });
  }
}

// Transports and inspectors are injectable for offline tests; the CLI always uses
// HTTPS GitHub downloads and real Android tools, with no "skip verification" mode.
export async function verifyLatestRelease({
  projectRoot,
  fetchRelease,
  repository = REPOSITORY,
  download = downloadPublicAsset,
  tools,
  save = false,
  fileOperations = { copyFile, rename },
}) {
  if (![REPOSITORY, 'tracklog-pwa'].includes(repository)) throw new Error('Unreviewed release repository');
  const expected = { ...await readExpectedRelease(projectRoot), repository };
  fetchRelease ??= selector => fetchPublicRelease(selector, repository);
  const inspectors = tools ?? await defaultTools();
  const latest = validateRelease(await fetchRelease('latest'), expected);
  const tagged = validateRelease(await fetchRelease(`tags/${encodeURIComponent(expected.tag)}`), expected);
  requireMatch(JSON.stringify(tagged), JSON.stringify(latest), 'Latest / tag release assets');
  const workPath = await mkdtemp(join(tmpdir(), 'tracklog-release-apk-'));
  try {
    const apkPath = join(workPath, expected.assetName);
    const sidecarPath = `${apkPath}.sha256`;
    const downloadUrl = `https://github.com/${OWNER}/${repository}/releases/latest/download/${expected.assetName}`;
    await download(downloadUrl, apkPath);
    await download(`${downloadUrl}.sha256`, sidecarPath);
    const [apkInfo, sidecarInfo, sha256, sidecarBytes] = await Promise.all([
      stat(apkPath), stat(sidecarPath), fileSha256(apkPath), readFile(sidecarPath),
    ]);
    for (const [asset, size, hash] of [
      [latest.assets[0], apkInfo.size, sha256],
      [latest.assets[1], sidecarInfo.size, createHash('sha256').update(sidecarBytes).digest('hex')],
    ]) {
      requireMatch(size, asset.size, `Release asset size (${asset.name})`);
      if (asset.digest) requireMatch(`sha256:${hash}`, asset.digest, `GitHub asset digest (${asset.name})`);
    }
    requireMatch(sha256, parseSidecar(sidecarBytes.toString('utf8'), expected.assetName), 'APK / sidecar SHA-256');
    const [badging, signerOutput, embeddedText] = await Promise.all([
      inspectors.manifest(apkPath), inspectors.signer(apkPath), inspectors.embeddedVersion(apkPath),
    ]);
    const manifest = parseManifest(badging);
    for (const key of ['packageName', 'versionName', 'versionCode']) {
      requireMatch(manifest[key], key === 'versionName' ? expected.version : expected[key], `APK ${key}`);
    }
    const signerSha256 = parseSigner(signerOutput);
    const embedded = JSON.parse(embeddedText);
    requireMatch(embedded.version, expected.version, 'Embedded APK version');
    const latestAfterDownload = validateRelease(await fetchRelease('latest'), expected);
    requireMatch(JSON.stringify(latestAfterDownload), JSON.stringify(latest), 'Latest release changed during verification');
    const saved = save ? await saveVerifiedArtifacts({
      projectRoot, apkPath, sidecarPath, sha256, sizeBytes: apkInfo.size, sidecarBytes, fileOperations,
      confirmLatest: async () => {
        const current = validateRelease(await fetchRelease('latest'), expected);
        requireMatch(JSON.stringify(current), JSON.stringify(latest), 'Latest release changed before saving');
      },
    }) : {};
    return { tag: expected.tag, releaseId: latest.id, ...manifest, sha256, signerSha256, buildDate: embedded.buildDate ?? null, downloadUrl, ...saved };
  } finally {
    // Only this invocation's unique download directory is removed. Saving is
    // opt-in and never modifies device data or any public release.
    await rm(workPath, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log('公開latestの正式APKを検証します。Node.js 22、curl、unzip、Android Build-Tools (aapt/apksigner) とJavaが必要です。署名鍵・GitHubトークン不要。--legacy は移行中の旧repoを検証します。既定は読み取り検証のみ。--save は全検証成功後だけ同じAPKとSHA-256 sidecarを固定のoutputへ保存します。通常エラー時は既存2ファイルを復元します。2ファイル同時のatomic置換はできないため、プロセス中断・復元失敗時はoutput配下に残った専用一時フォルダーから手動復旧が必要です。');
  } else if (process.argv.slice(2).some(arg => !['--save', '--legacy'].includes(arg))) {
    console.error('Usage: node scripts/verify-latest-release-apk.mjs [--save] [--legacy] | --help');
    process.exitCode = 1;
  } else {
    try {
      const save = process.argv.includes('--save');
      const repository = process.argv.includes('--legacy') ? 'tracklog-pwa' : REPOSITORY;
      const result = await verifyLatestRelease({ projectRoot: fileURLToPath(new URL('..', import.meta.url)), save, repository });
      console.log(save ? '公開latest APKの検証とoutputへの保存に成功' : '公開latest APKの読み取り検証に成功（一時取得ファイルは削除済み）');
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(`公開APK検証失敗: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
