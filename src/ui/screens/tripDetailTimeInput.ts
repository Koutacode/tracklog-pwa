const MINUTE_MS = 60_000;
const JAPAN_OFFSET_MS = 9 * 60 * MINUTE_MS;

function utcWallTime(parts: number[]): number | null {
  const [year, month, day, hour, minute, second = 0, millisecond = 0] = parts;
  const date = new Date(0);
  // setUTCFullYear avoids Date.UTC interpreting years 0–99 as 1900–1999.
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute && date.getUTCSeconds() === second
    && date.getUTCMilliseconds() === millisecond ? date.getTime() : null;
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** Format a stored, explicitly zoned ISO timestamp as a Japan-time input value. */
export function toJapanTimeInput(ts: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})$/.exec(ts);
  if (!match || match[0] !== ts) return '';
  // Restored ISO timestamps may omit seconds or carry more than millisecond precision.
  // Only display calculations use milliseconds; unchanged edits retain the original string.
  const wall = utcWallTime([...match.slice(1, 7).map(part => Number(part ?? 0)), Number((match[7] ?? '').slice(0, 3).padEnd(3, '0'))]);
  const zone = match[8].replace(':', '');
  const offsetHours = zone === 'Z' ? 0 : Number(zone.slice(1, 3));
  const offsetMinutes = zone === 'Z' ? 0 : Number(zone.slice(3, 5));
  if (wall === null || offsetHours > 23 || offsetMinutes > 59) return '';
  const offset = (zone[0] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * MINUTE_MS;
  const japan = new Date(wall - offset + JAPAN_OFFSET_MS);
  const year = japan.getUTCFullYear();
  if (year < 1 || year > 9999) return '';
  return `${pad(year, 4)}-${pad(japan.getUTCMonth() + 1)}-${pad(japan.getUTCDate())}T${pad(japan.getUTCHours())}:${pad(japan.getUTCMinutes())}`;
}

/** Accept an exact calendar minute in Japan; reject Date's rollover coercions. */
export function parseJapanTimeInput(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match || match[0] !== value || Number(match[1]) < 1) return null;
  const wall = utcWallTime(match.slice(1).map(Number));
  return wall === null ? null : new Date(wall - JAPAN_OFFSET_MS).toISOString();
}

export type TripDetailTimeEdit =
  | { kind: 'unchanged'; iso: string }
  | { kind: 'invalid' }
  | { kind: 'changed'; iso: string };

export function resolveTripDetailTimeEdit(originalTs: string, value: string): TripDetailTimeEdit {
  const originalValue = toJapanTimeInput(originalTs);
  if (!originalValue) return { kind: 'invalid' };
  if (value === originalValue) return { kind: 'unchanged', iso: originalTs };
  const iso = parseJapanTimeInput(value);
  return iso === null ? { kind: 'invalid' } : { kind: 'changed', iso };
}
