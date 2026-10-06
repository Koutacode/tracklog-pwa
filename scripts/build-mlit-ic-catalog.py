#!/usr/bin/env python3
"""Build a small current IC catalogue from an already downloaded official ZIP.

This command does not access the network, extract arbitrary ZIP paths, read a
database, or accept driver/event files. Only N06 Joint GeoJSON is consumed.
"""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import unicodedata
import zipfile

DATASET_YEAR = 2025
SOURCE_URL = 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N06-2025.html'
MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
MAX_MEMBER_BYTES = 64 * 1024 * 1024
MAX_EXPANDED_BYTES = 128 * 1024 * 1024


def compact_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def integer(value):
    if isinstance(value, bool):
        return None
    try:
        parsed = float(value)
        return int(parsed) if math.isfinite(parsed) and parsed.is_integer() else None
    except (TypeError, ValueError, OverflowError):
        return None


def extract_current_entries(features):
    """Discard historical records before publication; never infer ramp direction."""
    stats = Counter()
    by_id = {}
    for feature in features:
        props = feature.get('properties') if isinstance(feature, dict) else None
        if not isinstance(props, dict) or 'N06_018' not in props:
            continue
        stats['sourceJointFeatures'] += 1
        start = integer(props.get('N06_013'))
        end = integer(props.get('N06_014'))
        opened = integer(props.get('N06_012'))
        if start is None or end is None or opened is None:
            stats['excludedInvalidYear'] += 1
            continue
        if not (opened <= DATASET_YEAR and start <= DATASET_YEAR <= end):
            stats['excludedNonCurrent'] += 1
            continue
        kind = integer(props.get('N06_019'))
        if kind not in (1, 2):
            stats['excludedNonIcKind'] += 1
            continue
        raw_id, raw_name = props.get('N06_015'), props.get('N06_018')
        if not isinstance(raw_id, str) or not isinstance(raw_name, str):
            stats['excludedInvalidIdentity'] += 1
            continue
        source_id = raw_id.strip()
        name = unicodedata.normalize('NFC', raw_name).strip()
        if not source_id or len(source_id) > 120 or not name or len(name) > 80:
            stats['excludedInvalidIdentity'] += 1
            continue
        geom = feature.get('geometry')
        coords = geom.get('coordinates') if isinstance(geom, dict) else None
        if not isinstance(geom, dict) or geom.get('type') != 'Point' or not isinstance(coords, list) or len(coords) < 2:
            stats['excludedInvalidPoint'] += 1
            continue
        lon, lat = coords[:2]
        if isinstance(lon, bool) or isinstance(lat, bool) or not isinstance(lon, (int, float)) or not isinstance(lat, (int, float)):
            stats['excludedInvalidPoint'] += 1
            continue
        if not math.isfinite(lon) or not math.isfinite(lat) or not (122 <= lon <= 154 and 20 <= lat <= 46):
            stats['excludedInvalidPoint'] += 1
            continue
        # JSON's numeric spelling must agree with JavaScript for the data hash.
        # Python otherwise emits 35.0 where JSON.stringify emits 35.
        rounded_lat, rounded_lon = round(lat, 6), round(lon, 6)
        row = [source_id, name,
               int(rounded_lat) if rounded_lat == int(rounded_lat) else rounded_lat,
               int(rounded_lon) if rounded_lon == int(rounded_lon) else rounded_lon, kind]
        if source_id in by_id:
            if by_id[source_id] != row:
                raise ValueError('Conflicting current Joint records for one source ID; inspect the official snapshot')
            stats['duplicateCurrentFeatures'] += 1
            continue
        by_id[source_id] = row
    if not stats['sourceJointFeatures']:
        raise ValueError('No N06 Joint properties found; expected official Joint GeoJSON')
    rows = sorted(by_id.values(), key=lambda row: row[0])
    stats['currentIcCount'] = len(rows)
    return rows, dict(sorted(stats.items()))


def read_official_zip(path, expected_sha256=None):
    source = Path(path)
    if source.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError('Archive exceeds the bounded official dataset size')
    raw = source.read_bytes()
    source_hash = sha256(raw)
    if expected_sha256 and source_hash != expected_sha256.lower():
        raise ValueError('Source ZIP SHA-256 does not match the reviewed input')
    features = []
    used_members = []
    with zipfile.ZipFile(source) as archive:
        members = archive.infolist()
        if sum(member.file_size for member in members) > MAX_EXPANDED_BYTES:
            raise ValueError('Expanded archive exceeds the safety limit')
        for member in members:
            if not member.filename.lower().endswith(('.geojson', '.json')):
                continue
            if member.file_size > MAX_MEMBER_BYTES:
                raise ValueError('GeoJSON member exceeds the safety limit')
            data = json.loads(archive.read(member).decode('utf-8-sig'))
            if not isinstance(data, dict) or data.get('type') != 'FeatureCollection' or not isinstance(data.get('features'), list):
                continue
            joints = [feature for feature in data['features'] if isinstance(feature, dict)
                      and isinstance(feature.get('properties'), dict) and 'N06_018' in feature['properties']]
            if joints:
                used_members.append(member.filename)
                features.extend(joints)
    if not used_members:
        raise ValueError('Official ZIP has no N06 Joint GeoJSON; do not substitute an unverified dataset')
    return features, source_hash, sorted(used_members)


def render_catalog(rows, source_hash, members, stats):
    metadata = {
        'schemaVersion': 1, 'generated': True, 'source': 'mlit_n06_2025',
        'datasetDate': '2025-12-31', 'sourceUrl': SOURCE_URL,
        'sourceUrls': [SOURCE_URL],
        'license': 'CC BY 4.0 (2025 current snapshot only)',
        'attribution': '国土数値情報（高速道路時系列データ・2025年現況）（国土交通省）を加工して作成',
        'sourceZipSha256': source_hash,
        'inputArtifact': {'type': 'official-zip', 'sha256': source_hash},
        'catalogSha256': sha256(compact_json(rows).encode('utf-8')),
        'sourceMembers': members,
        'extraction': 'Point; N06_019 in (1,2); N06_012 <= 2025; N06_013 <= 2025 <= N06_014',
        'candidateNote': '国土数値情報（2025-12-31時点）の近傍候補。利用した入口・出口・進行方向は未確認。',
        'count': len(rows), 'statistics': stats,
    }
    contents = [
        '// Generated by scripts/build-mlit-ic-catalog.py; public IC features only.',
        '// Source/attribution/license are recorded below and in README.md.',
        'export const IC_CATALOG_METADATA = ' + json.dumps(metadata, ensure_ascii=False, indent=2) + ' as const;',
        '',
        '/** [public source ID, official name, latitude, longitude, kind (1=IC, 2=smart IC)] */',
        'export const IC_CATALOG_ENTRIES: readonly (readonly [string, string, number, number, 1 | 2])[] = [',
        *['  ' + compact_json(row) + ',' for row in rows],
        '];', '',
    ]
    return '\n'.join(contents), metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('zip_path', type=Path)
    parser.add_argument('--expected-sha256')
    parser.add_argument('--output', type=Path, default=Path('shared/ic-catalog/catalog-data.ts'))
    parser.add_argument('--minimum-count', type=int, default=1000,
                        help='sanity floor; lower only for synthetic extraction tests')
    args = parser.parse_args()
    features, source_hash, members = read_official_zip(args.zip_path, args.expected_sha256)
    rows, stats = extract_current_entries(features)
    if len(rows) < args.minimum_count:
        raise ValueError('Too few current IC points for a nationwide catalogue; output was not changed')
    contents, metadata = render_catalog(rows, source_hash, members, stats)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(contents, encoding='utf-8', newline='\n')
    print(json.dumps({'count': len(rows), 'sourceZipSha256': source_hash,
                      'catalogSha256': metadata['catalogSha256'], 'bytes': len(contents.encode('utf-8')),
                      'statistics': stats}, ensure_ascii=False))


if __name__ == '__main__':
    main()
