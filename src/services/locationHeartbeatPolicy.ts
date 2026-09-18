import { resolveRoutePointTimestamp, type LocationPayload } from './routeTracking';

/** Scope both acquisition and its eventual result to one still-active trip. */
export async function requestLocationHeartbeatForActiveTrip(dependencies: {
  getActiveTripId: () => Promise<string | null>;
  acquireLocation: () => Promise<LocationPayload | null>;
  send: (location: LocationPayload, tripId: string) => Promise<void>;
}): Promise<void> {
  const tripId = await dependencies.getActiveTripId();
  if (!tripId) return;
  const location = await dependencies.acquireLocation();
  if (!location || await dependencies.getActiveTripId() !== tripId) return;
  await dependencies.send(location, tripId);
}

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
