/** Reviewed public map facts only. Never recorded trips or driver locations. */
export const IC_SUPPLEMENTAL_METADATA = {
  source: 'OpenStreetMap',
  license: 'ODbL-1.0',
  licenseUrl: 'https://www.openstreetmap.org/copyright',
  attribution: '© OpenStreetMap contributors',
  verifiedDate: '2026-10-25',
  // NEXCO corroborates the facility name and road, not these OSM point positions.
  nameCorroborationUrl: 'https://www.e-nexco.co.jp/pressroom/cms_assets/pressroom/2025/08/18/pdf.pdf',
  features: [
    { id: 'osm_node_304034547_v5', nodeId: 304034547, version: 5,
      sourceTimestamp: '2025-12-30T08:05:26Z',
      sourceUrl: 'https://api.openstreetmap.org/api/0.6/node/304034547/5.json' },
    { id: 'osm_node_447803283_v7', nodeId: 447803283, version: 7,
      sourceTimestamp: '2025-12-30T08:05:26Z',
      sourceUrl: 'https://api.openstreetmap.org/api/0.6/node/447803283/7.json' },
  ],
} as const;

/** Separate same-name public junctions; neither proves an entrance, exit or direction. */
export const IC_SUPPLEMENTAL_ENTRIES: readonly (readonly [string, string, number, number, 1 | 2])[] = [
  ['osm_node_304034547_v5', '木更津金田IC', 35.426491, 139.9301469, 1],
  ['osm_node_447803283_v7', '木更津金田IC', 35.4366104, 139.9169334, 1],
];
