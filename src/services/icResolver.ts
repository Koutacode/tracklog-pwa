export type IcResult = { icName: string; distanceM: number };

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export type ExpresswaySignal = {
  resolved: boolean;
  provider: 'overpass' | 'none';
  onExpresswayRoad: boolean;
  nearIc: boolean;
  nearEtcGate: boolean;
  nearestIc: IcResult | null;
};

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number) {
  const r = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

async function queryExpresswayOverpass(
  lat: number,
  lon: number,
  radiusM: number,
): Promise<{ elements: any[] } | null> {
  const query = `
[out:json][timeout:8];
(
  node(around:${radiusM},${lat},${lon})['highway'='motorway_junction'];
  way(around:65,${lat},${lon})['highway'~'^(motorway|motorway_link)$'];
  node(around:220,${lat},${lon})['barrier'='toll_booth'];
  node(around:220,${lat},${lon})['highway'='toll_gantry'];
);
out body;
  `.trim();
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams({ data: query }),
        signal: controller.signal,
      });
      if (!res.ok) continue;
      const json = await res.json();
      const elements = Array.isArray(json.elements) ? json.elements : [];
      return { elements };
    } catch {
      // continue to next endpoint
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * resolveNearestIC resolves the nearest IC/ETC point around the location.
 * Overpass-only implementation (Google/Cloud API not used).
 */
export async function resolveNearestIC(
  lat: number,
  lon: number,
  radiusM = 5000,
): Promise<IcResult | null> {
  const signal = await detectExpresswaySignal(lat, lon, radiusM);
  return signal.nearestIc;
}

export async function detectExpresswaySignal(
  lat: number,
  lon: number,
  radiusM = 5000,
): Promise<ExpresswaySignal> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return {
      resolved: false,
      provider: 'none',
      onExpresswayRoad: false,
      nearIc: false,
      nearEtcGate: false,
      nearestIc: null,
    };
  }

  const overpass = await queryExpresswayOverpass(lat, lon, radiusM);
  if (overpass) {
    const nodes = overpass.elements.filter((e: any) => e?.type === 'node' && e?.tags);
    const icNodes = nodes.filter((n: any) => n.tags.highway === 'motorway_junction');
    let nearestIc: IcResult | null = null;
    for (const n of icNodes) {
      const name = n.tags.name ?? n.tags.ref;
      if (!name || !Number.isFinite(n.lat) || !Number.isFinite(n.lon)) continue;
      const d = haversineM(lat, lon, n.lat, n.lon);
      if (!nearestIc || d < nearestIc.distanceM) {
        nearestIc = { icName: name, distanceM: Math.round(d) };
      }
    }
    const onExpresswayRoad = overpass.elements.some((e: any) => {
      if (e?.type !== 'way' || !e?.tags) return false;
      const hw = String(e.tags.highway ?? '');
      return hw === 'motorway' || hw === 'motorway_link';
    });
    const nearEtcGate = nodes.some((n: any) => {
      if (!Number.isFinite(n.lat) || !Number.isFinite(n.lon)) return false;
      const isEtcNode = n.tags.barrier === 'toll_booth' || n.tags.highway === 'toll_gantry';
      if (!isEtcNode) return false;
      return haversineM(lat, lon, n.lat, n.lon) <= 220;
    });
    return {
      resolved: true,
      provider: 'overpass',
      onExpresswayRoad,
      nearIc: !!nearestIc && nearestIc.distanceM <= 1200,
      nearEtcGate,
      nearestIc,
    };
  }

  return {
    resolved: false,
    provider: 'none',
    onExpresswayRoad: false,
    nearIc: false,
    nearEtcGate: false,
    nearestIc: null,
  };
}
