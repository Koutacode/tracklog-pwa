import { getJstDateInfo } from '../../../src/domain/jst.ts';
import {
  ALL_TOGGLE_DEFINITIONS,
  EXPRESSWAY_TOGGLE_DEFINITION,
  PERSISTED_BASIC_TOGGLE_DEFINITIONS,
  PERSISTED_TOGGLE_DEFINITIONS,
  findOpenToggleStart,
  resolveTogglePairing,
  type TogglePairDefinition,
  type TogglePairingEvent,
} from '../../../src/domain/togglePairing.ts';

/** Same order as inferLatestStatus in src/services/locationHeartbeat.ts. */
const STATUS_PRIORITY: readonly TogglePairDefinition[] = [
  PERSISTED_BASIC_TOGGLE_DEFINITIONS[4],
  PERSISTED_BASIC_TOGGLE_DEFINITIONS[0],
  PERSISTED_BASIC_TOGGLE_DEFINITIONS[1],
  PERSISTED_BASIC_TOGGLE_DEFINITIONS[2],
  PERSISTED_BASIC_TOGGLE_DEFINITIONS[3],
  PERSISTED_BASIC_TOGGLE_DEFINITIONS[5],
];

const STATE_BY_CHANNEL: Record<string, { state: string; label: string }> = {
  ferry: { state: 'フェリー', label: 'フェリー中' },
  rest: { state: '休息', label: '休息中' },
  break: { state: '休憩', label: '休憩中' },
  load: { state: '積込', label: '積込中' },
  unload: { state: '荷卸', label: '荷卸中' },
  work: { state: 'その他作業', label: 'その他作業中' },
};

const INTERVAL_LABEL: Record<string, string> = {
  rest: '休息',
  break: '休憩',
  load: '積込',
  unload: '荷卸',
  work: 'その他作業',
  ferry: 'フェリー',
  expressway: '高速道路',
  wait: '待機',
  drive: '走行',
};

const POINT_LABEL: Record<string, string> = {
  trip_start: '運行開始',
  trip_end: '運行終了',
  refuel: '給油',
  point_mark: '地点記録',
  expressway: '高速道路',
};

const TOGGLE_TYPES = new Set(ALL_TOGGLE_DEFINITIONS.flatMap(definition => [definition.start, definition.end]));

export const STALE_AFTER_MS = 15 * 60 * 1000;

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?:\+81|0\d{1,4})-?\d{1,4}-?\d{3,4}/;
const PHONE_EXACT_RE = new RegExp(`^(?:${PHONE_RE.source})$`);
const COORD_RE = /-?\d{1,3}\.\d{4,}/;
const KEY_RE = /lat|lng|lon|geo|phone|mail|odo|coord|accuracy|heading|altitude|speed|postal|town|route|address|extras|token|secret|password|bearer/i;
const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const GEO_WORD_RE = /\b(lat|lng|latitude|longitude|geo)\b/i;

/** Identifier fields. A DEVICE_ID_RE value skips the unanchored phone scan only. */
const ID_KEYS: ReadonlySet<string> = new Set(['device_id', 'trip_id', 'id', 'session_id']);

export type OpsPlace = {
  kind: 'ic' | 'municipality';
  name: string;
};

type OpsEventRow = {
  id: string;
  type: string;
  ts: string;
  address: string | null;
  icName: string | null;
  sessionKey: string | null;
  sessionId: string | null;
  autoReason: string | null;
};

type BuiltEvent = {
  kind: string;
  label: string;
  startMs: number;
  endMs: number | null;
  point: boolean;
  place: OpsPlace | null;
};

export function toJstIso(input: string): string {
  const ms = Date.parse(input);
  if (!Number.isFinite(ms)) throw new Error('invalid timestamp');
  const jst = new Date(ms + 9 * 60 * 60 * 1000);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())}T${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())}.${pad(jst.getUTCMilliseconds(), 3)}+09:00`;
}

export function isStale(seenAt: string | null | undefined, syncedAt: string): boolean {
  if (!seenAt) return true;
  const age = Date.parse(syncedAt) - Date.parse(seenAt);
  if (!Number.isFinite(age)) return true;
  return age > STALE_AFTER_MS;
}

/**
 * Prefecture + city (or county + town/village) from a saved Japanese address.
 * Town names and block numbers are dropped. Unparseable text is omitted.
 * Mirrors getTripDayMunicipality in src/ui/screens/TripDayReport.tsx.
 */
export function getOpsMunicipality(address: string | undefined): string | undefined {
  if (typeof address !== 'string' || !address.trim()) return undefined;
  const source = address.trim()
    .replace(/^日本[、,\s]*/, '')
    .replace(/^〒?\d{3}[-－]\d{4}[、,\s]*/, '');
  const prefecture = source.match(/^(北海道|東京都|京都府|大阪府|[^\s、,]{2,3}県)/)?.[1] ?? '';
  if (!prefecture) return undefined;
  const clean = source.slice(prefecture.length);
  const county = clean.match(/^([^\d\s、,]{1,12}郡)([^\d\s、,]{1,12}?[町村])/);
  if (county) return prefecture + county[1] + county[2];
  const city = clean.match(/^(四日市市|野々市市|廿日市市|[^\d\s、,]{1,12}?市)/);
  if (city) {
    const name = city[1];
    if (/[町村]/.test(name.slice(1, -1))) return undefined;
    const ward = clean.slice(name.length).match(/^([^\d\s、,]{1,10}?区)/)?.[1];
    return prefecture + name + (ward ?? '');
  }
  const district = clean.match(/^([^\d\s、,]{1,12}?[区町村])/);
  return district ? prefecture + district[1] : undefined;
}

function isDeviceShapedId(key: string, value: unknown): value is string {
  return ID_KEYS.has(key) && typeof value === 'string' && DEVICE_ID_RE.test(value);
}

export function findSensitive(value: unknown, path = '$'): string | null {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 10000) return path;
    return null;
  }
  if (typeof value === 'boolean') return null;
  if (typeof value === 'string') {
    if (EMAIL_RE.test(value) || PHONE_RE.test(value) || COORD_RE.test(value)) return path;
    if (GEO_WORD_RE.test(value)) return path;
    return null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findSensitive(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (KEY_RE.test(key)) return `${path}.${key}`;
      // UUIDs and android:/web: ids contain digit runs that match PHONE_RE.
      // The id itself is still rejected when it is a phone, email, or coordinate.
      if (isDeviceShapedId(key, child)) {
        if (EMAIL_RE.test(child) || PHONE_EXACT_RE.test(child) || COORD_RE.test(child) || GEO_WORD_RE.test(child)) {
          return `${path}.${key}`;
        }
        continue;
      }
      const found = findSensitive(child, `${path}.${key}`);
      if (found) return found;
    }
  }
  return null;
}

export function guardPublic(value: unknown): void {
  const found = findSensitive(value);
  if (found) throw new Error('sensitive_output_blocked');
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function cleanName(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/[\u0000-\u001f]/g, '');
  if (!trimmed || trimmed.length > 80) return null;
  if (EMAIL_RE.test(trimmed) || PHONE_RE.test(trimmed) || COORD_RE.test(trimmed)) return null;
  return trimmed;
}

function safeLabel(value: unknown): string | null {
  return cleanName(textOrNull(value));
}

function placeFrom(icName: string | null, address: string | null): OpsPlace | null {
  const ic = cleanName(icName);
  if (ic) return { kind: 'ic', name: ic };
  const municipality = cleanName(getOpsMunicipality(address ?? undefined) ?? null);
  if (municipality) return { kind: 'municipality', name: municipality };
  return null;
}

function readEvents(value: unknown): OpsEventRow[] {
  if (!Array.isArray(value)) return [];
  const rows: OpsEventRow[] = [];
  for (const item of value) {
    const event = record(item);
    if (!event) continue;
    const id = textOrNull(event.id);
    const type = textOrNull(event.type);
    const ts = textOrNull(event.ts);
    if (!id || !type || !ts || !Number.isFinite(Date.parse(ts))) continue;
    rows.push({
      id,
      type,
      ts,
      address: textOrNull(event.address),
      icName: textOrNull(event.ic_name),
      sessionKey: textOrNull(event.session_key),
      sessionId: textOrNull(event.session_id),
      autoReason: textOrNull(event.auto_reason),
    });
  }
  return rows;
}

function pairingEvents(rows: readonly OpsEventRow[]): TogglePairingEvent[] {
  return rows.map(row => {
    const extras: Record<string, unknown> = {};
    if (row.sessionKey && row.sessionId) extras[row.sessionKey] = row.sessionId;
    if (row.autoReason) extras.autoReason = row.autoReason;
    return {
      id: row.id,
      type: row.type,
      ts: row.ts,
      ...(Object.keys(extras).length ? { extras } : {}),
    };
  });
}

/**
 * Category walk copied from liveDriveStatus.categoryAfterEvent.
 * Ferry and expressway do not replace the base category.
 */
function categoryAfterEvent(
  type: string,
  currentCategory: string,
  tripActive: boolean,
): { category: string; tripActive: boolean } {
  switch (type) {
    case 'trip_start':
      return { category: 'drive', tripActive: true };
    case 'trip_end':
      return { category: 'idle', tripActive: false };
    case 'rest_start':
      return { category: 'rest', tripActive: true };
    case 'rest_end':
      return { category: 'drive', tripActive: true };
    case 'break_start':
      return { category: 'break', tripActive: true };
    case 'break_end':
    case 'load_end':
    case 'unload_end':
    case 'work_end':
      return { category: tripActive ? 'drive' : 'idle', tripActive };
    case 'load_start':
      return { category: 'load', tripActive: true };
    case 'unload_start':
      return { category: 'unload', tripActive: true };
    case 'work_start':
      return { category: 'work', tripActive: true };
    default:
      return { category: currentCategory, tripActive };
  }
}

function categoryTimeline(events: readonly TogglePairingEvent[]): { category: string; startedAt: string | null } {
  const normal = resolveTogglePairing(events, PERSISTED_TOGGLE_DEFINITIONS).normalEvents;
  const tripStartIndex = normal.findIndex(event => event.type === 'trip_start');
  if (tripStartIndex < 0) return { category: 'idle', startedAt: null };
  let category = 'idle';
  let tripActive = false;
  let startedAt: string | null = null;
  for (const event of normal.slice(tripStartIndex)) {
    const next = categoryAfterEvent(event.type, category, tripActive);
    if (next.category !== category || next.tripActive !== tripActive) startedAt = event.ts;
    else if (!startedAt) startedAt = event.ts;
    category = next.category;
    tripActive = next.tripActive;
  }
  return { category, startedAt };
}

function eventPlace(row: OpsEventRow | undefined): OpsPlace | null {
  if (!row) return null;
  return placeFrom(row.icName, row.address);
}

function rowById(rows: readonly OpsEventRow[]): Map<string, OpsEventRow> {
  return new Map(rows.map(row => [row.id, row]));
}

function buildIntervals(rows: readonly OpsEventRow[]): BuiltEvent[] {
  const events = pairingEvents(rows);
  const paired = resolveTogglePairing(events, ALL_TOGGLE_DEFINITIONS);
  const rowsById = rowById(rows);
  const built: BuiltEvent[] = [];

  for (const pair of paired.pairs) {
    const label = INTERVAL_LABEL[pair.definition.channel];
    if (!label) continue;
    const startMs = Date.parse(pair.start.ts);
    const endMs = Date.parse(pair.end.ts);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    const startRow = pair.start.id ? rowsById.get(pair.start.id) : undefined;
    const endRow = pair.end.id ? rowsById.get(pair.end.id) : undefined;
    built.push({
      kind: pair.definition.channel,
      label,
      startMs,
      endMs,
      point: false,
      place: eventPlace(startRow) ?? eventPlace(endRow),
    });
  }

  for (const open of paired.openStarts) {
    const label = INTERVAL_LABEL[open.definition.channel];
    if (!label) continue;
    const startMs = Date.parse(open.start.ts);
    if (!Number.isFinite(startMs)) continue;
    const startRow = open.start.id ? rowsById.get(open.start.id) : undefined;
    built.push({
      kind: open.definition.channel,
      label,
      startMs,
      endMs: null,
      point: false,
      place: eventPlace(startRow),
    });
  }

  for (const row of rows) {
    if (TOGGLE_TYPES.has(row.type)) continue;
    const label = POINT_LABEL[row.type];
    if (!label) continue;
    const startMs = Date.parse(row.ts);
    if (!Number.isFinite(startMs)) continue;
    built.push({
      kind: row.type,
      label,
      startMs,
      endMs: null,
      point: true,
      place: eventPlace(row),
    });
  }

  built.sort((left, right) => left.startMs - right.startMs || left.kind.localeCompare(right.kind) || left.label.localeCompare(right.label));
  return built;
}

function jstDayBounds(iso: string): { startMs: number; endMs: number; date: string } {
  const date = getJstDateInfo(iso).dateKey;
  const startMs = Date.parse(`${date}T00:00:00+09:00`);
  return { startMs, endMs: startMs + 86_400_000, date };
}

function overlapsToday(item: BuiltEvent, bounds: { startMs: number; endMs: number }, syncedAtMs: number): boolean {
  if (item.point) return item.startMs >= bounds.startMs && item.startMs < bounds.endMs;
  const endMs = item.endMs ?? syncedAtMs;
  return item.startMs < bounds.endMs && endMs > bounds.startMs;
}

function toPublicEvent(item: BuiltEvent): Record<string, unknown> {
  const publicEvent: Record<string, unknown> = {
    kind: item.kind,
    label: item.label,
    start_at: toJstIso(new Date(item.startMs).toISOString()),
    place: item.place,
  };
  if (!item.point) publicEvent.end_at = item.endMs == null ? null : toJstIso(new Date(item.endMs).toISOString());
  return publicEvent;
}

function currentPlace(rows: readonly OpsEventRow[]): OpsPlace | null {
  const ordered = [...rows].sort((left, right) => right.ts.localeCompare(left.ts) || right.id.localeCompare(left.id));
  for (const row of ordered) {
    const place = eventPlace(row);
    if (place) return place;
  }
  return null;
}

function readGeocode(payload: Record<string, unknown>): { lat: number; lng: number } | null {
  const hint = record(payload._reverse_geocode);
  if (!hint) return null;
  const lat = Number(hint.lat);
  const lng = Number(hint.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function legFor(tripStartedAt: string, syncedAt: string): { day_index: number; date: string } {
  const bounds = jstDayBounds(syncedAt);
  const start = jstDayBounds(tripStartedAt);
  const dayIndex = Math.floor((bounds.startMs - start.startMs) / 86_400_000) + 1;
  return { day_index: Math.max(1, dayIndex), date: bounds.date };
}

function sanitizeDevices(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const devices: Array<Record<string, unknown>> = [];
  for (const item of value) {
    const device = record(item);
    if (!device) continue;
    const deviceId = textOrNull(device.device_id);
    if (!deviceId || !DEVICE_ID_RE.test(deviceId)) continue;
    devices.push({
      device_id: deviceId,
      display_name: safeLabel(device.display_name),
      vehicle_label: safeLabel(device.vehicle_label),
    });
  }
  return devices;
}

function lastConfirmedAt(value: unknown): string | null {
  const text = textOrNull(value);
  if (!text || !Number.isFinite(Date.parse(text))) return null;
  return toJstIso(text);
}

function inactiveBody(syncedAt: string, seenAt: unknown): Record<string, unknown> {
  return {
    trip_active: false,
    synced_at: toJstIso(syncedAt),
    last_confirmed_at: lastConfirmedAt(seenAt),
    stale: false,
  };
}

export type BuiltOpsStatus = {
  status: number;
  body: Record<string, unknown>;
  geocode: { lat: number; lng: number } | null;
};

export function buildOpsStatus(raw: unknown): BuiltOpsStatus {
  const payload = record(raw);
  const syncedAt = textOrNull(payload?.synced_at);
  if (!payload || !syncedAt || !Number.isFinite(Date.parse(syncedAt))) {
    throw new Error('invalid_status_payload');
  }

  if (payload.trip_active !== true) {
    if (payload.selection_required === true) {
      const activeCount = Number(payload.active_count);
      return {
        status: 200,
        body: {
          trip_active: false,
          selection_required: true,
          active_count: Number.isInteger(activeCount) && activeCount > 1 && activeCount <= 10000 ? activeCount : 2,
          devices: sanitizeDevices(payload.devices),
          synced_at: toJstIso(syncedAt),
          last_confirmed_at: lastConfirmedAt(payload.seen_at),
          stale: false,
        },
        geocode: null,
      };
    }
    return { status: 200, body: inactiveBody(syncedAt, payload.seen_at), geocode: null };
  }

  const tripId = textOrNull(payload.trip_id);
  const deviceId = textOrNull(payload.device_id);
  const tripStartedAt = textOrNull(payload.trip_started_at);
  if (!tripId || !deviceId || !DEVICE_ID_RE.test(deviceId) || !tripStartedAt || !Number.isFinite(Date.parse(tripStartedAt))) {
    throw new Error('invalid_status_payload');
  }

  const rows = readEvents(payload.events);
  const events = pairingEvents(rows);
  const normalEvents = resolveTogglePairing(events, PERSISTED_TOGGLE_DEFINITIONS).normalEvents;
  let state = normalEvents.length > 0
    ? { state: '走行', label: '走行中' }
    : { state: '待機', label: '待機中' };
  let startedAt: string | null = null;
  for (const definition of STATUS_PRIORITY) {
    const open = findOpenToggleStart(normalEvents, definition);
    const mapped = STATE_BY_CHANNEL[definition.channel];
    if (open && mapped) {
      state = mapped;
      startedAt = open.ts;
      break;
    }
  }
  if (!startedAt && state.state === '走行') {
    const timeline = categoryTimeline(events);
    startedAt = timeline.category === 'drive' ? timeline.startedAt : null;
    if (!startedAt) {
      startedAt = normalEvents.find(event => event.type === 'trip_start')?.ts ?? null;
    }
  }

  const ferryOpen = !!findOpenToggleStart(normalEvents, PERSISTED_BASIC_TOGGLE_DEFINITIONS[4]);
  const expresswayOpen = !!findOpenToggleStart(normalEvents, EXPRESSWAY_TOGGLE_DEFINITION);
  const intervals = buildIntervals(rows);
  const syncedAtMs = Date.parse(syncedAt);
  const today = jstDayBounds(syncedAt);
  const place = currentPlace(rows);
  const body: Record<string, unknown> = {
    trip_active: true,
    trip_id: tripId,
    device_id: deviceId,
    trip_started_at: toJstIso(tripStartedAt),
    state: state.state,
    state_label: state.label,
    state_started_at: startedAt ? toJstIso(startedAt) : null,
    flags: { ferry: ferryOpen, expressway: expresswayOpen },
    place,
    events_today: intervals.filter(item => overlapsToday(item, today, syncedAtMs)).map(toPublicEvent),
    trip_events: intervals.map(toPublicEvent),
    leg: legFor(tripStartedAt, syncedAt),
    synced_at: toJstIso(syncedAt),
    last_confirmed_at: lastConfirmedAt(payload.seen_at),
    stale: isStale(textOrNull(payload.seen_at), syncedAt),
  };

  return {
    status: 200,
    body,
    geocode: place ? null : readGeocode(payload),
  };
}

export function applyCoarsePlace(
  body: Record<string, unknown>,
  place: OpsPlace | null,
): Record<string, unknown> {
  if (body.trip_active !== true || body.place != null || !place) return body;
  if (place.kind !== 'municipality') return body;
  const name = cleanName(place.name);
  if (!name) return body;
  return { ...body, place: { kind: 'municipality', name } };
}
