import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSync, transformSync } from 'esbuild';
// Two isolated module instances share only the browser-wide Locks API.
const pendingLocks = new Map();
const navigator = { locks: { request(name, fn) {
  const run = (pendingLocks.get(name) ?? Promise.resolve()).catch(() => {}).then(fn);
  pendingLocks.set(name, run.catch(() => {})); return run;
} } };
const registrationCode = transformSync(readFileSync('src/services/driverRegistrationLock.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code;
const registrationContext = () => { const module = { exports: {} }; runInNewContext(registrationCode, { module, exports: module.exports, navigator }); return module.exports; };
const tabA = registrationContext(), tabB = registrationContext();
let release; const gate = new Promise(r => { release = r; }); const sequence = [];
const first = tabA.withDriverRegistrationMutation(async () => { sequence.push('A'); await gate; });
await new Promise(r => setTimeout(r, 0));
const second = tabB.withDriverRegistrationMutation(async () => { sequence.push('B'); });
await new Promise(r => setTimeout(r, 0)); assert.deepEqual(sequence, ['A']);
release(); await Promise.all([first, second]); assert.deepEqual(sequence, ['A', 'B']);
console.log('PASS registration serialization across isolated module contexts');
if (!process.env.TRACKLOG_GOOGLE_SCENARIOS) {
const candidate = spawnSync(resolve('node_modules/.bin/tsx'), ['scripts/fixtures/driver-candidate.ts'], { encoding: 'utf8', timeout: 45000 });
process.stdout.write(candidate.stdout ?? '');
if (candidate.status !== 0) { process.stderr.write(candidate.stderr ?? ''); throw new Error('Candidate regression failed'); }
}
if (!process.env.TRACKLOG_GOOGLE_SCENARIOS) {
  const throttle = spawnSync(process.execPath, ['scripts/test-device-claim-throttle.mjs'], { encoding:'utf8', timeout:45000 });
  process.stdout.write(throttle.stdout ?? '');
  process.stderr.write(throttle.stderr ?? '');
  assert.equal(throttle.status, 0, 'claim throttle tests');
  const claim = spawnSync(process.execPath, ['scripts/test-driver-claim-replay.mjs'], { encoding:'utf8', timeout:45000 });
  process.stdout.write(claim.stdout ?? '');
  if (claim.status !== 0) { process.stderr.write(claim.stderr ?? ''); throw Error('Claim replay regression failed'); }
}
const dir = mkdtempSync(join(tmpdir(), 'tracklog-google-test-'));
try {
  const outfile = join(dir, 'test.cjs');
  buildSync({ entryPoints: ['scripts/fixtures/driver-google.ts'], outfile, bundle: true, packages: 'external', platform: 'node', format: 'cjs',
    define: { 'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://synthetic.example.test', VITE_SUPABASE_ANON_KEY: 'synthetic-test-key' }), __APP_VERSION__: '"test"', __BUILD_DATE__: '"test"' } });
  for (const scenario of (process.env.TRACKLOG_GOOGLE_SCENARIOS?.split(',') ?? ['ui-render','new','wrong-owner','same-owner','native-only-wrong','native-only-same','native-install-failure','claim-failure','storage-failure','otp-race','native-otp-race','refresh-during-candidate','refresh-storage-failure','stale-confirm','stale-cancel','stale-reauth','pinned-db-conflict','native-pinned-conflict','approved-profile','claim-response-lost','claim-response-lost-approved'])) {
    const result = spawnSync(process.execPath, [outfile, scenario], { env: { ...process.env, NODE_PATH: resolve('node_modules') }, encoding: 'utf8', timeout: 45000 });
    if (result.status !== 0) { process.stderr.write((result.stdout ?? '') + (result.stderr ?? '')); throw new Error(`Google integration failed: ${scenario} (${result.status})`); }
    process.stdout.write(result.stdout);
  }
  if (!process.env.TRACKLOG_GOOGLE_SCENARIOS) for (const stage of ['handoff','active','scrub','native','profile-partial','profile-saved','claim','approval']) {
    const state=join(dir,stage+'.json');
    for (const mode of ['interrupt','resume']) {
      const r=spawnSync(process.execPath,[outfile,'native-boundary-'+stage,state,mode],{env:{...process.env,NODE_PATH:resolve('node_modules')},encoding:'utf8',timeout:45000});
      if(r.status!==(mode==='interrupt'?77:0)){process.stderr.write(r.stderr||r.stdout);throw Error('Boundary '+stage+' '+mode+' failed: '+r.status);}
      process.stdout.write(r.stdout);
    }
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
