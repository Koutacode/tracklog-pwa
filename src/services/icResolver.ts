export type IcResult = { icName: string; distanceM: number };

type OverpassTags = Record<string, string | undefined>;

type OverpassElement = {
  type?: string;
  lat?: number;
  lon?: number;
  center?: {
    lat?: number;
    lon?: number;
  };
  tags?: OverpassTags;
};

type IcCandidate = IcResult & {
  score: number;
};

type CandidateSource = 'junction' | 'gate' | 'link' | 'motorway';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OVERPASS_TIMEOUT_MS = 9000;
const MAX_NAME_LEN_BY_SOURCE: Record<CandidateSource, number> = {
  junction: 34,
  gate: 48,
  link: 34,
  motorway: 36,
};

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
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}

async function queryExpresswayOverpass(
  lat: number,
  lon: number,
  radiusM: number,
): Promise<{ elements: OverpassElement[] } | null> {
  const gateRadiusM = Math.min(radiusM, 2200);
  const highwayRadiusM = Math.min(radiusM, 3000);
  const query = `
[out:json][timeout:12];
(
  node(around:${radiusM},${lat},${lon})["highway"="motorway_junction"];
  node(around:${gateRadiusM},${lat},${lon})["barrier"="toll_booth"];
  node(around:${gateRadiusM},${lat},${lon})["highway"="toll_gantry"];
  way(around:500,${lat},${lon})["highway"="motorway"]["name"];
  way(around:${highwayRadiusM},${lat},${lon})["highway"="motorway"]["ref"]["name"];
  way(around:${radiusM},${lat},${lon})["highway"="motorway_link"]["name"];
  way(around:${radiusM},${lat},${lon})["highway"="motorway_link"]["destination"];
);
out body center;
  `.trim();
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
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

function getTag(tags: OverpassTags | undefined, keys: string[]): string | null {
  if (!tags) return null;
  for (const key of keys) {
    const raw = tags[key];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  return null;
}

function elementPoint(element: OverpassElement): { lat: number; lon: number } | null {
  const lat = Number(element.lat ?? element.center?.lat);
  const lon = Number(element.lon ?? element.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function normalizeIcName(raw: string): string | null {
  let name = raw.replace(/\s+/g, ' ').trim();
  if (!name) return null;
  name = name
    .replace(/スマートインターチェンジ/g, 'スマートIC')
    .replace(/スマートインター/g, 'スマートIC')
    .replace(/インターチェンジ/g, 'IC')
    .replace(/インター/g, 'IC')
    .replace(/ＩＣ/g, 'IC')
    .replace(/\s*出口$/g, '')
    .replace(/\s*入口$/g, '')
    .trim();
  return name || null;
}

function isRoadRefOnly(name: string): boolean {
  const compact = name.replace(/\s+/g, '');
  return /^(?:E|C)?\d+[A-Z]?(?:-\d+)?$/i.test(compact) || /^国道\d+号?$/.test(compact);
}

function isRoadRefValue(name: string): boolean {
  const compact = name.replace(/\s+/g, '');
  return /^(?:E|C)?\d+[A-Z]?(?:-\d+)?$/i.test(compact) || /^(?:国道|都道府県道)\d+/i.test(compact);
}

function hasJapaneseText(name: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(name);
}

function isIcLikeName(name: string): boolean {
  return /(IC|SIC|JCT|PA|SA|料金所|スマート)/i.test(name);
}

function isExitLikeName(name: string): boolean {
  return isIcLikeName(name) || /(出口|入口|IC|JCT|PA|SA|料金所)/i.test(name);
}

function splitTagValues(raw: string): string[] {
  return raw
    .split(/[;,|]/)
    .map(v => v.trim())
    .filter(v => v.length > 0);
}

function shouldUseName(name: string, source: CandidateSource): boolean {
  if (!name || isRoadRefOnly(name) || isRoadRefValue(name)) return false;
  if (name.length > MAX_NAME_LEN_BY_SOURCE[source]) return false;
  if (isIcLikeName(name)) return true;
  if (source === 'junction') return hasJapaneseText(name);
  if (source === 'gate') return true;
  return hasJapaneseText(name) && isExitLikeName(name);
}

function normalizeCandidateName(raw: string, source: CandidateSource): string | null {
  const normalized = normalizeIcName(raw);
  if (!normalized || !shouldUseName(normalized, source)) return null;
  if (source === 'junction' && hasJapaneseText(normalized) && !isIcLikeName(normalized)) {
    return `${normalized}IC`;
  }
  return normalized;
}

function collectRawNames(tags: OverpassTags, source: CandidateSource): string[] {
  const values: string[] = [];
  const pushTag = (key: string) => {
    const raw = tags[key];
    if (typeof raw === 'string' && raw.trim()) {
      values.push(...splitTagValues(raw));
    }
  };

  if (source === 'junction') {
    ['name:ja', 'official_name:ja', 'name', 'official_name', 'loc_name', 'ref', 'junction:ref'].forEach(pushTag);
    return values;
  }

  if (source === 'gate') {
    ['name:ja', 'official_name:ja', 'name', 'operator', 'ref', 'note'].forEach(pushTag);
    return values;
  }

  ['name:ja', 'official_name:ja', 'name', 'official_name', 'destination', 'destination:ref', 'destination:to', 'to', 'ref'].forEach(pushTag);
  return values;
}

function extractIcName(element: OverpassElement, source: CandidateSource): string | null {
  const tags = element.tags;
  if (!tags) return null;
  for (const raw of collectRawNames(tags, source)) {
    const icName = normalizeCandidateName(raw, source);
    if (icName) return icName;
  }
  const fallback = getTag(tags, ['alt_name', 'alt_name:ja', 'nat_ref', 'old_name', 'old_name:ja']);
  return normalizeCandidateName(fallback ?? '', source);
}

function classifyCandidateSource(element: OverpassElement): CandidateSource | null {
  const tags = element.tags;
  if (!tags) return null;
  if (element.type === 'node' && tags.highway === 'motorway_junction') return 'junction';
  if (element.type === 'node' && (tags.barrier === 'toll_booth' || tags.highway === 'toll_gantry')) return 'gate';
  if (element.type === 'way' && tags.highway === 'motorway_link') return 'link';
  if (element.type === 'way' && tags.highway === 'motorway') return 'motorway';
  return null;
}

function buildIcCandidates(elements: OverpassElement[], lat: number, lon: number): IcCandidate[] {
  const sourcePriority: Record<CandidateSource, number> = {
    junction: 0,
    gate: 220,
    link: 520,
    motorway: 620,
  };
  const candidatesByName = new Map<string, IcCandidate>();
  for (const element of elements) {
    const source = classifyCandidateSource(element);
    if (!source) continue;
    const point = elementPoint(element);
    if (!point) continue;

    const rawNames = collectRawNames(element.tags ?? {}, source);
    const fallbackName = extractIcName(element, source);
    if (fallbackName) rawNames.push(fallbackName);

    for (const rawName of rawNames) {
      const icName = normalizeCandidateName(rawName, source);
      if (!icName) continue;
      const distanceM = Math.round(haversineM(lat, lon, point.lat, point.lon));
      const score = distanceM + sourcePriority[source];
      const existing = candidatesByName.get(icName);
      if (!existing || score < existing.score) {
        candidatesByName.set(icName, {
          icName,
          distanceM,
          score,
        });
      }
    }
  }
  return [...candidatesByName.values()].sort((a, b) => a.score - b.score || a.distanceM - b.distanceM);
}

/**
 * resolveNearestIC resolves the nearest IC/ETC point around the location.
 * Overpass-only implementation (Google/Cloud API not used).
 */
export async function resolveNearestIC(
  lat: number,
  lon: number,
  radiusM = 8000,
): Promise<IcResult | null> {
  const signal = await detectExpresswaySignal(lat, lon, radiusM);
  return signal.nearestIc;
}

export async function detectExpresswaySignal(
  lat: number,
  lon: number,
  radiusM = 8000,
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
    const nodes = overpass.elements.filter(e => e?.type === 'node' && e?.tags);
    const nearestIc = buildIcCandidates(overpass.elements, lat, lon)[0] ?? null;
    const onExpresswayRoad = overpass.elements.some(e => {
      if (e?.type !== 'way' || !e?.tags) return false;
      const hw = String(e.tags.highway ?? '');
      return hw === 'motorway' || hw === 'motorway_link';
    });
    const nearEtcGate = nodes.some(n => {
      const point = elementPoint(n);
      if (!point) return false;
      const tags = n.tags;
      if (!tags) return false;
      const isEtcNode = tags.barrier === 'toll_booth' || tags.highway === 'toll_gantry';
      if (!isEtcNode) return false;
      return haversineM(lat, lon, point.lat, point.lon) <= 220;
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
