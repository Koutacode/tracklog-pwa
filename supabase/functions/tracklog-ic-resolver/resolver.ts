export type OverpassTags = Record<string, string | undefined>;

export type OverpassElement = {
  type?: string;
  id?: number | string;
  lat?: number;
  lon?: number;
  center?: {
    lat?: number;
    lon?: number;
  };
  tags?: OverpassTags;
};

export type IcResult = {
  icName: string;
  distanceM: number;
};

export type ExpresswayResolution = {
  resolved: true;
  provider: 'overpass';
  onExpresswayRoad: boolean;
  nearIc: boolean;
  nearEtcGate: boolean;
  nearestIc: IcResult | null;
  cached: boolean;
};

type CandidateSource =
  | 'junction'
  | 'toll_booth'
  | 'toll_gantry'
  | 'motorway_link'
  | 'motorway';

type TaggedName = {
  raw: string;
  tag: string;
  tagPriority: number;
};

export type RankedIcCandidate = IcResult & {
  source: CandidateSource;
  score: number;
};

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type OverpassFetchOptions = {
  endpoints?: readonly string[];
  fetchImpl?: FetchLike;
  retryRounds?: number;
  timeoutMs?: number;
  totalTimeoutMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
};

type ResolveOptions = OverpassFetchOptions;

type CacheEntry = {
  elements: OverpassElement[];
  expiresAt: number;
};

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
] as const;

export const OVERPASS_REQUEST_TIMEOUT_MS = 10000;
// Leave seven seconds within the client's 35-second deadline for Edge auth,
// device lookup and the final response. The last provider gets only the
// remaining allowance, including its response body.
export const OVERPASS_TOTAL_TIMEOUT_MS = 28000;
export const OVERPASS_RETRY_ROUNDS = 1;
const OVERPASS_QUERY_TIMEOUT_SEC = 8;
const ENDPOINT_FAILURE_COOLDOWN_MS = 15000;
const ENDPOINT_RATE_LIMIT_COOLDOWN_MS = 30000;
const ENDPOINT_REJECTION_COOLDOWN_MS = 3 * 60 * 1000;
const MAX_ENDPOINT_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const MIN_RADIUS_M = 250;
const MAX_RADIUS_M = 12000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const EMPTY_CACHE_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 192;
const MAX_OVERPASS_ELEMENTS = 5000;
const NEAR_IC_DISTANCE_M = 1200;
// Keep candidate acceptance aligned with src/services/icResolver.ts.
const CORROBORATED_IC_DISTANCE_M = 2000;
const NEAR_GATE_DISTANCE_M = 220;
const NEAR_LINK_DISTANCE_M = 650;

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<OverpassElement[]>>();
// This is a per-isolate circuit breaker, with no extra database writes. A
// rejected endpoint must not receive another immediate request from a new cell.
const endpointCooldowns = new Map<string, { until: number; reason: string }>();

class OverpassRequestError extends Error {
  readonly cooldownMs: number;

  constructor(message: string, cooldownMs = ENDPOINT_FAILURE_COOLDOWN_MS) {
    super(message);
    this.cooldownMs = cooldownMs;
  }
}

export class OverpassUnavailableError extends Error {
  constructor(message = 'All Overpass endpoints are unavailable') {
    super(message);
    this.name = 'OverpassUnavailableError';
  }
}

export function normalizeRadiusM(value: number) {
  if (!Number.isFinite(value)) return 8000;
  return Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, Math.round(value)));
}

function coordinate(value: number) {
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

export function buildOverpassUnionQuery(lat: number, lon: number, radiusM: number) {
  const radius = normalizeRadiusM(radiusM);
  const gateRadius = Math.min(radius, 2200);
  const motorwayRadius = Math.min(radius, 350);
  const point = `${coordinate(lat)},${coordinate(lon)}`;
  return [
    `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT_SEC}];`,
    '(',
    `  node(around:${radius},${point})["highway"="motorway_junction"];`,
    `  nwr(around:${gateRadius},${point})["barrier"="toll_booth"];`,
    `  nwr(around:${gateRadius},${point})["highway"="toll_gantry"];`,
    `  way(around:${radius},${point})["highway"="motorway_link"];`,
    `  way(around:${motorwayRadius},${point})["highway"="motorway"];`,
    ');',
    'out body center;',
  ].join('\n');
}

function delay(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function retryAfterMs(value: string | null, now: number) {
  if (!value) return 0;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    // Preserve normal provider hints, but an overflowing digit string or a
    // wildly excessive delay must not permanently disable an endpoint.
    return Math.min(MAX_ENDPOINT_RETRY_AFTER_MS, seconds * 1000);
  }
  const date = Date.parse(trimmed);
  return Number.isFinite(date)
    ? Math.min(MAX_ENDPOINT_RETRY_AFTER_MS, Math.max(0, date - now))
    : 0;
}

function endpointLabel(endpoint: string) {
  try {
    // Never put URL paths, query strings, response bodies or GPS queries in
    // errors that can be persisted into an event or shown in the app.
    return new URL(endpoint).hostname.replace(/[^a-zA-Z0-9.-]/g, '').slice(0, 96) || 'endpoint';
  } catch {
    return 'endpoint';
  }
}

async function fetchElementsWithTimeout(
  endpoint: string,
  query: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  now: () => number,
): Promise<OverpassElement[]> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<OverpassElement[]>((_, reject) => {
    timer = setTimeout(() => {
      reject(new OverpassRequestError(`Overpass request timed out after ${timeoutMs}ms`));
      controller.abort();
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'User-Agent': 'TrackLog-IC-Resolver/1.0',
          },
          body: `data=${encodeURIComponent(query)}`,
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) {
          const minimumCooldown = response.status === 429
            ? ENDPOINT_RATE_LIMIT_COOLDOWN_MS
            : response.status === 406
              ? ENDPOINT_REJECTION_COOLDOWN_MS
              : ENDPOINT_FAILURE_COOLDOWN_MS;
          const cooldownMs = Math.max(minimumCooldown, retryAfterMs(response.headers.get('Retry-After'), now()));
          void response.body?.cancel().catch(() => undefined);
          throw new OverpassRequestError(`HTTP ${response.status}`, cooldownMs);
        }
        // Reading the body can stall after headers arrive. Keep it inside the
        // timeout race so another provider is still tried in that case.
        let body: { elements?: unknown; remark?: unknown } | null;
        try {
          body = await response.json();
        } catch {
          throw new OverpassRequestError('invalid JSON response');
        }
        if (typeof body?.remark === 'string' && body.remark.trim()) {
          // Overpass can send runtime errors with HTTP 200 and empty or partial
          // elements. Never cache those responses as successful lookups.
          throw new OverpassRequestError('Overpass returned an incomplete result (remark)');
        }
        if (!Array.isArray(body?.elements)) {
          throw new OverpassRequestError('response did not include an elements array');
        }
        return (body.elements as OverpassElement[]).slice(0, MAX_OVERPASS_ELEMENTS);
      })(),
      timeout,
    ]);
  } catch (error) {
    if (error instanceof OverpassRequestError) throw error;
    // Fetch and JSON implementations can include the private query in their
    // error text. Retain only our known, bounded failure descriptions.
    throw new OverpassRequestError('network request failed');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function fetchOverpassElements(
  query: string,
  options: OverpassFetchOptions = {},
): Promise<OverpassElement[]> {
  const endpoints = options.endpoints ?? OVERPASS_ENDPOINTS;
  if (endpoints.length === 0) throw new OverpassUnavailableError('No Overpass endpoints configured');
  const fetchImpl = options.fetchImpl ?? fetch;
  const retryRounds = Math.max(1, Math.round(options.retryRounds ?? OVERPASS_RETRY_ROUNDS));
  const timeoutMs = Math.min(OVERPASS_REQUEST_TIMEOUT_MS, Math.max(50, Math.round(options.timeoutMs ?? OVERPASS_REQUEST_TIMEOUT_MS)));
  const totalTimeoutMs = Math.min(OVERPASS_TOTAL_TIMEOUT_MS, Math.max(50, Math.round(options.totalTimeoutMs ?? OVERPASS_TOTAL_TIMEOUT_MS)));
  const now = options.now ?? Date.now;
  const deadline = now() + totalTimeoutMs;
  const sleep = options.sleep ?? delay;
  let attempts = 0;
  const errors = new Map<string, string>();
  for (const [endpoint, cooldown] of endpointCooldowns) {
    if (cooldown.until <= now()) endpointCooldowns.delete(endpoint);
  }

  for (let round = 0; round < retryRounds; round += 1) {
    for (const endpoint of endpoints) {
      const remainingMs = deadline - now();
      if (remainingMs <= 0) break;
      const cooldown = endpointCooldowns.get(endpoint);
      if (cooldown && cooldown.until > now()) {
        errors.set(endpoint, `${endpointLabel(endpoint)} ${cooldown.reason} (cooldown)`);
        continue;
      }
      attempts += 1;
      try {
        const elements = await fetchElementsWithTimeout(endpoint, query, fetchImpl, Math.min(timeoutMs, remainingMs), now);
        endpointCooldowns.delete(endpoint);
        return elements;
      } catch (error) {
        const failure = error instanceof OverpassRequestError ? error : new OverpassRequestError('request failed');
        errors.set(endpoint, `${endpointLabel(endpoint)} ${failure.message}`);
        endpointCooldowns.set(endpoint, { until: now() + failure.cooldownMs, reason: failure.message });
      }
    }
    if (deadline <= now() || round + 1 >= retryRounds) break;
    // Explicit retryRounds remains supported, but never bypass an endpoint's
    // cooldown or wait here for a banned/rate-limited provider to recover.
    if (!endpoints.some(endpoint => (endpointCooldowns.get(endpoint)?.until ?? 0) <= now())) break;
    await sleep(Math.min(150 * 2 ** round, deadline - now()));
  }

  const reasons = [...errors.values()].slice(0, 6);
  if (deadline <= now()) reasons.push('Overpass total request timeout');
  throw new OverpassUnavailableError(
    `Overpass request failed after ${attempts} attempts: ${reasons.join('; ') || 'endpoints unavailable'}`,
  );
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number) {
  const earthRadiusM = 6371000;
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function elementPoint(element: OverpassElement) {
  const lat = Number(element.lat ?? element.center?.lat);
  const lon = Number(element.lon ?? element.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function classifySource(element: OverpassElement): CandidateSource | null {
  const tags = element.tags;
  if (!tags) return null;
  if (tags.highway === 'motorway_junction') return 'junction';
  if (tags.barrier === 'toll_booth') return 'toll_booth';
  if (tags.highway === 'toll_gantry') return 'toll_gantry';
  if (tags.highway === 'motorway_link') return 'motorway_link';
  if (tags.highway === 'motorway') return 'motorway';
  return null;
}

function hasJapaneseText(value: string) {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(value);
}

function isIcLikeName(value: string) {
  return /(?:IC|SIC|JCT|PA|SA|インターチェンジ|インター|ジャンクション|料金所|スマート|出口|入口)/i.test(value);
}

function isRoadReferenceOnly(value: string) {
  const compact = value.replace(/\s+/g, '');
  return (
    /^(?:E|C)?\d+[A-Z]?(?:-\d+)?$/i.test(compact) ||
    /^(?:国道|都道府県道)\d+号?$/i.test(compact)
  );
}

function splitTagValues(value: string) {
  return value
    .split(/[;,|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function collectTaggedNames(tags: OverpassTags, source: CandidateSource): TaggedName[] {
  const keysBySource: Record<CandidateSource, readonly string[]> = {
    junction: [
      'name:ja',
      'official_name:ja',
      'name',
      'official_name',
      'loc_name',
      'junction:ref',
      'ref',
      'alt_name:ja',
      'alt_name',
    ],
    toll_booth: [
      'name:ja',
      'official_name:ja',
      'name',
      'official_name',
      'loc_name',
      'operator',
      'ref',
      'alt_name:ja',
      'alt_name',
    ],
    toll_gantry: [
      'name:ja',
      'official_name:ja',
      'name',
      'official_name',
      'loc_name',
      'operator',
      'ref',
      'alt_name:ja',
      'alt_name',
    ],
    motorway_link: [
      'name:ja',
      'official_name:ja',
      'name',
      'official_name',
      'destination',
      'destination:to',
      'to',
      'destination:ref',
      'ref',
      'alt_name:ja',
      'alt_name',
    ],
    motorway: [
      'name:ja',
      'official_name:ja',
      'name',
      'official_name',
      'destination',
      'destination:to',
      'ref',
      'alt_name:ja',
      'alt_name',
    ],
  };

  const names: TaggedName[] = [];
  keysBySource[source].forEach((tag, tagPriority) => {
    const raw = tags[tag];
    if (typeof raw !== 'string' || !raw.trim()) return;
    for (const value of splitTagValues(raw)) {
      names.push({ raw: value, tag, tagPriority });
    }
  });
  return names;
}

export function normalizeIcCandidateName(raw: string, source: CandidateSource) {
  const hadEntranceOrExit = /(?:入口|出口)\s*$/u.test(raw);
  let name = raw
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/スマートインターチェンジ/g, 'スマートIC')
    .replace(/スマートインター/g, 'スマートIC')
    .replace(/インターチェンジ/g, 'IC')
    .replace(/インター/g, 'IC')
    .replace(/ジャンクション/g, 'JCT')
    .replace(/\s*(?:入口|出口)\s*$/u, '')
    .replace(/\s+(IC|SIC|JCT|PA|SA)$/i, '$1')
    .trim();
  if (!name || isRoadReferenceOnly(name)) return null;

  if (
    (source === 'junction' || (source === 'motorway_link' && hadEntranceOrExit)) &&
    hasJapaneseText(name) && !isIcLikeName(name)
  ) {
    name = `${name}IC`;
  }

  if (name.length > (source === 'toll_booth' || source === 'toll_gantry' ? 48 : 40)) return null;
  if (/^(?:IC|SIC|JCT|PA|SA|ETC|料金所)$/i.test(name)) return null;
  if (source === 'junction') return isIcLikeName(name) || hasJapaneseText(name) ? name : null;
  if (source === 'toll_booth' || source === 'toll_gantry') {
    return hasJapaneseText(name) || isIcLikeName(name) ? name : null;
  }
  if (source === 'motorway_link') {
    return isIcLikeName(name) && (hasJapaneseText(name) || /(?:IC|SIC|JCT|PA|SA)/i.test(name)) ? name : null;
  }
  return isIcLikeName(name) && !/(?:高速道路|自動車道|Expressway|Motorway)$/i.test(name) ? name : null;
}

function sourcePenalty(source: CandidateSource) {
  const penalties: Record<CandidateSource, number> = {
    junction: 0,
    toll_booth: 260,
    toll_gantry: 320,
    motorway_link: 520,
    motorway: 720,
  };
  return penalties[source];
}

function nameQualityPenalty(name: TaggedName, normalized: string) {
  let penalty = name.tagPriority * 18;
  if (name.tag.endsWith(':ja')) penalty -= 70;
  if (name.tag.startsWith('destination')) penalty += 90;
  if (name.tag === 'operator') penalty += 120;
  if (/(?:IC|SIC|JCT|料金所|スマート)/i.test(normalized)) penalty -= 45;
  if (hasJapaneseText(normalized)) penalty -= 25;
  return penalty;
}

export function rankIcCandidates(
  elements: OverpassElement[],
  lat: number,
  lon: number,
  maxDistanceM = Number.POSITIVE_INFINITY,
): RankedIcCandidate[] {
  const byName = new Map<string, RankedIcCandidate>();
  for (const element of elements) {
    const source = classifySource(element);
    const point = elementPoint(element);
    if (!source || !point || !element.tags) continue;
    const distanceM = Math.round(haversineM(lat, lon, point.lat, point.lon));
    // Filter before deduplicating names: an out-of-range junction can have a
    // better score than an in-range toll booth with the same name.
    if (distanceM > maxDistanceM) continue;

    for (const taggedName of collectTaggedNames(element.tags, source)) {
      if (taggedName.tag === 'operator' && !isIcLikeName(taggedName.raw)) continue;
      const icName = normalizeIcCandidateName(taggedName.raw, source);
      if (!icName) continue;
      const score = distanceM + sourcePenalty(source) + nameQualityPenalty(taggedName, icName);
      const key = icName.replace(/\s+/g, '').toLocaleUpperCase('ja-JP');
      const previous = byName.get(key);
      if (!previous || score < previous.score) {
        byName.set(key, { icName, distanceM, source, score });
      }
    }
  }
  return [...byName.values()].sort(
    (left, right) => left.score - right.score || left.distanceM - right.distanceM,
  );
}

export function analyzeOverpassElements(
  elements: OverpassElement[],
  lat: number,
  lon: number,
): Omit<ExpresswayResolution, 'cached'> {
  let nearEtcGate = false;
  let onExpresswayRoad = false;

  for (const element of elements) {
    const source = classifySource(element);
    const point = elementPoint(element);
    if (!source) continue;
    if (source === 'motorway') {
      // The motorway arm of the union query is restricted to 350m.
      onExpresswayRoad = true;
    }
    if (!point) continue;
    const distanceM = haversineM(lat, lon, point.lat, point.lon);
    if ((source === 'toll_booth' || source === 'toll_gantry') && distanceM <= NEAR_GATE_DISTANCE_M) {
      nearEtcGate = true;
    }
    if (source === 'motorway_link' && distanceM <= NEAR_LINK_DISTANCE_M) {
      onExpresswayRoad = true;
    }
  }

  const nearbyCandidates = rankIcCandidates(elements, lat, lon, NEAR_IC_DISTANCE_M);
  const acceptableCandidates = nearEtcGate && onExpresswayRoad
    ? rankIcCandidates(elements, lat, lon, CORROBORATED_IC_DISTANCE_M)
    : nearbyCandidates;
  const nearestIc = acceptableCandidates[0] ?? null;

  return {
    resolved: true,
    provider: 'overpass',
    onExpresswayRoad,
    // Proximity is independent of name ranking, which may prefer a better
    // corroborated name beyond 1200m over a closer auxiliary candidate.
    nearIc: nearbyCandidates.length > 0,
    nearEtcGate,
    nearestIc: nearestIc ? { icName: nearestIc.icName, distanceM: nearestIc.distanceM } : null,
  };
}

function cacheKey(lat: number, lon: number, radiusM: number) {
  return `${lat.toFixed(3)}:${lon.toFixed(3)}:${normalizeRadiusM(radiusM)}`;
}

function rotateEndpoints(endpoints: readonly string[], key: string) {
  if (endpoints.length < 2) return [...endpoints];
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  const offset = hash % endpoints.length;
  return [...endpoints.slice(offset), ...endpoints.slice(0, offset)];
}

function pruneCache(now: number) {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

async function getOverpassElements(
  lat: number,
  lon: number,
  radiusM: number,
  options: ResolveOptions,
) {
  const now = options.now ?? Date.now;
  const key = cacheKey(lat, lon, radiusM);
  const currentTime = now();
  pruneCache(currentTime);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > currentTime) {
    cache.delete(key);
    cache.set(key, cached);
    return { elements: cached.elements, cached: true };
  }

  const pending = inFlight.get(key);
  if (pending) {
    return { elements: await pending, cached: true };
  }

  const endpoints = rotateEndpoints(options.endpoints ?? OVERPASS_ENDPOINTS, key);
  const request = fetchOverpassElements(buildOverpassUnionQuery(lat, lon, radiusM), {
    endpoints,
    fetchImpl: options.fetchImpl,
    retryRounds: options.retryRounds,
    timeoutMs: options.timeoutMs,
    totalTimeoutMs: options.totalTimeoutMs,
    now: options.now,
    sleep: options.sleep,
  });
  inFlight.set(key, request);
  try {
    const elements = await request;
    cache.set(key, {
      elements,
      expiresAt: now() + (elements.length > 0 ? CACHE_TTL_MS : EMPTY_CACHE_TTL_MS),
    });
    return { elements, cached: false };
  } finally {
    inFlight.delete(key);
  }
}

export async function resolveExpresswayFromOverpass(
  lat: number,
  lon: number,
  radiusM: number,
  options: ResolveOptions = {},
): Promise<ExpresswayResolution> {
  const radius = normalizeRadiusM(radiusM);
  const { elements, cached } = await getOverpassElements(lat, lon, radius, options);
  return {
    ...analyzeOverpassElements(elements, lat, lon),
    cached,
  };
}

export function clearResolverCacheForTests() {
  cache.clear();
  inFlight.clear();
  endpointCooldowns.clear();
}
