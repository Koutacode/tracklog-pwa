import { resolveRoutePointTimestamp, type LocationPayload } from './routeTracking';

export function resolveLocationHeartbeatPayload(
  location: LocationPayload,
  nowMs: number,
  lastAcceptedAt: number | null,
): LocationPayload | null {
  if (
    !Number.isFinite(location.lat)
    || location.lat < -90
    || location.lat > 90
    || !Number.isFinite(location.lng)
    || location.lng < -180
    || location.lng > 180
  ) {
    return null;
  }
  const acceptedAt = resolveRoutePointTimestamp(location.time, nowMs, lastAcceptedAt);
  if (acceptedAt == null) return null;
  return { ...location, time: acceptedAt };
}
