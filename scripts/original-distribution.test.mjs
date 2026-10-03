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
  assert.ok(!/TRACKLOG_DISTRIBUTION|create-github-app-token|tracklog-releases|workflow_dispatch/.test(workflow));
  assert.ok(workflow.includes("tags:\n      - 'v*'"));
  assert.ok(workflow.includes('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}'));
  for (const name of ['Create draft GitHub Release', 'Verify draft release APK', 'Publish verified GitHub Release', 'Remove APK assets from older releases']) {
    assert.ok(workflow.includes(name), name);
  }
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
