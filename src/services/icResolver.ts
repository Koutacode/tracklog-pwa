export type IcResult = { icName: string; distanceM: number };

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/**
 * resolveNearestIC queries the Overpass API for motorway junctions (IC) near
 * the given latitude and longitude. It returns the name and distance of
 * the nearest interchange if found within the specified radius. If all
 * endpoints fail or no junction is found it returns null.
 */
export async function resolveNearestIC(
  lat: number,
  lon: number,
  radiusM = 5000,
): Promise<IcResult | null> {
  const query = `\n[out:json][timeout:12];\n(\n  node(around:${radiusM},${lat},${lon})['highway'='motorway_junction'];\n);\nout body;\n`.trim();
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams({ data: query }),
        signal: controller.signal,
      });
      if (!res.ok) continue;
      const json = await res.json();
      const nodes = (json.elements ?? []).filter((e: any) => e.type === 'node' && e.tags);
      if (nodes.length === 0) continue;
      let best: { name: string; d: number } | null = null;
      for (const n of nodes) {
        const name = n.tags.name ?? n.tags.ref;
        if (!name) continue;
        const d = haversineM(lat, lon, n.lat, n.lon);
        if (!best || d < best.d) best = { name, d };
      }
      if (best) {
        return { icName: best.name, distanceM: Math.round(best.d) };
      }
    } catch {
      // Continue to next endpoint on error
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
