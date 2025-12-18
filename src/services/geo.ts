import type { Geo } from '../domain/types';

/**
 * getGeo returns the current position from the browser's geolocation API. If
 * geolocation is unavailable or fails it resolves to undefined. The
 * implementation requests high accuracy and has sensible timeouts.
 */
export async function getGeo(): Promise<Geo | undefined> {
  if (!navigator.geolocation) return undefined;
  return new Promise<Geo | undefined>(resolve => {
    navigator.geolocation.getCurrentPosition(
      pos => {
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
      },
      () => resolve(undefined),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    );
  });
}

/**
 * reverseGeocode queries a public reverse geocoding service (Nominatim) to get
 * a human-readable address. If the network request fails or is unavailable it
 * returns undefined so that callers can degrade gracefully.
 */
export async function reverseGeocode(geo: Geo): Promise<string | undefined> {
  const { lat, lng } = geo;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 5000);
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(
      lng,
    )}&zoom=17&addressdetails=1`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept-Language': 'ja' },
    });
    if (!res.ok) return undefined;
    const data = await res.json();
    const addr = data?.address ?? {};
    const prefecture = addr.state;
    const county = addr.county || addr.city_district;
    const city = addr.city || addr.town || addr.village || addr.hamlet || addr.municipality;
    const area = addr.suburb || addr.quarter || addr.neighbourhood;
    const block = addr.road;
    const house = addr.house_number;
    const detail = block && house ? `${block} ${house}` : block;

    // Deduplicate while preserving order
    const seen = new Set<string>();
    const parts = [prefecture, county, city, area, detail, addr.postcode]
      .filter((p): p is string => !!p)
      .filter(p => {
        if (seen.has(p)) return false;
        seen.add(p);
        return true;
      });

    const text = parts.join(' ');
    return text || data?.display_name;
  } catch {
    return undefined;
  } finally {
    clearTimeout(id);
  }
}

/**
 * getGeoWithAddress wraps getGeo and optionally resolves a human-readable
 * address. If address lookup fails it still returns the geo.
 */
export async function getGeoWithAddress(): Promise<{ geo?: Geo; address?: string }> {
  const geo = await getGeo();
  if (!geo) return { geo: undefined, address: undefined };
  const address = await reverseGeocode(geo);
  return { geo, address };
}
