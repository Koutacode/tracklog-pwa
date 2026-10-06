#!/usr/bin/env python3
"""Anonymous extraction tests; no decoder packages or real journeys required."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('builder', Path(__file__).with_name('build-derived-ic-catalog.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def feature(identity=1, name='合成地点', kind='1', coordinates=None):
    return {'id': identity, 'properties': {'point_name': name, 'point_type': kind,
            'population': 999, 'lane_counts': '[4]', 'symbolrank': 1},
            'geometry': {'type': 'Point', 'coordinates': coordinates or [100, 200]}}


def tile(features, z=14, x=14500, y=6500, extent=4096):
    return z, x, y, {'extent': extent, 'features': features}


class DerivedCatalogTests(unittest.TestCase):
    def test_all_z14_copies_are_checked_and_non_ic_kinds_excluded(self):
        rows, stats = builder.extract_rows([
            tile([feature(), feature(2, '合成スマート', '2'), feature(3, '合成分岐', '3')]),
            tile([feature(coordinates=[100-4096, 200])], x=14501),
            tile([feature(99, '低倍率のみ')], z=13),
        ], {1: 1, 2: 1, 3: 1})
        self.assertEqual(len(rows), 2)
        self.assertEqual(stats['duplicateBufferCopies'], 1)
        self.assertEqual(stats['z14UniqueFeatureCount'], 3)
        self.assertTrue(all(len(row) == 5 for row in rows))
        self.assertTrue(all(row[0].startswith('n06p_') for row in rows))
        text, metadata = builder.render_catalog(rows, stats)
        self.assertNotIn('population', text)
        self.assertNotIn('lane_counts', text)
        self.assertNotIn('symbolrank', text)
        self.assertIsNone(metadata['sourceZipSha256'])
        self.assertFalse(metadata['openingYearsVerified'])

    def test_conflicting_copies_or_missing_z14_points_fail(self):
        with self.assertRaisesRegex(ValueError, 'Conflicting'):
            builder.extract_rows([tile([feature(), feature(name='異なる地点')])])
        with self.assertRaisesRegex(ValueError, 'counts differ'):
            builder.extract_rows([tile([feature()])], {1: 2})
        with self.assertRaisesRegex(ValueError, 'No z14'):
            builder.extract_rows([tile([feature()], z=13)])

    def test_hash_identity_is_deterministic_and_not_a_forged_mlit_id(self):
        a, stats = builder.extract_rows([tile([feature(2, '合成乙'), feature(1, '合成甲')])])
        b, _ = builder.extract_rows([tile([feature(1, '合成甲'), feature(2, '合成乙')])])
        self.assertEqual(a, b)
        self.assertEqual(a, sorted(a))
        self.assertTrue(all(len(row[0]) == 29 for row in a))
        self.assertEqual(builder.render_catalog(a, stats), builder.render_catalog(a, stats))

    def test_invalid_labels_type_extent_and_geometry_fail(self):
        for item in [feature(kind='5'), feature(name='bad\nname'), feature(name=''), feature(coordinates=[float('nan'), 1])]:
            with self.subTest(item=item), self.assertRaises(ValueError):
                builder.extract_rows([tile([item])])
        with self.assertRaisesRegex(ValueError, 'extent'):
            builder.extract_rows([tile([feature()], extent=8192)])

    def test_wrong_artifact_fails_before_loading_decoder_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'anonymous.pmtiles'
            path.write_bytes(b'not a public tile archive')
            with self.assertRaisesRegex(ValueError, 'size differs'):
                list(builder.read_reviewed_artifact(path))


if __name__ == '__main__':
    unittest.main()
