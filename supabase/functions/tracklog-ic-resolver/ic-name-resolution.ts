import { lookupJapanIcCatalog } from '../../../shared/ic-catalog/index.ts';
import { resolveExpresswayFromOverpass, type IcResolutionContext } from './resolver.ts';

type CatalogLookup = typeof lookupJapanIcCatalog;
type RoadLookup = typeof resolveExpresswayFromOverpass;
type NameResolutionDependencies = {
  catalogLookup?: CatalogLookup;
  roadLookup?: RoadLookup;
};

/** IC names and road occupancy have different evidence and separate contracts. */
export async function resolveExpresswayIcName(
  lat: number,
  lon: number,
  radiusM: number,
  context: IcResolutionContext = {},
  dependencies: NameResolutionDependencies = {},
) {
  const local = (dependencies.catalogLookup ?? lookupJapanIcCatalog)(lat, lon, context);
  if (local) {
    return {
      ...local,
      // Keep uncertainty visible when the saved name is synced to an older APK.
      icName: /[（(]推定(?:候補)?[）)]$/u.test(local.icName)
        ? local.icName : `${local.icName}（推定）`,
    };
  }
  const signal = await (dependencies.roadLookup ?? resolveExpresswayFromOverpass)(lat, lon, radiusM, context);
  return signal.nearestIc;
}
