# Public IC catalogue

This module supports IC **name candidates** from saved event positions without
an external API request. It does not acquire device location or determine whether
a truck is on an expressway. Road detection and exit confirmation must keep their
existing independent inputs.

## Source and licence

- Source: Ministry of Land, Infrastructure, Transport and Tourism (MLIT),
  [National Land Numerical Information, expressway time series, 2025 edition](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N06-2025.html).
- Snapshot: **2025-12-31**, released in April 2026. The complete official archive
  is `N06-25_GML.zip` (listed as 7.90 MB).
- This dataset permits **CC BY 4.0** use of the current snapshot for its dataset
  year. Its historical time series has a separate noncommercial restriction.
  TrackLog publishes only current IC point records, not historical records.
- Attribution: 「国土数値情報（高速道路時系列データ・2025年現況）」（国土交通省）を加工して作成。
  Preserve this attribution and the source URL when distributing the catalogue.
- [Dataset terms](https://nlftp.mlit.go.jp/ksj/other/agreement_01.html),
  [current site terms](https://nlftp.mlit.go.jp/ksj/other/agreement.html),
  [product specification](https://nlftp.mlit.go.jp/ksj/gml/product_spec/KS-PS-N06-v2_1_1.pdf),
  [joint type codes](https://nlftp.mlit.go.jp/ksj/gml/codelist/HighwayConCd.html).

Only publicly released IC point coordinates belong in `catalog-data.ts`. Never
add user trips, event IDs, recorded GPS positions, addresses, or credentials.

## Published input used in this release

The official ZIP was unavailable through this build environment's network policy.
This release instead reads the independently published
[`points.pmtiles`](https://github.com/hirofumikanda/highway-facility-map/blob/14792f8c12f6c17e3729cff44a58bc5735121f72/site/tiles/points.pmtiles)
from `hirofumikanda/highway-facility-map`. This is a separate public artifact,
not an official mirror or a byte-for-byte copy of the MLIT ZIP.

- Publisher commit: `14792f8c12f6c17e3729cff44a58bc5735121f72`.
- Artifact bytes: `1,154,536`.
- Artifact SHA-256: `887104200238fb551381181ba79ba1b23706d3ab71b2990386099318cf156940`.
- The publisher's [preprocessor](https://github.com/hirofumikanda/highway-facility-map/blob/14792f8c12f6c17e3729cff44a58bc5735121f72/pipeline/preprocess/filter_points.py)
  reads `N06-25_Joint.geojson`, selects `N06_014 == 9999`, and directly copies
  `N06_018` to `point_name`, `N06_019` to `point_type`, and point geometry.
- We decoded **all 2,228 z14 tiles**, verified **2,384 unique points** and 182
  identical boundary-buffer copies. Types 1/2/3/4 count 1,942/164/245/33;
  only **2,106 ordinary/smart ICs** are retained. This independently checks the
  publisher's [full-count assertion](https://github.com/hirofumikanda/highway-facility-map/blob/14792f8c12f6c17e3729cff44a58bc5735121f72/pipeline/tilegen/verify_tiles.py).
- This repository has no blanket code licence. TrackLog does not copy its code,
  styles, derived population ranks, lane counts or other original annotations.
  Only the MLIT factual label/type/point fields are extracted under the original
  current-snapshot CC BY 4.0 terms, with both MLIT attribution and publisher
  provenance preserved. These terms do not grant reuse rights over the
  publisher's unrelated material. The extraction implementation is independent.
- The original Joint ID and year attributes were discarded by the publisher.
  `n06p_…` IDs are artifact-scoped hashes of retained facts, **not original MLIT
  IDs**. The original ZIP was not compared, and the opening-year filter cannot
  be rechecked. Metadata records `openingYearsVerified: false`; current operation
  and whether a ramp was used remain unverified.
- MVT extent is 4,096 at z14: grid spacing is about 0.597 m at the equator,
  smaller on the ground in Japan. This is quantization scale, **not positional
  accuracy**. Decode and rounding to six decimals add precision loss; the source
  dataset's point accuracy and rounding direction were not independently verified.

The generated `inputArtifact.sha256` identifies this PMTiles file and
`sourceZipSha256` is explicitly `null`. `catalogSha256` identifies the compact
extracted rows. Every runtime candidate carries both the MLIT URL and the fixed
publisher URL, and a note that it comes from public derived data.

## Reproduce the published derivative

Download the fixed public artifact above through an allowed connection. The
builder does no networking. Decoder libraries are maintenance-only dependencies;
ordinary app builds and anonymous tests need none of them. In a disposable venv:

```sh
python3 -m venv /tmp/tracklog-catalog-venv
/tmp/tracklog-catalog-venv/bin/pip install -r scripts/requirements-ic-catalog.txt
/tmp/tracklog-catalog-venv/bin/python -B scripts/build-derived-ic-catalog.py /path/to/points.pmtiles
node --experimental-strip-types scripts/check-ic-catalog.mjs
```

The builder verifies the pinned file size/hash **before decoding**, all z14
counts and boundary duplicates, point types, names, Japan bounds, and identity
uniqueness. It fails before changing the generated output on any mismatch. It
only imports the original MLIT label/type/point fields, discarding all other
attributes. Remove the disposable venv and input after verification.

## Reproduce from an official archive

Download the official archive through an allowed connection. The builder itself
has no network access and consumes the downloaded ZIP directly without extracting
its paths. Record its SHA-256 and run:

```sh
python scripts/build-mlit-ic-catalog.py /path/to/N06-25_GML.zip \
  --expected-sha256 REVIEWED_ZIP_SHA256
```

The command filters Joint GeoJSON by `N06_013 <= 2025 <= N06_014`,
`N06_012 <= 2025`, and `N06_019` equal to 1 (ordinary IC, including city
expressway ramps) or 2 (smart IC). Type 3 (JCT) and 4 (other joints, including
some PA endpoints) are excluded. Only public source ID, official label, point,
and kind are retained. Names are not expanded into invented entrance/exit labels.

The generated metadata records the input ZIP hash, compact catalogue hash,
source members, extraction rule, and counts. Generation is deterministic. The
default 1,000-point sanity floor prevents accidentally shipping a small fixture
as a nationwide dataset. Missing GeoJSON, conflicting current IDs or a mismatched
hash fail before replacing the output. Review excluded counts before release.

The release gate is separate from anonymous fixture tests and must fail while the
reviewed catalogue is empty or unimported:

```sh
node --experimental-strip-types scripts/check-ic-catalog.mjs
```

It verifies the current snapshot metadata, at least 1,000 points, stable data hash,
unique identities, sorting, labels, bounds, and allowed joint kinds. Provenance
and hash assertions differ for official ZIP and public PMTiles artifacts; a
derivative hash is never accepted as an official ZIP hash. This gate runs before
release builds so an empty development placeholder cannot ship.

## Candidate interpretation

`lookupJapanIcCatalog(lat, lon, context)` is synchronous and returns only
`confidence: 'estimated'`, with the source date and attribution URL. It considers
all compatible IC points within 1,200 m. More than twelve points yields no result
instead of silently choosing a subset. Generic labels stay generic; a catalogued
point provides no carriageway, entrance, exit, or travel-direction proof. An
explicitly named exit is excluded for a start event and vice versa.

The source uses JGD2011. These coarse proximity candidates do not establish exact
gate positions, current closures, vehicle restrictions, or names changed after the
snapshot date. Existing manual values and earlier estimate evidence must continue
to be protected by the IC metadata persistence layer.

Tests use synthetic feature names and positions only:

```sh
python scripts/build-mlit-ic-catalog.test.py
python -B scripts/build-derived-ic-catalog.test.py
node --experimental-strip-types --test shared/ic-catalog/index.test.mjs
```
