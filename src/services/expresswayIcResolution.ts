import { db } from '../db/db';
import {
  getPendingExpresswayEvents,
  markExpresswayResolveFailure,
  updateExpresswayResolved,
} from '../db/repositories';
import type { EventType, Geo, RoutePoint } from '../domain/types';
import {
  getRetryableIcResolverErrorCategory,
  resolveNearestIC,
  type IcResult,
} from './icResolver';
import {
  computeIcResolveDeferredBackoffMs,
  captureIcResolutionEventVersion,
  getNextIcResolveDeferredRetryCount,
} from './expresswayIcRetryPolicy';

export type ExpresswayIcResolutionSource =
  | 'immediate'
  | 'retry'
  | 'manual'
  | 'notification-end';

export type ExpresswayIcResolutionOutcome =
  | {
      status: 'resolved';
      source: ExpresswayIcResolutionSource;
      result: IcResult;
    }
  | {
      status: 'failed';
      source: ExpresswayIcResolutionSource;
      error: string;
    }
  | {
      status: 'deferred';
      source: ExpresswayIcResolutionSource;
      reason: 'offline' | 'temporary';
      error?: string;
    };

export type ExpresswayIcResolutionRequest = {
  eventId: string;
  geo?: Geo;
  source: ExpresswayIcResolutionSource;
  /** Recovery triggers bypass the stored delay and restart its backoff series. */
  resetDeferredBackoff?: boolean;
};

type EnqueueRequest = Omit<ExpresswayIcResolutionRequest, 'source'> & {
  source?: 'immediate' | 'notification-end';
};

type ExpresswayEventType = 'expressway' | 'expressway_start' | 'expressway_end';
const EXPRESSWAY_EVENT_TYPES = new Set<ExpresswayEventType>([
  'expressway',
  'expressway_start',
  'expressway_end',
]);
export const IC_GEO_FALLBACK_WINDOW_MS = 90 * 1000;
export const IC_GEO_UNKNOWN_ACCURACY_WINDOW_MS = 15 * 1000;
export const IC_GEO_MAX_ACCURACY_M = 100;
const inFlightByEventId = new Map<string, Promise<ExpresswayIcResolutionOutcome>>();
let retryBatchInFlight: Promise<boolean> | null = null;

function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine;
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : 'IC解決に失敗しました';
}

function isExpresswayEventType(type: EventType): type is ExpresswayEventType {
  return EXPRESSWAY_EVENT_TYPES.has(type as ExpresswayEventType);
}

/**
 * Historical route points did not always include an accuracy measurement, so
 * missing accuracy remains usable for an event's own historical geo. A
 * fallback route point applies an additional 15-second constraint below. A
 * recorded measurement must be finite and no worse than 100 m.
 */
export function isUsableIcResolutionGeo(geo: Geo | undefined): geo is Geo {
  if (!geo) return false;
  if (!Number.isFinite(geo.lat) || geo.lat < -90 || geo.lat > 90) return false;
  if (!Number.isFinite(geo.lng) || geo.lng < -180 || geo.lng > 180) return false;
  return geo.accuracy == null
    || (Number.isFinite(geo.accuracy) && geo.accuracy >= 0 && geo.accuracy <= IC_GEO_MAX_ACCURACY_M);
}

export function selectIcResolutionRoutePoint(
  points: readonly Pick<RoutePoint, 'ts' | 'lat' | 'lng' | 'accuracy'>[],
  eventTs: string,
  eventType?: ExpresswayEventType,
): Geo | undefined {
  const eventMs = Date.parse(eventTs);
  if (!Number.isFinite(eventMs)) return undefined;

  let best: {
    geo: Geo;
    deltaMs: number;
    directionRank: number;
    accuracyRank: number;
  } | undefined;
  for (const point of points) {
    const pointMs = Date.parse(point.ts);
    const geo: Geo = {
      lat: point.lat,
      lng: point.lng,
      ...(point.accuracy != null ? { accuracy: point.accuracy } : {}),
    };
    if (!Number.isFinite(pointMs) || !isUsableIcResolutionGeo(geo)) continue;
    const deltaMs = Math.abs(pointMs - eventMs);
    if (deltaMs > IC_GEO_FALLBACK_WINDOW_MS) continue;
    if (point.accuracy == null && deltaMs > IC_GEO_UNKNOWN_ACCURACY_WINDOW_MS) continue;
    const directionRank = eventType === 'expressway_start'
      ? (pointMs >= eventMs ? 0 : 1)
      : eventType === 'expressway_end'
        ? (pointMs <= eventMs ? 0 : 1)
        : 0;
    const accuracyRank = point.accuracy ?? Number.POSITIVE_INFINITY;
    if (
      !best
      || deltaMs < best.deltaMs
      || (
        deltaMs === best.deltaMs
        && (
          directionRank < best.directionRank
          || (directionRank === best.directionRank && accuracyRank < best.accuracyRank)
        )
      )
    ) {
      best = { geo, deltaMs, directionRank, accuracyRank };
    }
  }
  return best?.geo;
}

async function loadEventGeo(eventId: string, suppliedGeo?: Geo) {
  const event = await db.events.get(eventId);
  if (!event) throw new Error('イベントが見つかりません');
  if (!isExpresswayEventType(event.type)) {
    throw new Error('高速道路イベントではありません');
  }
  const expectedVersion = captureIcResolutionEventVersion(event);
  if (isUsableIcResolutionGeo(suppliedGeo)) return { geo: suppliedGeo, expectedVersion };
  if (isUsableIcResolutionGeo(event.geo)) return { geo: event.geo, expectedVersion };

  const eventMs = Date.parse(event.ts);
  if (!Number.isFinite(eventMs)) return { geo: undefined, expectedVersion };
  const windowStart = new Date(eventMs - IC_GEO_FALLBACK_WINDOW_MS).toISOString();
  const windowEnd = new Date(eventMs + IC_GEO_FALLBACK_WINDOW_MS).toISOString();
  const points = await db.routePoints
    .where('[tripId+ts]')
    .between([event.tripId, windowStart], [event.tripId, windowEnd], true, true)
    .toArray();
  return {
    geo: selectIcResolutionRoutePoint(points, event.ts, event.type),
    expectedVersion,
  };
}

async function performResolution(
  request: ExpresswayIcResolutionRequest,
): Promise<ExpresswayIcResolutionOutcome> {
  const eventId = request.eventId.trim();
  if (!eventId) throw new Error('eventId is required');
  const { geo, expectedVersion } = await loadEventGeo(eventId, request.geo);
  const guard = {
    expectedVersion,
    allowExistingManual: request.source === 'manual',
  };
  const preserveExistingManual = expectedVersion.resolvedManually;

  if (!isOnline()) {
    if (!preserveExistingManual) {
      await updateExpresswayResolved({ eventId, status: 'pending', guard });
    }
    return { status: 'deferred', source: request.source, reason: 'offline' };
  }

  if (!geo) {
    const message = 'イベント付近の有効な位置情報が見つかりません';
    // A later route point can still arrive after the event was persisted, so
    // retain the bounded retry/backoff rather than making the first miss final.
    if (!preserveExistingManual) {
      await markExpresswayResolveFailure({ eventId, errorMessage: message, guard });
    }
    return { status: 'failed', source: request.source, error: message };
  }

  try {
    const result = await resolveNearestIC(geo.lat, geo.lng);
    if (!result) throw new Error('近傍ICを取得できませんでした');
    await updateExpresswayResolved({
      eventId,
      status: 'resolved',
      icName: result.icName,
      icDistanceM: result.distanceM,
      clearManualResolution: request.source === 'manual',
      guard,
    });
    return { status: 'resolved', source: request.source, result };
  } catch (error) {
    const message = errorMessage(error);
    const deferredCategory = getRetryableIcResolverErrorCategory(error);
    if (deferredCategory) {
      const event = await db.events.get(eventId);
      const retryCount = getNextIcResolveDeferredRetryCount(
        event?.extras,
        request.resetDeferredBackoff === true || request.source === 'manual',
      );
      const retryDelayMs = computeIcResolveDeferredBackoffMs(deferredCategory, retryCount);
      if (!preserveExistingManual) {
        await updateExpresswayResolved({
          eventId,
          status: 'pending',
          nextRetryAt: new Date(Date.now() + retryDelayMs).toISOString(),
          errorMessage: message,
          retryCount,
          guard,
        });
      }
      return {
        status: 'deferred',
        source: request.source,
        reason: 'temporary',
        error: message,
      };
    }
    if (!preserveExistingManual) {
      await markExpresswayResolveFailure({ eventId, errorMessage: message, guard });
    }
    return { status: 'failed', source: request.source, error: message };
  }
}

export function resolveExpresswayIcResolution(
  request: ExpresswayIcResolutionRequest,
): Promise<ExpresswayIcResolutionOutcome> {
  const eventId = request.eventId.trim();
  const current = inFlightByEventId.get(eventId);
  if (current) return current;

  const next = performResolution({ ...request, eventId });
  inFlightByEventId.set(eventId, next);
  const clear = () => {
    if (inFlightByEventId.get(eventId) === next) {
      inFlightByEventId.delete(eventId);
    }
  };
  void next.then(clear, clear);
  return next;
}

/** Starts resolution after event persistence and returns without waiting for network I/O. */
export function enqueueExpresswayIcResolution(request: EnqueueRequest) {
  queueMicrotask(() => {
    void resolveExpresswayIcResolution({
      ...request,
      source: request.source ?? 'immediate',
    }).catch(() => {
      // The persisted pending event remains available to the retry worker.
    });
  });
}

/** Entry point for an expressway end accepted from a notification action. */
export function enqueueNotificationExpresswayEndIcResolution(input: {
  eventId: string;
  geo?: Geo;
}) {
  enqueueExpresswayIcResolution({
    ...input,
    source: 'notification-end',
  });
}

export async function retryPendingExpresswayIcResolutions(
  limit = 8,
  options?: { ignorePendingBackoff?: boolean },
): Promise<boolean> {
  if (retryBatchInFlight) return retryBatchInFlight;
  if (!isOnline()) return false;

  retryBatchInFlight = (async () => {
    const boundedLimit = Math.min(20, Math.max(1, Math.round(limit)));
    const pending = (await getPendingExpresswayEvents(undefined, options)).slice(0, boundedLimit);
    let updatedAny = false;
    for (const event of pending) {
      const outcome = await resolveExpresswayIcResolution({
        eventId: event.id,
        geo: event.geo,
        source: 'retry',
        resetDeferredBackoff: options?.ignorePendingBackoff === true,
      });
      if (outcome.status !== 'deferred') updatedAny = true;
    }
    return updatedAny;
  })();

  try {
    return await retryBatchInFlight;
  } finally {
    retryBatchInFlight = null;
  }
}

/**
 * Explicit recovery hook for online, sign-in, token refresh, or device
 * re-approval transitions. It bypasses the delay once and restarts backoff if
 * the dependency is still unavailable.
 */
export function retryPendingExpresswayIcResolutionsAfterRecovery(limit = 12) {
  return retryPendingExpresswayIcResolutions(limit, { ignorePendingBackoff: true });
}

export async function resolveExpresswayIcManually(eventId: string): Promise<IcResult> {
  const outcome = await resolveExpresswayIcResolution({ eventId, source: 'manual' });
  if (outcome.status === 'resolved') return outcome.result;
  if (outcome.status === 'deferred') {
    throw new Error(
      outcome.reason === 'offline'
        ? 'オフラインのためIC名を取得できません'
        : outcome.error || 'IC解決サーバーに一時的に接続できません',
    );
  }
  throw new Error(outcome.error);
}
