import { getLatestRoutePointForTrip } from '../db/repositories';
import { getLatestNativeRecordedLocation } from './nativeResidentLocation';
import type { Geo } from '../domain/types';

type RecordedPoint = {
  tripId: string; ts: string; lat: number; lng: number; accuracy?: number | null; source?: string;
};

/** Reuse a recent fix, never request a new one while finishing a trip. */
export function selectRecordedTripEndGeo(
  tripId: string, atMs: number, points: readonly RecordedPoint[],
): Geo | undefined {
  const point = points.filter(value => {
    const ageMs = atMs - Date.parse(value.ts);
    return value.tripId === tripId && value.source !== 'event'
      && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 120_000
      && Number.isFinite(value.lat) && Math.abs(value.lat) <= 90
      && Number.isFinite(value.lng) && Math.abs(value.lng) <= 180
      && (value.accuracy == null || (Number.isFinite(value.accuracy)
        && value.accuracy >= 0 && value.accuracy <= 150));
  }).sort((a, b) => b.ts.localeCompare(a.ts))[0];
  if (!point) return undefined;
  return { lat: point.lat, lng: point.lng, ...(point.accuracy != null ? { accuracy: point.accuracy } : {}) };
}

export async function getRecordedTripEndGeo(tripId: string, atMs: number): Promise<Geo | undefined> {
  const [latest, nativeLatest] = await Promise.all([
    getLatestRoutePointForTrip(tripId, atMs),
    // A dedicated last-fix cache remains available even with a FIFO backlog.
    getLatestNativeRecordedLocation().catch(() => null),
  ]);
  return selectRecordedTripEndGeo(tripId, atMs, [...(latest ? [latest] : []), ...(nativeLatest ? [nativeLatest] : [])]);
}
