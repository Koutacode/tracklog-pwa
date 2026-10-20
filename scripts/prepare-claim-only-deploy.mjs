// Offline packaging only. Do not deploy repo index.ts directly for this change:
// the production v12 ACK handler intentionally remains unchanged.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const [baselinePath, outputPath] = process.argv.slice(2);
assert.ok(baselinePath && outputPath, 'Usage: node scripts/prepare-claim-only-deploy.mjs <saved-v12.ts> <output.ts>');
const baseline = await readFile(baselinePath, 'utf8');
const sha = text => createHash('sha256').update(text).digest('hex');
assert.equal(sha(baseline), '1156419d20b4fcbd361663cba3eaac703a9d946ef9f18f843a9091eb39ce79e3', 'Production v12 baseline must match exactly');
const source = await readFile('supabase/functions/tracklog-privileged/index.ts', 'utf8');
const start = '// Only coalesce a heartbeat within the existing 60-second freshness window.';
const end = 'async function updateDeviceLocation(';
assert.equal(source.split(start).length, 2);
const updatedClaim = source.slice(source.indexOf(start), source.indexOf(end));
const oldStart = baseline.indexOf('async function claimDeviceProfile(');
const oldEnd = baseline.indexOf(end);
assert.ok(oldStart > 0 && oldEnd > oldStart);
const candidate = baseline.slice(0, oldStart) + updatedClaim + baseline.slice(oldEnd);
await writeFile(outputPath, candidate, { flag: 'wx' });
assert.equal(await readFile(outputPath, 'utf8'), candidate);
console.log(JSON.stringify({ baselineSha256: sha(baseline), candidateSha256: sha(candidate), outputPath }));
