import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('catalog_builder', Path(__file__).with_name('build-mlit-ic-catalog.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def feature(source_id='test-a', name='合成IC', kind='1', start=2000, end=9999, opened=2000, coordinates=None):
    return {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': coordinates or [139, 35]},
            'properties': {'N06_012': opened, 'N06_013': start, 'N06_014': end, 'N06_015': source_id,
                           'N06_018': name, 'N06_019': kind}}


class CatalogExtractionTest(unittest.TestCase):
    def test_current_snapshot_excludes_history_future_jct_and_other_joints(self):
        rows, stats = builder.extract_current_entries([
            feature(), feature('smart', '合成スマートIC', '2'),
            feature('historical', end=2024), feature('future', start=2026, opened=2026),
            feature('jct', kind='3'), feature('other', kind='4'),
        ])
        self.assertEqual([row[0] for row in rows], ['smart', 'test-a'])
        self.assertEqual(stats['excludedNonCurrent'], 2)
        self.assertEqual(stats['excludedNonIcKind'], 2)

    def test_preserves_public_name_and_does_not_invent_entrance_or_direction(self):
        rows, _ = builder.extract_current_entries([feature(name='合成')])
        self.assertEqual(rows, [['test-a', '合成', 35, 139, 1]])

    def test_missing_identity_bad_year_and_non_japanese_points_are_rejected(self):
        rows, stats = builder.extract_current_entries([
            feature(name=' '), feature(start='invalid'), feature(coordinates=[10, 20]), feature('valid'),
        ])
        self.assertEqual(len(rows), 1)
        self.assertEqual(stats['excludedInvalidIdentity'], 1)
        self.assertEqual(stats['excludedInvalidYear'], 1)
        self.assertEqual(stats['excludedInvalidPoint'], 1)

    def test_duplicate_id_is_only_collapsed_if_current_feature_agrees(self):
        rows, stats = builder.extract_current_entries([feature(), feature()])
        self.assertEqual(len(rows), 1)
        self.assertEqual(stats['duplicateCurrentFeatures'], 1)
        with self.assertRaisesRegex(ValueError, 'Conflicting'):
            builder.extract_current_entries([feature(), feature(name='別の合成IC')])

    def test_zip_is_read_without_extraction_and_wrong_hash_cannot_overwrite_data(self):
        with tempfile.TemporaryDirectory(prefix='tracklog-catalog-fixture-') as directory:
            archive = Path(directory) / 'synthetic.zip'
            with zipfile.ZipFile(archive, 'w') as output:
                output.writestr('../Joint.geojson', json.dumps({'type': 'FeatureCollection', 'features': [feature()]}))
                output.writestr('not-data.txt', 'not processed')
            features, source_hash, members = builder.read_official_zip(archive)
            self.assertEqual(len(features), 1)
            self.assertEqual(members, ['../Joint.geojson'])
            self.assertFalse((Path(directory).parent / 'Joint.geojson').exists())
            self.assertEqual(len(source_hash), 64)
            with self.assertRaisesRegex(ValueError, 'SHA-256'):
                builder.read_official_zip(archive, '0' * 64)

    def test_generation_is_stable_and_publishes_no_historical_fields(self):
        rows, stats = builder.extract_current_entries([feature()])
        text1, meta = builder.render_catalog(rows, '0' * 64, ['Joint.geojson'], stats)
        text2, _ = builder.render_catalog(rows, '0' * 64, ['Joint.geojson'], stats)
        self.assertEqual(text1, text2)
        self.assertEqual(meta['datasetDate'], '2025-12-31')
        self.assertEqual(meta['count'], 1)
        self.assertEqual(len(meta['catalogSha256']), 64)
        self.assertNotIn('"N06_017":', text1)


if __name__ == '__main__':
    unittest.main()
