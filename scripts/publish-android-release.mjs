import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APK_NAME, DISTRIBUTION_REPOSITORY, SOURCE_REPOSITORY, releaseTargets, removableAssets } from './release-targets.mjs';

// The injected client lets failure paths run offline, without publishing artifacts.
export async function publishRelease(pkg, client) {
  const targets = releaseTargets(pkg);
  const tag = `v${pkg.version}`;
  // Fail before any writes if either destination/credential is not ready.
  for (const repo of targets) await client.preflight(repo, tag);
  for (const repo of targets) {
    const release = await client.createDraft(repo, tag);
    if (!release.draft || release.tag_name !== tag || !Number.isSafeInteger(release.id)) {
      throw new Error(`Expected a unique draft in ${repo}`);
    }
    // A failed upload or draft check leaves a draft and preserves the old latest.
    await client.upload(repo, tag);
    await client.verifyDraft(repo, tag);
    try {
      await client.publish(repo, release.id);
      await client.verifyLatest(repo, tag);
    } catch (error) {
      try {
        await client.rollback(repo, release.id);
      } catch {
        throw new Error(`CRITICAL: rollback not verified for ${repo} release ${release.id}; manual recovery required`);
      }
      throw new Error(`Publication failed; ${repo} release ${release.id} returned to draft`, { cause: error });
    }
  }
  // Only after all latest URLs pass. Cleanup failure must never unpublish a good
  // latest after older fallback assets have already been partially deleted.
  await client.cleanup(DISTRIBUTION_REPOSITORY, tag);
}

export function productionClient({ execute = execFileSync, environment = process.env, artifactDirectory = '.' } = {}) {
  const apkPath = join(artifactDirectory, APK_NAME);
  const apk = readFileSync(apkPath);
  const sha = createHash('sha256').update(apk).digest('hex');
  const sidecar = `${sha}  ${APK_NAME}\n`;
  if (readFileSync(`${apkPath}.sha256`, 'utf8') !== sidecar) throw new Error('Invalid built APK sidecar');
  const targets = new Map();
  const previousLatest = new Map();
  const gh = (repo, args) => {
    const token = repo === SOURCE_REPOSITORY ? environment.SOURCE_RELEASE_TOKEN : environment.DISTRIBUTION_RELEASE_TOKEN;
    if (!token) throw new Error(`Missing release credential for ${repo}`);
    try {
      return execute('gh', args, {
        encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
        env: { ...environment, GH_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      // Never echo tool output, command environments, or credential values.
      throw new Error(`GitHub operation failed for ${repo}`);
    }
  };
  const api = (repo, path, args = []) => JSON.parse(gh(repo, ['api', `repos/${repo}/${path}`, ...args]) || 'null');
  const list = repo => JSON.parse(gh(repo, ['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`])).flat();
  const retry = async (action, count = 6) => {
    for (let attempt = 1; ; attempt++) {
      try { return await action(); } catch (error) {
        if (attempt >= count) throw error;
        await new Promise(resolve => setTimeout(resolve, attempt * 2000));
      }
    }
  };
  const verifyBytes = directory => {
    if (createHash('sha256').update(readFileSync(join(directory, APK_NAME))).digest('hex') !== sha
        || readFileSync(join(directory, `${APK_NAME}.sha256`), 'utf8') !== sidecar) {
      throw new Error('Downloaded APK/checksum differs from verified build');
    }
  };
  const withTemp = action => {
    const directory = mkdtempSync(join(tmpdir(), 'tracklog-publish-'));
    try { return action(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
  };
  return {
    preflight(repo, tag) {
      const info = JSON.parse(gh(repo, ['api', `repos/${repo}`]));
      if (info.private || info.archived || !info.permissions?.push) throw new Error(`Public writable repository required: ${repo}`);
      // Never republish/overwrite an already public release on a rerun.
      const releases = list(repo);
      const matches = releases.filter(release => release.tag_name === tag);
      if (releases.some(release => !release.draft && !release.prerelease)) previousLatest.set(repo, api(repo, 'releases/latest'));
      if (matches.some(release => (release.assets ?? []).some(asset => ![APK_NAME, `${APK_NAME}.sha256`].includes(asset.name)))) {
        throw new Error('Unexpected draft assets; manual review required');
      }
      if (matches.length > 1 || matches.some(release => !release.draft)) throw new Error(`Tag already published in ${repo}; use a new version`);
      const target = repo === SOURCE_REPOSITORY ? environment.GITHUB_SHA : info.default_branch;
      if (!target) throw new Error('Missing release target');
      // Resolve a real clean-repo commit. Source SHA/history is never pushed to it.
      const commit = api(repo, `commits/${encodeURIComponent(target)}`);
      if (!/^[0-9a-f]{40}$/.test(commit.sha)) throw new Error('Invalid target commit');
      targets.set(repo, commit.sha);
    },
    createDraft(repo, tag) {
      let release = list(repo).find(value => value.tag_name === tag);
      if (!release) {
        gh(repo, ['release', 'create', tag, '--repo', repo, '--target', targets.get(repo), '--draft',
          '--title', `TrackLog ${tag}`, '--notes', 'TrackLog Android APK. パッケージ: com.tracklog.assist']);
        release = list(repo).find(value => value.tag_name === tag);
      }
      return release;
    },
    upload(repo, tag) {
      gh(repo, ['release', 'upload', tag, apkPath, `${apkPath}.sha256`, '--repo', repo, '--clobber']);
    },
    verifyDraft(repo, tag) {
      const release = list(repo).find(value => value.tag_name === tag);
      if (!release?.draft || release.prerelease) throw new Error('Release is not a normal draft');
      withTemp(directory => {
        gh(repo, ['release', 'download', tag, '--repo', repo, '--pattern', APK_NAME, '--pattern', `${APK_NAME}.sha256`, '--dir', directory]);
        verifyBytes(directory);
      });
    },
    publish(repo, id) {
      api(repo, `releases/${id}`, ['--method', 'PATCH', '-F', 'draft=false', '-f', 'make_latest=true']);
    },
    verifyLatest(repo, tag) {
      return retry(() => withTemp(directory => {
        // Public checks intentionally use no GitHub auth, even in private-source CI.
        const curl = args => execute('curl', ['--disable', '--fail', '--silent', '--show-error', '--location',
          '--proto', '=https', '--proto-redir', '=https', '--max-time', '120', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        const latest = JSON.parse(curl([`https://api.github.com/repos/${repo}/releases/latest`]));
        if (latest.tag_name !== tag || latest.draft || latest.prerelease) throw new Error('Public latest tag mismatch');
        for (const name of [APK_NAME, `${APK_NAME}.sha256`]) {
          curl(['--output', join(directory, name), `https://github.com/${repo}/releases/latest/download/${name}`]);
        }
        verifyBytes(directory);
      }));
    },
    rollback(repo, id) {
      return retry(() => {
        api(repo, `releases/${id}`, ['--method', 'PATCH', '-F', 'draft=true']);
        if (api(repo, `releases/${id}`).draft !== true) throw new Error('Rollback state mismatch');
        const previous = previousLatest.get(repo);
        if (previous) {
          api(repo, `releases/${previous.id}`, ['--method', 'PATCH', '-f', 'make_latest=true']);
          if (api(repo, 'releases/latest').id !== previous.id) throw new Error('Previous latest was not restored');
        }
      });
    },
    async cleanup(repo, tag) {
      // No rollback here: latest was verified and old assets may already be gone.
      await retry(() => {
        if (api(repo, 'releases/latest').tag_name !== tag) throw new Error('Latest changed before cleanup');
        for (const asset of removableAssets(list(repo), tag, repo)) {
          if (!Number.isSafeInteger(asset.id)) throw new Error('Invalid asset ID');
          api(repo, `releases/assets/${asset.id}`, ['--method', 'DELETE']);
        }
        if (removableAssets(list(repo), tag, repo).length) throw new Error('Old APK cleanup remains incomplete; latest retained');
      });
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    if (process.env.GITHUB_REPOSITORY !== SOURCE_REPOSITORY || process.env.GITHUB_REF_NAME !== `v${pkg.version}`) {
      throw new Error('Only the source repository version-tag workflow may publish');
    }
    await publishRelease(pkg, productionClient());
    console.log('Public APK/checksum verified; legacy APK assets retained.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
