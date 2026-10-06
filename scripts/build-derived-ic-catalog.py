#!/usr/bin/env python3
"""Extract MLIT factual IC fields from the reviewed public PMTiles derivative.

No network access occurs here. Input is a fixed, independently published public
artifact, never a trip export. Publisher code and added attributes are not copied.
Install the maintenance-only decoder dependencies in requirements-ic-catalog.txt.
"""
import argparse
from collections import Counter
import gzip
import hashlib
import json
import math
from pathlib import Path
import unicodedata

SOURCE_URL = 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N06-2025.html'
PUBLISHER = 'hirofumikanda/highway-facility-map'
COMMIT = '14792f8c12f6c17e3729cff44a58bc5735121f72'
ARTIFACT_URL = f'https://github.com/{PUBLISHER}/blob/{COMMIT}/site/tiles/points.pmtiles'
ARTIFACT_SHA256 = '887104200238fb551381181ba79ba1b23706d3ab71b2990386099318cf156940'
ARTIFACT_BYTES = 1154536
EXPECTED_COUNTS = {1: 1942, 2: 164, 3: 245, 4: 33}
ZOOM = 14
EXTENT = 4096


def compact_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def validate_feature(tile_x, tile_y, extent, feature):
    """Return only original MLIT name, kind and quantized point plus tile ID."""
    if extent != EXTENT:
        raise ValueError('Unexpected MVT extent; review positional precision before importing')
    identity = feature.get('id')
    if isinstance(identity, bool) or not isinstance(identity, int) or identity < 1:
        raise ValueError('Missing generated MVT feature identity')
    props = feature.get('properties', {})
    raw_kind = props.get('point_type')
    if raw_kind not in ('1', '2', '3', '4'):
        raise ValueError('Unexpected original N06 point type')
    raw_name = props.get('point_name')
    if not isinstance(raw_name, str):
        raise ValueError('Invalid public point name')
    name = unicodedata.normalize('NFC', raw_name).strip()
    if not name or len(name) > 80 or any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise ValueError('Invalid public point name')
    geometry = feature.get('geometry', {})
    coordinates = geometry.get('coordinates')
    if geometry.get('type') != 'Point' or not isinstance(coordinates, list) or len(coordinates) != 2:
        raise ValueError('Non-point geometry in the IC input')
    if any(isinstance(n, bool) or not isinstance(n, int) for n in coordinates):
        raise ValueError('Point coordinates must be MVT grid integers')
    global_x = tile_x * extent + coordinates[0]
    global_y = tile_y * extent + coordinates[1]
    # Buffered copies may be outside an individual tile, but not the world grid.
    world = (2 ** ZOOM) * extent
    if not (0 <= global_x < world and 0 <= global_y < world):
        raise ValueError('Point outside the world grid')
    return identity, (name, int(raw_kind), global_x, global_y)


def extract_rows(decoded_tiles, expected_counts=None):
    """Inspect every z14 tile and reject inconsistent buffered copies."""
    by_id = {}
    copies = 0
    tiles = 0
    for z, x, y, layer in decoded_tiles:
        if z != ZOOM:
            continue
        tiles += 1
        for feature in layer['features']:
            identity, value = validate_feature(x, y, layer['extent'], feature)
            if identity in by_id:
                if by_id[identity] != value:
                    raise ValueError('Conflicting buffered copies of a public feature')
                copies += 1
            else:
                by_id[identity] = value
    counts = Counter(value[1] for value in by_id.values())
    if expected_counts is not None and dict(counts) != expected_counts:
        raise ValueError('All-z14 feature counts differ from the reviewed source snapshot')
    if not by_id:
        raise ValueError('No z14 public points found')
    rows = []
    seen_rows = set()
    world = (2 ** ZOOM) * EXTENT
    for name, kind, global_x, global_y in by_id.values():
        if kind not in (1, 2):
            continue
        longitude = global_x / world * 360 - 180
        latitude = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * global_y / world))))
        if not (122 <= longitude <= 154 and 20 <= latitude <= 46):
            raise ValueError('Public point outside Japan')
        # The official Joint ID was discarded by the publisher. Do not forge it.
        # Scope retained factual fields to this reviewed artifact, not its
        # generated numeric feature IDs (which can change on a publisher build).
        identity = 'n06p_' + digest(compact_json([ARTIFACT_SHA256, name, kind, global_x, global_y]).encode('utf-8'))[:24]
        if identity in seen_rows:
            raise ValueError('Distinct source IDs collapse to one derived identity')
        seen_rows.add(identity)
        lat, lon = round(latitude, 6), round(longitude, 6)
        rows.append([identity, name, int(lat) if lat.is_integer() else lat,
                     int(lon) if lon.is_integer() else lon, kind])
    rows.sort(key=lambda row: row[0])
    return rows, {'z14TileCount': tiles, 'z14UniqueFeatureCount': len(by_id),
                  'duplicateBufferCopies': copies, 'kindCounts': dict(sorted(counts.items())),
                  'currentIcCount': len(rows)}


def read_reviewed_artifact(path):
    source = Path(path)
    if source.stat().st_size != ARTIFACT_BYTES:
        raise ValueError('Public PMTiles size differs from the reviewed artifact')
    raw = source.read_bytes()
    if digest(raw) != ARTIFACT_SHA256:
        raise ValueError('Public PMTiles SHA-256 differs from the reviewed artifact')
    # Maintenance-only dependencies; not imported by the app or anonymous tests.
    from pmtiles.reader import MemorySource, Reader, all_tiles
    from pmtiles.tile import Compression, TileType
    import mapbox_vector_tile
    get_bytes = MemorySource(raw)
    header = Reader(get_bytes).header()
    if header['version'] != 3 or header['tile_type'] != TileType.MVT or header['max_zoom'] != ZOOM:
        raise ValueError('Unsupported public PMTiles structure')
    if header['tile_compression'] != Compression.GZIP:
        raise ValueError('Unexpected tile compression')
    for (z, x, y), encoded in all_tiles(get_bytes):
        if z != ZOOM:
            continue
        if len(encoded) > 1024 * 1024:
            raise ValueError('Unexpectedly large public point tile')
        decoded = mapbox_vector_tile.decode(gzip.decompress(encoded), default_options={'y_coord_down': True})
        if set(decoded) != {'points'}:
            raise ValueError('Unexpected layer in the public points artifact')
        yield z, x, y, decoded['points']


def render_catalog(rows, stats):
    metadata = {
        'schemaVersion': 1, 'generated': True, 'source': 'mlit_n06_2025',
        'datasetDate': '2025-12-31', 'sourceUrl': SOURCE_URL,
        'sourceUrls': [SOURCE_URL, ARTIFACT_URL],
        'license': 'CC BY 4.0 (2025 current snapshot only)',
        'attribution': '国土数値情報（高速道路時系列データ・2025年現況）（国土交通省）を加工して作成。公開派生データ: hirofumikanda/highway-facility-map。',
        'inputArtifact': {'type': 'public-derived-pmtiles', 'publisher': PUBLISHER,
                          'url': ARTIFACT_URL, 'commit': COMMIT, 'sha256': ARTIFACT_SHA256,
                          'bytes': ARTIFACT_BYTES},
        'sourceZipSha256': None,
        'catalogSha256': digest(compact_json(rows).encode('utf-8')),
        'sourceMembers': ['points (all z14 tiles)'],
        'extraction': 'Published N06_014 == 9999 snapshot; all z14; point_type from N06_019 in (1,2); MLIT point_name/point_type/geometry only',
        'openingYearsVerified': False,
        'identity': 'n06p_ + SHA-256 of [artifactSha256,name,kind,globalMvtX,globalMvtY] first 24 hex; not an original MLIT Joint ID',
        'quantization': {'zoom': ZOOM, 'extent': EXTENT, 'equatorialGridMetres': round(40075016.68557849 / (2 ** ZOOM * EXTENT), 9),
                         'outputDecimals': 6, 'note': 'MVT grid precision only; original positional accuracy and rounding direction are not verified'},
        'candidateNote': '国土数値情報（2025-12-31時点）の公開派生データによる近傍候補。利用した入口・出口・進行方向は未確認。現在の供用状況も未確認。',
        'count': len(rows), 'statistics': stats,
    }
    lines = [
        '// Generated by scripts/build-derived-ic-catalog.py; public IC facts only.',
        '// Independent PMTiles derivative; NOT the official ZIP or original MLIT coordinates.',
        'export const IC_CATALOG_METADATA = ' + json.dumps(metadata, ensure_ascii=False, indent=2) + ' as const;', '',
        '/** [derived identity, source name, latitude, longitude, kind (1=IC, 2=smart IC)] */',
        'export const IC_CATALOG_ENTRIES: readonly (readonly [string, string, number, number, 1 | 2])[] = [',
        *['  ' + compact_json(row) + ',' for row in rows], '];', '',
    ]
    return '\n'.join(lines), metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pmtiles_path', type=Path)
    parser.add_argument('--output', type=Path, default=Path('shared/ic-catalog/catalog-data.ts'))
    args = parser.parse_args()
    rows, stats = extract_rows(read_reviewed_artifact(args.pmtiles_path), EXPECTED_COUNTS)
    contents, metadata = render_catalog(rows, stats)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(contents, encoding='utf-8', newline='\n')
    print(json.dumps({'count': len(rows), 'inputArtifactSha256': ARTIFACT_SHA256,
                      'catalogSha256': metadata['catalogSha256'], 'bytes': len(contents.encode('utf-8')),
                      'statistics': stats}, ensure_ascii=False))


if __name__ == '__main__':
    main()
