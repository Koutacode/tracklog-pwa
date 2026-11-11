export type MunicipalityPlace = {
  kind: 'municipality';
  name: string;
};

type HeartRailsLocation = {
  prefecture?: unknown;
  city?: unknown;
  distance?: unknown;
};

function distanceOf(location: HeartRailsLocation): number {
  const distance = Number(location.distance);
  return Number.isFinite(distance) ? distance : Number.POSITIVE_INFINITY;
}

/**
 * Keep prefecture + city from a HeartRails searchByGeoLocation payload.
 * Town, postal code, and the x/y fields are discarded.
 */
export function coarsePlaceFromHeartRails(payload: unknown): MunicipalityPlace | null {
  if (!payload || typeof payload !== 'object') return null;
  const response = (payload as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return null;
  const locations = (response as { location?: unknown }).location;
  if (!Array.isArray(locations) || locations.length === 0) return null;
  const nearest = [...locations]
    .filter((item): item is HeartRailsLocation => !!item && typeof item === 'object')
    .sort((left, right) => distanceOf(left) - distanceOf(right))[0];
  if (!nearest) return null;
  const prefecture = typeof nearest.prefecture === 'string' ? nearest.prefecture.trim() : '';
  const city = typeof nearest.city === 'string' ? nearest.city.trim() : '';
  if (!prefecture || !city) return null;
  const name = `${prefecture}${city}`;
  if (name.length > 40) return null;
  return { kind: 'municipality', name };
}

export async function reverseGeocodeMunicipality(
  lat: number,
  lng: number,
  fetchImpl: typeof fetch = fetch,
): Promise<MunicipalityPlace | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const url = `https://geoapi.heartrails.com/api/json?method=searchByGeoLocation&x=${encodeURIComponent(String(lng))}&y=${encodeURIComponent(String(lat))}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return null;
    return coarsePlaceFromHeartRails(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
