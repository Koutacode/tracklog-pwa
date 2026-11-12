const WIPED_KEYS = new Set(['extra', 'extras', 'contexts', 'user', 'request']);

const SENSITIVE_KEYS = new Set([
  'lat',
  'latitude',
  'lng',
  'lon',
  'longitude',
  'geo',
  'geolocation',
  'coords',
  'coordinates',
  'location',
  'position',
  'address',
  'formattedaddress',
  'streetaddress',
  'ic',
  'icname',
  'startic',
  'endic',
  'icnameestimate',
  'icnameestimatehistory',
  'icnamesearchsourceid',
  'icnamesearchaddressupdated',
  'interchange',
  'interchangename',
  'ip',
  'ipaddress',
  'servername',
  'devicename',
]);

const RAW_SENSITIVE_KEYS = new Set(['緯度', '経度', '住所', 'IC名', 'ＩＣ名']);

const DROPPED_BREADCRUMB_KINDS = new Set([
  'console',
  'fetch',
  'xhr',
  'navigation',
  'history',
  'http',
]);

const QUERY_COORDINATE = /([?&#](?:lat|latitude|lng|lon|long|longitude|geo)=)[^&#\s]*/gi;
const COORDINATE = /(?<![A-Za-z0-9.])[+-]?\d{1,3}\.\d{4,}(?![A-Za-z0-9])/g;
const IPV4 = /(?<![0-9])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![0-9])/g;
const ADDRESS = /(?:北海道|東京都|大阪府|京都府|[\u4e00-\u9fff]{2,3}県)[^\n。！？!?]{0,80}/g;
const IC_NAME = /[\u3040-\u30ff\u4e00-\u9fff々ヶヵ][\u3040-\u30ff\u4e00-\u9fff々ヶヵ0-9A-Za-z・ー\-－]{0,30}?(?:IC|ＩＣ|JCT|ジャンクション|インターチェンジ|料金所)/g;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isDroppedBreadcrumbKind(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  const head = normalized.split('.')[0] ?? normalized;
  return DROPPED_BREADCRUMB_KINDS.has(normalized) || DROPPED_BREADCRUMB_KINDS.has(head);
}

export function scrubSentryText(value: string): string {
  return value
    .replace(QUERY_COORDINATE, '$1[filtered]')
    .replace(COORDINATE, match => {
      const numeric = Number(match);
      if (!Number.isFinite(numeric) || Math.abs(numeric) > 180) return match;
      return '[filtered]';
    })
    .replace(IPV4, '[filtered]')
    .replace(ADDRESS, '[filtered]')
    .replace(IC_NAME, '[filtered]');
}

function scrubNode(value: unknown): unknown {
  if (typeof value === 'string') return scrubSentryText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (value instanceof Error) return scrubSentryText(value.message);
  if (Array.isArray(value)) return value.map(item => scrubNode(item));
  if (!isPlainObject(value)) return undefined;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeKey(key);
    if (WIPED_KEYS.has(normalized) || SENSITIVE_KEYS.has(normalized) || RAW_SENSITIVE_KEYS.has(key)) continue;
    if (normalized === 'breadcrumbs') {
      output[key] = scrubBreadcrumbList(child);
      continue;
    }
    if (normalized === 'device' && isPlainObject(child)) {
      output[key] = scrubDevice(child);
      continue;
    }
    const scrubbed = scrubNode(child);
    if (scrubbed !== undefined) output[key] = scrubbed;
  }
  return output;
}

function scrubDevice(device: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(device)) {
    const normalized = normalizeKey(key);
    if (normalized === 'name' || SENSITIVE_KEYS.has(normalized) || RAW_SENSITIVE_KEYS.has(key)) continue;
    const scrubbed = scrubNode(child);
    if (scrubbed !== undefined) output[key] = scrubbed;
  }
  return output;
}

function scrubBreadcrumbList(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(item => scrubSentryBreadcrumb(item))
      .filter((item): item is Record<string, unknown> => item !== null);
  }
  if (isPlainObject(value) && Array.isArray(value.values)) {
    return {
      ...scrubNode({ ...value, values: undefined }) as Record<string, unknown>,
      values: value.values
        .map(item => scrubSentryBreadcrumb(item))
        .filter((item): item is Record<string, unknown> => item !== null),
    };
  }
  return scrubNode(value);
}

export function scrubSentryBreadcrumb<T>(breadcrumb: T): T | null {
  try {
    if (!isPlainObject(breadcrumb)) return null;
    const category = typeof breadcrumb.category === 'string' ? breadcrumb.category : undefined;
    const type = typeof breadcrumb.type === 'string' ? breadcrumb.type : undefined;
    if (isDroppedBreadcrumbKind(category) || isDroppedBreadcrumbKind(type)) return null;
    return scrubNode(breadcrumb) as T;
  } catch {
    return null;
  }
}

export function scrubSentryEvent<T>(event: T): T | null {
  try {
    if (!isPlainObject(event)) return null;
    const type = typeof event.type === 'string' ? event.type : undefined;
    if (type === 'transaction' || type === 'profile' || type === 'replay_event' || type === 'feedback') {
      return null;
    }
    return scrubNode(event) as T;
  } catch {
    return null;
  }
}
