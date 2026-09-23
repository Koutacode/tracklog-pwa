import { fetchOverpassElements, normalizeIcCandidateName, type OverpassElement } from './resolver.ts';

export type NamedIcCandidate = {
  id: string;
  icName: string;
  lat: number;
  lon: number;
  address?: string;
};

const NAME_KEYS = ['name:ja', 'official_name:ja', 'name', 'official_name'] as const;
const MAX_RESULTS = 12;

export function normalizeIcSearchQuery(value: string) {
  const input = value.normalize('NFKC').trim();
  if (/[\u0000-\u001f\u007f]/.test(value) || input.length < 2 || input.length > 80) {
    throw new Error('IC名を2〜80文字で入力してください');
  }
  const query = input
    .replace(/(?:インターチェンジ|インター|IC)\s*$/i, '').trim();
  if (!query) {
    throw new Error('IC名を入力してください');
  }
  return query;
}

export function buildIcNameSearchQuery(value: string) {
  // Escape both regex syntax and the Overpass quoted string. No user-controlled
  // query operators, URLs or device positions are accepted by this endpoint.
  const normalized = normalizeIcSearchQuery(value);
  const literal = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A one-character place name (e.g. 津IC) is valid; bound it to that complete
  // name rather than matching every interchange containing the character.
  const pattern = JSON.stringify(normalized.length === 1
    ? `^${literal}(インターチェンジ|インター|[ ]*IC)?(入口|出口)?$` : literal);
  const filters = ['["highway"="motorway_junction"]', '["barrier"="toll_booth"]',
    '["highway"="toll_gantry"]', '["highway"="motorway_link"]'];
  return ['[out:json][timeout:8];', '(', ...filters.flatMap(filter =>
    NAME_KEYS.map(key => `nwr(20,122,46,154)${filter}[${JSON.stringify(key)}~${pattern},i];`)),
  ');', 'out body center 100;'].join('\n');
}

function sameSite(a: NamedIcCandidate, b: NamedIcCandidate) {
  // Collapse duplicate entrance/exit OSM objects, not names in distant regions.
  const dy = (a.lat - b.lat) * 111_195;
  const dx = (a.lon - b.lon) * 111_195 * Math.cos(a.lat * Math.PI / 180);
  return a.icName === b.icName && Math.hypot(dx, dy) < 1000;
}

export function selectNamedIcCandidates(elements: OverpassElement[], value: string): NamedIcCandidate[] {
  const needle = normalizeIcSearchQuery(value).toLocaleLowerCase();
  const candidates: Array<NamedIcCandidate & { priority: number }> = [];
  for (const element of elements) {
    const tags = element.tags ?? {};
    const source = tags.highway === 'motorway_junction' ? 'junction'
      : tags.barrier === 'toll_booth' ? 'toll_booth'
      : tags.highway === 'toll_gantry' ? 'toll_gantry'
      : tags.highway === 'motorway_link' ? 'motorway_link' : null;
    if (!source || !['node', 'way', 'relation'].includes(element.type ?? '') ||
        !/^\d+$/.test(String(element.id ?? ''))) continue;
    const lat = Number(element.lat ?? element.center?.lat);
    const lon = Number(element.lon ?? element.center?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 20 || lat > 46 || lon < 122 || lon > 154) continue;
    // A destination tag can name an unrelated IC down the road. Only the
    // object's own name is admissible for an explicit name/address edit.
    const names = NAME_KEYS.map(key => tags[key]).filter((name): name is string => !!name);
    if (!names.some(name => name.normalize('NFKC').toLocaleLowerCase().includes(needle))) continue;
    const icName = names.map(name => normalizeIcCandidateName(name, source)).find(Boolean);
    if (!icName || !icName.toLocaleLowerCase().includes(needle)) continue;
    const prefecture = (tags['addr:province'] || tags['addr:state'] || '').trim();
    const municipality = (tags['addr:city'] || '').trim();
    // A lone street/house number is not a replacement address. Leave it out
    // so selecting this feature will resolve its public point's full locality.
    const address = (tags['addr:full']?.trim() || (prefecture && municipality
      ? [prefecture, municipality, tags['addr:suburb'], tags['addr:quarter'], tags['addr:neighbourhood'],
        tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join('') : '')).trim();
    candidates.push({ id: `${element.type}/${element.id}`, icName, lat, lon,
      ...(address ? { address: address.slice(0, 300) } : {}),
      priority: source === 'junction' ? 0 : source === 'motorway_link' ? 2 : 1 });
  }
  const exact = (name: string) => name.toLocaleLowerCase().replace(/(?:ic|インターチェンジ|インター)$/i, '') === needle;
  candidates.sort((a, b) => Number(exact(b.icName)) - Number(exact(a.icName)) ||
    a.priority - b.priority || a.icName.localeCompare(b.icName, 'ja'));
  const selected: NamedIcCandidate[] = [];
  for (const { priority: _priority, ...candidate } of candidates) {
    if (!selected.some(existing => sameSite(existing, candidate))) selected.push(candidate);
    if (selected.length === MAX_RESULTS) break;
  }
  return selected;
}

export async function searchExpresswayIcByName(value: string) {
  const elements = await fetchOverpassElements(buildIcNameSearchQuery(value));
  return { candidates: selectNamedIcCandidates(elements, value), attribution: '© OpenStreetMap contributors' };
}
