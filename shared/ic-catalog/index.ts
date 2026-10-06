import { IC_CATALOG_ENTRIES, IC_CATALOG_METADATA } from './catalog-data.ts';

export { IC_CATALOG_METADATA } from './catalog-data.ts';

/** Public map features only; never recorded trips or device locations. */
export type IcCatalogEntry = readonly [id: string, name: string, lat: number, lon: number, kind: 1 | 2];
export type IcCatalogContext = { eventType?: 'expressway_start' | 'expressway_end' | 'expressway' };
export type IcCatalogCandidate = { id: string; icName: string; distanceM: number; kind: 1 | 2 };
export type IcCatalogMatches = {
  candidates: IcCatalogCandidate[];
  totalCandidates: number;
  overflow: boolean;
};
export type IcCatalogResult = {
  icName: string;
  distanceM: number;
  confidence: 'estimated';
  candidates: string[];
  estimateSource: 'mlit_n06_2025';
  sourceUrls: string[];
  sourceDatasetDate: '2025-12-31';
  note: string;
};

export const IC_CATALOG_MAX_DISTANCE_M = 1200;
export const IC_CATALOG_MAX_CANDIDATES = 12;

function validPoint(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90
    && Number.isFinite(lon) && lon >= -180 && lon <= 180;
}

function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const haversine = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, haversine))));
}

function compatibleName(name: string, context: IcCatalogContext): boolean {
  // Keep the source spelling. A generic IC point does not prove an entrance,
  // exit, carriageway or direction, so none of those labels are invented.
  if (context.eventType === 'expressway_start' && /出口/u.test(name) && !/入口/u.test(name)) return false;
  if (context.eventType === 'expressway_end' && /入口/u.test(name) && !/出口/u.test(name)) return false;
  return true;
}

/** A point catalogue provides name candidates, never expressway road signals. */
export function findNearbyIcCatalogCandidates(
  entries: readonly IcCatalogEntry[],
  lat: number,
  lon: number,
  context: IcCatalogContext = {},
): IcCatalogMatches {
  if (!validPoint(lat, lon)) throw new Error('IC候補検索の座標が不正です');
  const candidates: IcCatalogCandidate[] = [];
  const seen = new Set<string>();
  for (const [id, name, pointLat, pointLon, kind] of entries) {
    if ((kind !== 1 && kind !== 2) || !id || !name.trim() || !validPoint(pointLat, pointLon)
      || !compatibleName(name, context) || seen.has(id)) continue;
    const distanceM = distanceMeters(lat, lon, pointLat, pointLon);
    // Compare before rounding: 1200.4m is outside the fixed search boundary.
    if (distanceM > IC_CATALOG_MAX_DISTANCE_M + 1e-7) continue;
    seen.add(id);
    candidates.push({ id, icName: name, distanceM: Math.round(distanceM), kind });
  }
  candidates.sort((a, b) => a.distanceM - b.distanceM
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    candidates: candidates.slice(0, IC_CATALOG_MAX_CANDIDATES),
    totalCandidates: candidates.length,
    overflow: candidates.length > IC_CATALOG_MAX_CANDIDATES,
  };
}

/** Preserve every compatible nearby name; dense results must not pick a winner. */
export function resolveIcCatalogCandidates(matches: IcCatalogMatches): IcCatalogResult | null {
  if (matches.overflow || matches.candidates.length === 0) return null;
  const first = matches.candidates[0];
  return {
    icName: first.icName,
    distanceM: first.distanceM,
    confidence: 'estimated',
    candidates: [...new Set(matches.candidates.map(candidate => candidate.icName))],
    estimateSource: 'mlit_n06_2025',
    sourceUrls: [...IC_CATALOG_METADATA.sourceUrls],
    sourceDatasetDate: '2025-12-31',
    note: IC_CATALOG_METADATA.candidateNote,
  };
}

/** Synchronous and offline; uses the saved event fix and never obtains location. */
export function lookupJapanIcCatalog(lat: number, lon: number, context: IcCatalogContext = {}): IcCatalogResult | null {
  return resolveIcCatalogCandidates(findNearbyIcCatalogCandidates(IC_CATALOG_ENTRIES, lat, lon, context));
}
