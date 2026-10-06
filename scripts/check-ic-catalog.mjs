import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IC_CATALOG_ENTRIES, IC_CATALOG_METADATA } from '../shared/ic-catalog/catalog-data.ts';

// Release gate, deliberately separate from the anonymous algorithm tests.
// It must fail while a reviewed nationwide input has not been imported.
const metadata = IC_CATALOG_METADATA;
const entries = IC_CATALOG_ENTRIES;
assert.equal(metadata.generated, true, 'The reviewed nationwide IC catalogue has not been imported');
assert.equal(metadata.schemaVersion, 1);
assert.equal(metadata.source, 'mlit_n06_2025');
assert.equal(metadata.datasetDate, '2025-12-31');
assert.equal(metadata.sourceUrl, 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N06-2025.html');
assert.equal(metadata.license, 'CC BY 4.0 (2025 current snapshot only)');
assert.match(metadata.attribution ?? '', /国土交通省.*加工/);
assert.equal(metadata.count, entries.length);
assert.ok(entries.length >= 1000 && entries.length <= 12000, 'Nationwide catalogue count is implausible');
assert.match(metadata.catalogSha256, /^[a-f0-9]{64}$/);
assert.ok(metadata.sourceMembers?.length > 0, 'The source archive member is missing');
assert.match(metadata.extraction ?? '', /N06_019 in \(1,2\)/);
const artifact = metadata.inputArtifact;
assert.match(artifact?.sha256 ?? '', /^[a-f0-9]{64}$/);
let identityPattern;
if (artifact.type === 'official-zip') {
  assert.equal(metadata.sourceZipSha256, artifact.sha256);
  assert.match(metadata.extraction, /N06_013 <= 2025 <= N06_014/);
  assert.match(metadata.extraction, /N06_012 <= 2025/);
  identityPattern = /^EA03_\d{6}$/;
} else if (artifact.type === 'public-derived-pmtiles') {
  assert.equal(metadata.sourceZipSha256, null, 'A derivative hash must never be presented as the official ZIP hash');
  assert.equal(artifact.publisher, 'hirofumikanda/highway-facility-map');
  assert.equal(artifact.commit, '14792f8c12f6c17e3729cff44a58bc5735121f72');
  assert.equal(artifact.sha256, '887104200238fb551381181ba79ba1b23706d3ab71b2990386099318cf156940');
  assert.equal(artifact.bytes, 1154536);
  assert.equal(artifact.url, `https://github.com/${artifact.publisher}/blob/${artifact.commit}/site/tiles/points.pmtiles`);
  assert.ok(metadata.sourceUrls.includes(artifact.url));
  assert.equal(metadata.statistics.z14UniqueFeatureCount, 2384);
  assert.deepEqual(metadata.statistics.kindCounts, { 1: 1942, 2: 164, 3: 245, 4: 33 });
  assert.equal(entries.length, 2106);
  assert.equal(metadata.openingYearsVerified, false);
  assert.equal(metadata.quantization.zoom, 14);
  assert.equal(metadata.quantization.extent, 4096);
  assert.ok(metadata.quantization.equatorialGridMetres > 0.59 && metadata.quantization.equatorialGridMetres < 0.60);
  assert.match(metadata.candidateNote, /公開派生.*現在の供用状況も未確認/);
  identityPattern = /^n06p_[a-f0-9]{24}$/;
} else {
  assert.fail('Unknown input artifact provenance');
}
const digest = createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex');
assert.equal(metadata.catalogSha256, digest, 'Generated catalogue data differs from its recorded SHA-256');

const seen = new Set();
let previousId = '';
const seenKinds = new Set();
for (const row of entries) {
  assert.equal(row.length, 5, 'Public catalogue rows must contain only identity, label, point and kind');
  const [id, name, lat, lon, kind] = row;
  assert.match(id, identityPattern, 'Invalid public catalogue identity');
  assert.equal(seen.has(id), false, 'Duplicate public source ID');
  assert.ok(id > previousId, 'Catalogue must be deterministically sorted by source ID');
  seen.add(id);
  previousId = id;
  assert.equal(typeof name, 'string');
  assert.ok(name.length > 0 && name.length <= 80);
  assert.equal(name.trim(), name);
  assert.equal(name.normalize('NFC'), name);
  assert.doesNotMatch(name, /[\u0000-\u001f\u007f]/);
  assert.ok(Number.isFinite(lat) && lat >= 20 && lat <= 46, 'Invalid public IC latitude');
  assert.ok(Number.isFinite(lon) && lon >= 122 && lon <= 154, 'Invalid public IC longitude');
  assert.ok(kind === 1 || kind === 2, 'JCT/other joints must not enter the IC catalogue');
  seenKinds.add(kind);
}
assert.ok(seenKinds.has(1) && seenKinds.has(2), 'Both ordinary and smart ICs must be represented');
console.log(`IC catalogue verified: ${entries.length} public current IC points, SHA-256 ${digest}`);
