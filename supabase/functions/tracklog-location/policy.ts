export const LOCATION_UPLOAD_INTERVAL_MS = 30_000;

export function isValidCoordinate(value: unknown, min: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max;
}

export function isLocationUploadThrottled(lastLocationAt: unknown, nowMs: number) {
  if (typeof lastLocationAt !== 'string') return false;
  const lastMs = Date.parse(lastLocationAt);
  if (!Number.isFinite(lastMs)) return false;
  return nowMs - lastMs < LOCATION_UPLOAD_INTERVAL_MS;
}
