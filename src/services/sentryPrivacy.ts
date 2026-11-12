const WIPED_KEYS = new Set(['extra', 'extras', 'contexts', 'user', 'request', 'attachments']);

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

const SAFE_NUMERIC_KEYS = new Set([
  'lineno',
  'colno',
  'line',
  'column',
  'timestamp',
  'starttimestamp',
  'endtimestamp',
  'time',
  'duration',
  'count',
  'status',
  'statuscode',
  'length',
  'size',
  'code',
  'version',
  'row',
  'rows',
  'index',
  'level',
  'port',
  'inapp',
  'frame',
  'frames',
  'number',
]);

const POSTAL_CODE = /〒?\d{3}-\d{4}(?!-\d)/g;
const PHONE_NUMBER = /(?<!\d)0\d{1,4}(?:-\d{1,4}){2,3}(?!\d)/g;
const BLOCK_NUMBER = /(?<!\d)\d{1,4}-\d{1,4}-\d{1,4}(?!\d)/g;
const HYPHEN_DECIMAL = /(?<![A-Za-z0-9.])([+-]?\d{1,3})-(\d{2,8})(?![A-Za-z0-9])/g;
const KANJI_ADDRESS_NUMBER = /[〇零一二三四五六七八九十百千]+(?=丁目|番地|番|号)/g;
const QUERY_COORDINATE = /([?&#](?:lat|latitude|lng|lon|long|longitude|geo|x|y)=)([+-]?\d+(?:\.\d+)?)/gi;
const COORDINATE_PAIR = /(?<![A-Za-z0-9.])([+-]?\d{1,3}(?:\.\d{1,8})?)\s*(?:[,，]|\/|\s+)\s*([+-]?\d{1,3}(?:\.\d{1,8})?)(?![A-Za-z0-9.])/g;
const COORDINATE = /(?<![A-Za-z0-9.])[+-]?\d{1,3}\.\d{1,8}(?![A-Za-z0-9])/g;
const LABELED_COORDINATE = /((?:緯度|経度|latitude|longitude|lat|lng|lon)\s*[:=]?\s*)[+-]?\d{1,3}(?:\.\d{1,8})?/gi;
const IPV4 = /(?<![0-9])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![0-9])/g;
const ADDRESS = /(?:北海道|東京都|大阪府|京都府|[\u4e00-\u9fff]{2,3}県)[^\n。！？!?]{0,80}/g;
const LOCAL_ADDRESS = /[\u4e00-\u9fff]{1,12}(?:市|区|町|村)(?:[\u4e00-\u9fff0-9０-９\-－ー]{0,16}(?:丁目|番地|番|号))?|[\u4e00-\u9fff0-9０-９\-－ー]{0,12}\d*丁目(?:\d+番地?)?(?:\d+号)?|\d+番地\d*号?|\d+番\d+号/g;
const IC_NAME = /[\u3040-\u30ff\u4e00-\u9fff々ヶヵ][\u3040-\u30ff\u4e00-\u9fff々ヶヵ0-9A-Za-z・ー\-－]{0,30}?(?:IC|ＩＣ|JCT|ジャンクション|インターチェンジ|料金所)/g;
const VERSION_TEXT = /\d+\.\d+\.\d+(?:\.\d+)*/g;
const TIME_TEXT = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?|\d{1,2}:\d{2}(?::\d{2})?/g;
const LINE_TEXT = /(?:[A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|mjs|jsx|vue|java|kt)):\d+(?::\d+)?|行番号\s*\d+/gi;
const COUNT_TEXT = /\d+\s*件/g;

function normalizeKey(key: string): string {
  return key.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const KANJI_DIGIT: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

function parseKanjiNumber(token: string): number | null {
  let total = 0;
  let current = 0;
  for (const character of token) {
    if (character in KANJI_DIGIT) {
      current = KANJI_DIGIT[character];
      continue;
    }
    const unit = character === '十' ? 10 : character === '百' ? 100 : character === '千' ? 1000 : 0;
    if (!unit) return null;
    total += (current || 1) * unit;
    current = 0;
  }
  return total + current;
}

export function foldForScrub(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\u3000/g, ' ')
    .replace(/、/g, ',')
    .replace(/(?<=\d)[・･](?=\d)/g, '.')
    .replace(/(?<=\d)[－ー−‐‒–—―ｰ](?=\d)/g, '-');
}

function foldKanjiAddressNumbers(value: string): string {
  return value.replace(KANJI_ADDRESS_NUMBER, token => {
    const parsed = parseKanjiNumber(token);
    return parsed == null ? token : String(parsed);
  });
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

function decimalPlaces(value: number): number {
  if (!Number.isFinite(value) || Number.isInteger(value)) return 0;
  const text = String(value);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

export function isCoordinatePair(first: number, second: number): boolean {
  if (!Number.isFinite(first) || !Number.isFinite(second)) return false;
  if (Math.abs(first) > 180 || Math.abs(second) > 180) return false;
  if (Math.abs(first) > 90 && Math.abs(second) > 90) return false;
  if (Math.abs(first) > 90 || Math.abs(second) > 90) return true;
  const firstPlaces = decimalPlaces(first);
  const secondPlaces = decimalPlaces(second);
  if (firstPlaces >= 4 || secondPlaces >= 4) return true;
  return firstPlaces >= 2 && secondPlaces >= 2 && Math.abs(first) >= 20 && Math.abs(second) >= 20;
}

export function isStandaloneCoordinate(value: number): boolean {
  if (!Number.isFinite(value) || Math.abs(value) > 180) return false;
  const places = decimalPlaces(value);
  if (places >= 4) return true;
  return places >= 1 && Math.abs(value) >= 20 && Math.abs(value) <= 180;
}

function hold(pattern: RegExp, value: string, token: string, held: string[]): string {
  return value.replace(pattern, match => {
    held.push(match);
    return `\u0000${token}${held.length - 1}\u0000`;
  });
}

function restore(value: string, token: string, held: string[]): string {
  return value.replace(new RegExp(`\u0000${token}(\\d+)\u0000`, 'g'), (_match, index: string) => held[Number(index)] ?? '');
}

export function scrubSentryText(value: string): string {
  const versions: string[] = [];
  const times: string[] = [];
  const lines: string[] = [];
  const counts: string[] = [];
  let text = foldKanjiAddressNumbers(foldForScrub(value));
  text = hold(VERSION_TEXT, text, 'V', versions);
  text = hold(TIME_TEXT, text, 'T', times);
  text = hold(LINE_TEXT, text, 'L', lines);
  text = hold(COUNT_TEXT, text, 'C', counts);
  text = text
    .replace(PHONE_NUMBER, '[filtered]')
    .replace(POSTAL_CODE, '[filtered]')
    .replace(BLOCK_NUMBER, '[filtered]')
    .replace(HYPHEN_DECIMAL, (match, whole: string, fraction: string) => (
      isStandaloneCoordinate(Number(`${whole}.${fraction}`)) ? '[filtered]' : match
    ))
    .replace(QUERY_COORDINATE, (match, key: string, numeric: string) => {
      const valueAsNumber = Number(numeric);
      if (!Number.isFinite(valueAsNumber) || Math.abs(valueAsNumber) > 180) return match;
      return `${key}[filtered]`;
    })
    .replace(COORDINATE_PAIR, (match, first: string, second: string) => (
      isCoordinatePair(Number(first), Number(second)) ? '[filtered]' : match
    ))
    .replace(LABELED_COORDINATE, '$1[filtered]')
    .replace(COORDINATE, match => (isStandaloneCoordinate(Number(match)) ? '[filtered]' : match))
    .replace(IPV4, '[filtered]')
    .replace(ADDRESS, '[filtered]')
    .replace(LOCAL_ADDRESS, '[filtered]')
    .replace(IC_NAME, '[filtered]');
  text = restore(text, 'C', counts);
  text = restore(text, 'L', lines);
  text = restore(text, 'T', times);
  return restore(text, 'V', versions);
}

function scrubArray(values: unknown[]): unknown[] {
  const scrubbed = values.map(item => scrubNode(item));
  const output: unknown[] = [];
  for (let index = 0; index < scrubbed.length; index += 1) {
    const current = scrubbed[index];
    const next = scrubbed[index + 1];
    if (typeof current === 'number' && typeof next === 'number' && isCoordinatePair(current, next)) {
      output.push('[filtered]');
      index += 1;
      continue;
    }
    output.push(typeof current === 'number' && isStandaloneCoordinate(current) ? '[filtered]' : current);
  }
  return output;
}

function stripCoordinateFields(value: Record<string, unknown>): Record<string, unknown> {
  const numericKeys = Object.keys(value).filter(key => (
    typeof value[key] === 'number' && !SAFE_NUMERIC_KEYS.has(normalizeKey(key))
  ));
  const drop = new Set<string>();
  for (let left = 0; left < numericKeys.length; left += 1) {
    for (let right = left + 1; right < numericKeys.length; right += 1) {
      const first = value[numericKeys[left]];
      const second = value[numericKeys[right]];
      if (typeof first === 'number' && typeof second === 'number' && isCoordinatePair(first, second)) {
        drop.add(numericKeys[left]);
        drop.add(numericKeys[right]);
      }
    }
  }
  for (const key of numericKeys) {
    const numeric = value[key];
    if (!drop.has(key) && typeof numeric === 'number' && isStandaloneCoordinate(numeric)) drop.add(key);
  }
  if (drop.size === 0) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!drop.has(key)) output[key] = child;
  }
  return output;
}

function scrubNode(value: unknown): unknown {
  if (typeof value === 'string') return scrubSentryText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (value instanceof Error) return scrubSentryText(value.message);
  if (Array.isArray(value)) return scrubArray(value);
  if (!isPlainObject(value)) return undefined;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeKey(key);
    const foldedKey = key.normalize('NFKC');
    if (
      WIPED_KEYS.has(normalized)
      || SENSITIVE_KEYS.has(normalized)
      || RAW_SENSITIVE_KEYS.has(key)
      || RAW_SENSITIVE_KEYS.has(foldedKey)
    ) continue;
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
  return stripCoordinateFields(output);
}

function scrubDevice(device: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(device)) {
    const normalized = normalizeKey(key);
    if (normalized === 'name' || SENSITIVE_KEYS.has(normalized) || RAW_SENSITIVE_KEYS.has(key)) continue;
    const scrubbed = scrubNode(child);
    if (scrubbed !== undefined) output[key] = scrubbed;
  }
  return stripCoordinateFields(output);
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
