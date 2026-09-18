import type { Geo } from '../domain/types';
import { requestActiveTripPosition } from './activeTripLocation';

/**
 * getGeo returns the current position from the browser's geolocation API. If
 * geolocation is unavailable or fails it resolves to undefined. The
 * implementation requests high accuracy and has sensible timeouts.
 */
export async function getGeo(): Promise<Geo | undefined> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return undefined;
  // Permission is not consent to collect outside a trip. Resolve lazily because
  // repositories also use reverseGeocode for already-recorded event positions.
  const { getActiveTripId } = await import('../db/repositories');
  const tripId = await getActiveTripId();
  if (!tripId) return undefined;
  const timeouts = [5000, 8000]; // try fast first, then a bit longer

  for (let i = 0; i < timeouts.length; i++) {
    if (await getActiveTripId() !== tripId) return undefined;
    // eslint-disable-next-line no-await-in-loop
    const position = await requestActiveTripPosition({
      enableHighAccuracy: true, timeout: timeouts[i], maximumAge: 30000,
    });
    if (await getActiveTripId() !== tripId) return undefined;
    if (position) return {
      lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy,
    };
    // brief delay before retry
    // eslint-disable-next-line no-await-in-loop
    await new Promise(r => setTimeout(r, 300));
  }
  return undefined;
}

/**
 * reverseGeocode queries HeartRails Geo API to get a human-readable address.
 * It degrades gracefully and returns undefined if network is unavailable or request fails.
 */
export async function reverseGeocode(geo: Geo): Promise<string | undefined> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return undefined;
  const { lat, lng } = geo;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `https://geoapi.heartrails.com/api/json?method=searchByGeoLocation&x=${lng}&y=${lat}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return undefined;
    const data = await res.json();

    if (data?.response?.location && data.response.location.length > 0) {
      // Return the prefecture, city, and town of the closest matching location
      const loc = data.response.location.sort((a: any, b: any) => a.distance - b.distance)[0];
      if (loc) {
        return `${loc.prefecture || ''}${loc.city || ''}${loc.town || ''}`.trim() || undefined;
      }
    }
    return undefined;
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
