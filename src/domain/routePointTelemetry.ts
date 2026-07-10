const MAX_ACCURACY_METERS = 100_000;
const MAX_SPEED_METERS_PER_SECOND = 500;
const MAX_HEADING_DEGREES = 360;

function boundedNumber(value: unknown, minimum: number, maximum: number): number | null {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) return null;
  return parsed;
}

export function inferSpeedKmh(distanceMeters: number, elapsedMs: number): number | null {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) return null;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  return (distanceMeters / 1_000) / (elapsedMs / 3_600_000);
}

export function normalizeRoutePointAccuracy(value: unknown): number | null {
  return boundedNumber(value, 0, MAX_ACCURACY_METERS);
}

export function normalizeRoutePointSpeed(value: unknown): number | null {
  return boundedNumber(value, 0, MAX_SPEED_METERS_PER_SECOND);
}

export function normalizeRoutePointHeading(value: unknown): number | null {
  return boundedNumber(value, 0, MAX_HEADING_DEGREES);
}
