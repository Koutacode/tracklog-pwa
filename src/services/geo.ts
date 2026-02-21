import type { Geo } from '../domain/types';

type OrderedAddressParts = {
  postalCode?: string;
  country?: string;
  prefecture?: string;
  city?: string;
  ward?: string;
  locality?: string;
  street?: string;
  houseNumber?: string;
  building?: string;
};

function cleanPart(value?: string | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  return v ? v : undefined;
}

function normalizePostalCode(value?: string | null): string | undefined {
  const v = cleanPart(value);
  if (!v) return undefined;
  const digits = v.replace(/\D/g, '');
  if (digits.length === 7) {
    return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  }
  return v;
}

function appendUnique(parts: string[], value?: string | null) {
  const v = cleanPart(value);
  if (!v) return;
  if (parts.includes(v)) return;
  if (parts.some(p => p.includes(v))) return;
  const parentIdx = parts.findIndex(p => v.includes(p));
  if (parentIdx >= 0) {
    parts[parentIdx] = v;
    return;
  }
  parts.push(v);
}

function concatCompact(parts: Array<string | undefined>) {
  const out: string[] = [];
  for (const p of parts) appendUnique(out, p);
  return out.join('');
}

function concatSpaced(parts: Array<string | undefined>) {
  const out: string[] = [];
  for (const p of parts) appendUnique(out, p);
  return out.join(' ').trim();
}

function formatOrderedAddress(parts: OrderedAddressParts): string | undefined {
  const cityLine = concatCompact([parts.prefecture, parts.city, parts.ward, parts.locality]);
  const streetLine = concatCompact([parts.street, parts.houseNumber]);
  const tail = concatSpaced([cityLine, streetLine, cleanPart(parts.building)]);
  const head = concatSpaced([normalizePostalCode(parts.postalCode), cleanPart(parts.country)]);
  const merged = concatSpaced([head, tail]);
  return merged || undefined;
}

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
  if (typeof navigator !== 'undefined' && !navigator.onLine) return undefined;
  const { lat, lng } = geo;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 2500);
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
    const ordered = formatOrderedAddress({
      postalCode: addr.postcode,
      country: addr.country,
      prefecture: addr.state || addr.province,
      city: addr.city || addr.town || addr.village || addr.municipality,
      ward: addr.city_district || addr.county,
      locality: addr.suburb || addr.quarter || addr.neighbourhood || addr.hamlet,
      street: addr.road || addr.residential || addr.pedestrian,
      houseNumber: addr.house_number,
      building: addr.building || addr.house,
    });
    return ordered || rawDisplayName;
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
