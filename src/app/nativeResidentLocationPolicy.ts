import type { DriverIdentity } from '../domain/remoteTypes';
import type { RoutePoint } from '../domain/types';
import type { NativeResidentLocationPoint } from '../services/nativeResidentLocation';

export type UnapprovedNativeLocationAction =
  | 'preserve-native-auth'
  | 'suspend-for-approval'
  | 'clear-rejected-auth'
  | 'clear-signed-out-auth';

/**
 * Keeps enrollment credentials available while a device is awaiting approval,
 * but preserves the stronger clear-auth behavior for rejection and sign-out.
 */
export function resolveUnapprovedNativeLocationAction(input: {
  authInitialized: boolean;
  approvalStatus: DriverIdentity['approvalStatus'];
  explicitSignOutRequested: boolean;
}): UnapprovedNativeLocationAction {
  if (input.explicitSignOutRequested) return 'clear-signed-out-auth';
  if (!input.authInitialized) return 'preserve-native-auth';
  if (input.approvalStatus === 'rejected') return 'clear-rejected-auth';
  return 'suspend-for-approval';
}

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

export type NativeResidentRoutePoint = Omit<RoutePoint, 'id'> & {
  id: string;
  /** Boot-scoped Android monotonic clock identity; not persisted by RoutePoint storage. */
  monotonicSessionId?: string;
  /** Android elapsedRealtime converted to milliseconds; meaningful only within its session. */
  elapsedRealtimeMs?: number;
};

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
  const monotonicSessionId = typeof point.monotonicSessionId === 'string'
    ? point.monotonicSessionId.trim()
    : '';
  const elapsedRealtimeMs = point.elapsedRealtimeMs;
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
    ...(monotonicSessionId ? { monotonicSessionId } : {}),
    ...(monotonicSessionId
      && typeof elapsedRealtimeMs === 'number'
      && Number.isFinite(elapsedRealtimeMs)
      && elapsedRealtimeMs >= 0
      ? { elapsedRealtimeMs }
      : {}),
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

/**
 * Preserve spool FIFO across boots. Within one contiguous boot session only,
 * elapsedRealtime is the authoritative order when the wall clock moves back.
 */
export function orderNativeResidentRoutePoints(
  points: NativeResidentRoutePoint[],
): NativeResidentRoutePoint[] {
  const ordered: NativeResidentRoutePoint[] = [];
  for (let index = 0; index < points.length;) {
    const first = points[index];
    const sessionId = first.monotonicSessionId;
    if (!sessionId) {
      ordered.push(first);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < points.length && points[end].monotonicSessionId === sessionId) end += 1;
    const sessionRun = points.slice(index, end);
    if (sessionRun.every(point => typeof point.elapsedRealtimeMs === 'number')) {
      const stableMonotonicRun = sessionRun
        .map((point, fifoIndex) => ({ point, fifoIndex }))
        .sort((a, b) => (
          a.point.elapsedRealtimeMs! - b.point.elapsedRealtimeMs!
          || a.fifoIndex - b.fifoIndex
        ))
        .map(item => item.point);
      ordered.push(...stableMonotonicRun);
      index = end;
      continue;
    }
    ordered.push(...sessionRun);
    index = end;
  }
  return ordered;
}

export async function drainNativeResidentRoutePointQueue(input: {
  enabled: boolean;
  peek: (limit: number) => Promise<{
    points: NativeResidentLocationPoint[];
    remaining: number;
  }>;
  acknowledge: (ids: string[]) => Promise<{ remaining: number }>;
  addRoutePoint: (point: NativeResidentRoutePoint) => Promise<unknown>;
  /** Runs only after the normalized point is durable in Dexie and before ack. */
  onPersistedPoint?: (point: NativeResidentRoutePoint) => Promise<void>;
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
    const chronologicalPoints = orderNativeResidentRoutePoints(
      uniqueNativeResidentRoutePoints(result.points),
    );
    for (const point of chronologicalPoints) {
      if (persistedIds.has(point.id)) continue;
      persistedIds.add(point.id);
      await input.addRoutePoint(point);
      await input.onPersistedPoint?.(point);
      persisted += 1;
    }
    const acknowledgement = await input.acknowledge(acknowledgedIds);
    remaining = Math.max(0, Math.trunc(acknowledgement.remaining));
    if (remaining === 0) break;
  }

  return { persisted, remaining };
}
