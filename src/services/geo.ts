import type { Geo } from '../domain/types';

/**
 * getGeo returns the current position from the browser's geolocation API. If
 * geolocation is unavailable or fails it resolves to undefined. The
 * implementation requests high accuracy and has sensible timeouts.
 */
export async function getGeo(): Promise<Geo | undefined> {
  if (!navigator.geolocation) return undefined;
  const timeouts = [5000, 8000]; // try fast first, then a bit longer

  for (let i = 0; i < timeouts.length; i++) {
    // eslint-disable-next-line no-await-in-loop
    const res = await new Promise<Geo | undefined>(resolve => {
      navigator.geolocation.getCurrentPosition(
        pos => {
          resolve({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          });
        },
        () => resolve(undefined),
        { enableHighAccuracy: true, timeout: timeouts[i], maximumAge: 30000 },
      );
    });
    if (res) return res;
    // brief delay before retry
    // eslint-disable-next-line no-await-in-loop
    await new Promise(r => setTimeout(r, 300));
  }
  return undefined;
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
    )}&zoom=19&addressdetails=1`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept-Language': 'ja' },
    });
    if (!res.ok) return undefined;
    const data = await res.json();
    const rawDisplayName: string | undefined = typeof data?.display_name === 'string' ? data.display_name : undefined;
    const addr = data?.address ?? {};
    const prefecture = addr.state;
    const city = addr.city || addr.town || addr.village || addr.hamlet || addr.municipality;
    const county = addr.county || addr.city_district;
    const area = addr.suburb || addr.quarter || addr.neighbourhood;
    const block = addr.road || addr.residential;
    const house = addr.house_number || addr.building || addr.house;
    const detail = block && house ? `${block} ${house}` : block || house;

    // 北海道札幌市…のように左から読める順番を優先し、重複は除去
    const seen = new Set<string>();
    const parts = [prefecture, city, county, area, detail, addr.postcode]
      .filter((p): p is string => !!p)
      .filter(p => {
        if (seen.has(p)) return false;
        seen.add(p);
        return true;
      });

    // display_name からも補完（元のカンマ区切りを保持して順序を崩さない）
    if (rawDisplayName) {
      const displayParts = rawDisplayName
        .split(',')
        .map((p: string) => p.trim())
        .filter(Boolean)
        .filter(p => {
          if (seen.has(p)) return false;
          seen.add(p);
          return true;
        });
      parts.push(...displayParts);
    }

    const text = parts.join(' ').trim();
    return text || rawDisplayName;
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
