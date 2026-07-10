import type { DriverIdentity } from '../domain/remoteTypes';
import type { RoutePoint } from '../domain/types';
import type { NativeResidentLocationPoint } from '../services/nativeResidentLocation';

export function canUseNativeResidentLocation(input: {
  isAndroidNative: boolean;
  identity: DriverIdentity;
  setupReady: boolean;
}) {
  const { identity } = input;
  return input.isAndroidNative
    && input.setupReady
    && identity.configured
    && identity.authInitialized
    && identity.profileComplete
    && identity.approvalStatus === 'approved';
}

export type NativeResidentRoutePoint = Omit<RoutePoint, 'id'> & { id: string };

export function normalizeNativeResidentRoutePoint(
  point: NativeResidentLocationPoint,
): NativeResidentRoutePoint | null {
  const id = typeof point.id === 'string' ? point.id.trim() : '';
  const tripId = typeof point.tripId === 'string' ? point.tripId.trim() : '';
  const ts = typeof point.ts === 'string' ? point.ts.trim() : '';
  if (!id || !tripId || !ts || !Number.isFinite(Date.parse(ts))) return null;
  if (!Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90) return null;
  if (!Number.isFinite(point.lng) || point.lng < -180 || point.lng > 180) return null;

  const accuracy = point.accuracy;
  const speed = point.speed;
  const heading = point.heading;
  return {
    id,
    tripId,
    ts,
    lat: point.lat,
    lng: point.lng,
    ...(typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0
      ? { accuracy }
      : {}),
    speed: typeof speed === 'number' && Number.isFinite(speed) && speed >= 0 ? speed : null,
    heading: typeof heading === 'number' && Number.isFinite(heading) ? heading : null,
    source: 'background',
  };
}

export function uniqueNativeResidentRoutePoints(
  points: NativeResidentLocationPoint[],
): NativeResidentRoutePoint[] {
  const seen = new Set<string>();
  const normalized: NativeResidentRoutePoint[] = [];
  for (const point of points) {
    const next = normalizeNativeResidentRoutePoint(point);
    if (!next || seen.has(next.id)) continue;
    seen.add(next.id);
    normalized.push(next);
  }
  return normalized;
}

export async function drainNativeResidentRoutePointQueue(input: {
  enabled: boolean;
  peek: (limit: number) => Promise<{
    points: NativeResidentLocationPoint[];
    remaining: number;
  }>;
  acknowledge: (ids: string[]) => Promise<{ remaining: number }>;
  addRoutePoint: (point: NativeResidentRoutePoint) => Promise<unknown>;
  batchSize?: number;
  maxBatches?: number;
}) {
  if (!input.enabled) return { persisted: 0, remaining: 0 };
  const batchSize = Math.max(1, Math.trunc(input.batchSize ?? 500));
  const maxBatches = Math.max(1, Math.trunc(input.maxBatches ?? 20));
  const persistedIds = new Set<string>();
  let persisted = 0;
  let remaining = 0;

  for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
    const result = await input.peek(batchSize);
    if (result.points.length === 0) {
      remaining = Math.max(0, Math.trunc(result.remaining));
      break;
    }
    const acknowledgedIds = [...new Set(result.points
      .map(point => typeof point.id === 'string' ? point.id.trim() : '')
      .filter(Boolean))];
    for (const point of uniqueNativeResidentRoutePoints(result.points)) {
      if (persistedIds.has(point.id)) continue;
      persistedIds.add(point.id);
      await input.addRoutePoint(point);
      persisted += 1;
    }
    const acknowledgement = await input.acknowledge(acknowledgedIds);
    remaining = Math.max(0, Math.trunc(acknowledgement.remaining));
    if (remaining === 0) break;
  }

  return { persisted, remaining };
}
