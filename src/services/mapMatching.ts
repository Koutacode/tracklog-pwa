import type { RoutePoint } from '../domain/types';

export type LatLng = { lat: number; lng: number };

const OSRM_MATCH_ENDPOINT = 'https://router.project-osrm.org/match/v1/driving';
const MAX_POINTS_PER_REQUEST = 70;
const OVERLAP_POINTS = 6;

function distanceMeters(a: LatLng, b: LatLng) {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const r = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sin1 = Math.sin(dLat / 2);
  const sin2 = Math.sin(dLng / 2);
  const h = sin1 * sin1 + Math.cos(lat1) * Math.cos(lat2) * sin2 * sin2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

function splitIntoChunks(points: RoutePoint[]): RoutePoint[][] {
  if (points.length <= MAX_POINTS_PER_REQUEST) return [points];
  const chunks: RoutePoint[][] = [];
  let i = 0;
  while (i < points.length) {
    const end = Math.min(points.length, i + MAX_POINTS_PER_REQUEST);
    const chunk = points.slice(i, end);
    chunks.push(chunk);
    if (end >= points.length) break;
    i = end - OVERLAP_POINTS;
  }
  return chunks;
}

async function fetchOsrmMatch(points: RoutePoint[]): Promise<LatLng[] | null> {
  if (points.length < 2) {
    return points.map(p => ({ lat: p.lat, lng: p.lng }));
  }
  const coords = points.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const radiuses = points
    .map(p => {
      const acc = Number(p.accuracy);
      if (!Number.isFinite(acc)) return '25';
      const clamped = Math.max(5, Math.min(80, Math.round(acc)));
      return String(clamped);
    })
    .join(';');
  const timestamps = points
    .map(p => {
      const ms = new Date(p.ts).getTime();
      const sec = Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
      return String(sec);
    })
    .join(';');
  const url =
    `${OSRM_MATCH_ENDPOINT}/${coords}` +
    `?geometries=geojson&overview=full&steps=false&tidy=true&gaps=ignore` +
    `&radiuses=${encodeURIComponent(radiuses)}` +
    `&timestamps=${encodeURIComponent(timestamps)}`;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 7000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const json = await res.json();
    const matchings = Array.isArray(json.matchings) ? json.matchings : [];
    if (matchings.length === 0) return null;
    const best = [...matchings].sort((a, b) => Number(b.distance ?? 0) - Number(a.distance ?? 0))[0];
    const coordsArr = best?.geometry?.coordinates;
    if (!Array.isArray(coordsArr) || coordsArr.length === 0) return null;
    const path: LatLng[] = [];
    for (const item of coordsArr) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const lng = Number(item[0]);
      const lat = Number(item[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      path.push({ lat, lng });
    }
    return path.length > 0 ? path : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function mapMatchRoutePoints(points: RoutePoint[]): Promise<{
  path: LatLng[];
  provider: 'osrm' | 'raw';
}> {
  if (points.length < 2) {
    return { path: points.map(p => ({ lat: p.lat, lng: p.lng })), provider: 'raw' };
  }
  const chunks = splitIntoChunks(points);
  const merged: LatLng[] = [];
  let usedOsrm = false;
  for (const chunk of chunks) {
    const matched = await fetchOsrmMatch(chunk);
    const part = matched ?? chunk.map(p => ({ lat: p.lat, lng: p.lng }));
    if (matched) usedOsrm = true;
    if (merged.length === 0) {
      merged.push(...part);
      continue;
    }
    const prevLast = merged[merged.length - 1];
    let startIdx = 0;
    while (startIdx < part.length && distanceMeters(prevLast, part[startIdx]) < 6) {
      startIdx++;
    }
    merged.push(...part.slice(startIdx));
  }
  return { path: merged, provider: usedOsrm ? 'osrm' : 'raw' };
}

