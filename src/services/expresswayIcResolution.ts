import { db } from '../db/db';
import { IC_CATALOG_MAX_CANDIDATES, IC_CATALOG_MAX_DISTANCE_M } from '../../shared/ic-catalog/index';
import {
  getPendingExpresswayEvents,
  updateExpresswayResolved,
} from '../db/repositories';
import type { BaseEvent, EventType, Geo, RoutePoint } from '../domain/types';
import {
  getRetryableIcResolverErrorCategory,
  resolveNearestIC,
  resolveLocalNearestIC,
  type IcResult,
} from './icResolver';
import {
  computeIcResolveDeferredBackoffMs,
  computeIcResolveBackoffMs,
  canRetryIcResolve,
  IC_RESOLVE_RETRY_LIMIT,
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
      reason: 'offline' | 'temporary' | 'superseded';
      error?: string;
    };

export type ExpresswayIcResolutionRequest = {
  eventId: string;
  geo?: Geo;
  source: ExpresswayIcResolutionSource;
  /** Legacy callers may send this flag; only an explicit manual retry resets the budget. */
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
export const IC_GEO_FUTURE_WINDOW_MS = 30 * 1000;
export const IC_GEO_UNKNOWN_ACCURACY_WINDOW_MS = 15 * 1000;
export const IC_GEO_MAX_ACCURACY_M = 100;
export const IC_GEO_SUPPLEMENT_LIMIT = 3;
const IC_GEO_MIN_SEPARATION_M = 200;
const IC_GEO_MAX_EVENT_DISTANCE_M = 2000;
type IcRoutePoint = Pick<RoutePoint, 'ts' | 'lat' | 'lng' | 'accuracy' | 'source'>;
type IcResolutionRouteFix = Geo & { ts: string };

function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine;
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : 'IC解決に失敗しました';
}

function supersededOutcome(source: ExpresswayIcResolutionSource): ExpresswayIcResolutionOutcome {
  return {
    status: 'deferred', source, reason: 'superseded',
    error: 'IC取得中に対象の記録が変更されました。最新の記録から再取得してください',
  };
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

/** The stored end timestamp is the driver's confirmation, while geo belongs to detection. */
export function getIcResolutionReferenceTs(event: Pick<BaseEvent, 'type' | 'ts' | 'extras'>): string {
  const reason = event.extras?.autoDecision;
  if (event.type !== 'expressway_end' || !reason || typeof reason !== 'object') return event.ts;
  const decision = reason as Record<string, unknown>;
  if (decision.source !== 'native-auto' || decision.action !== 'end-prompt') return event.ts;
  const detectionMs = typeof decision.evaluatedAt === 'string' ? Date.parse(decision.evaluatedAt) : NaN;
  const eventMs = Date.parse(event.ts);
  return Number.isFinite(detectionMs) && Number.isFinite(eventMs) && detectionMs <= eventMs
    ? new Date(detectionMs).toISOString()
    : event.ts;
}

function distanceMeters(a: Geo, b: Geo): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

function rankedRoutePoints(
  points: readonly IcRoutePoint[],
  eventTs: string,
  eventType?: ExpresswayEventType,
) {
  const eventMs = Date.parse(eventTs);
  const candidates: {
    geo: Geo;
    pointMs: number;
    deltaMs: number;
    directionRank: number;
    accuracyRank: number;
  }[] = [];
  if (!Number.isFinite(eventMs)) return candidates;
  for (const point of points) {
    // Event route points only duplicate the original geo and are not an
    // independent GPS observation (their timestamp may be confirmation time).
    if (point.source === 'event') continue;
    const pointMs = Date.parse(point.ts);
    const geo: Geo = {
      lat: point.lat,
      lng: point.lng,
      ...(point.accuracy != null ? { accuracy: point.accuracy } : {}),
    };
    if (!Number.isFinite(pointMs) || !isUsableIcResolutionGeo(geo)) continue;
    const deltaMs = Math.abs(pointMs - eventMs);
    if (pointMs < eventMs - IC_GEO_FALLBACK_WINDOW_MS || pointMs > eventMs + IC_GEO_FUTURE_WINDOW_MS) continue;
    if (point.accuracy == null && deltaMs > IC_GEO_UNKNOWN_ACCURACY_WINDOW_MS) continue;
    const directionRank = eventType === 'expressway_start'
      ? (pointMs >= eventMs ? 0 : 1)
      : eventType === 'expressway_end'
        ? (pointMs <= eventMs ? 0 : 1)
        : 0;
    const accuracyRank = point.accuracy ?? Number.POSITIVE_INFINITY;
    candidates.push({ geo, pointMs, deltaMs, directionRank, accuracyRank });
  }
  return candidates.sort((a, b) => a.deltaMs - b.deltaMs
    || a.directionRank - b.directionRank
    || a.accuracyRank - b.accuracyRank
    || a.pointMs - b.pointMs
    || a.geo.lat - b.geo.lat
    || a.geo.lng - b.geo.lng);
}

export function selectIcResolutionRoutePoint(
  points: readonly IcRoutePoint[],
  eventTs: string,
  eventType?: ExpresswayEventType,
): Geo | undefined {
  return rankedRoutePoints(points, eventTs, eventType)[0]?.geo;
}

/** Select a small, distinct set of real fixes; never expand the geographic search without a bound. */
export function selectIcResolutionSupplementalPoints(
  points: readonly IcRoutePoint[],
  eventTs: string,
  eventType: ExpresswayEventType,
  primaryGeo: Geo,
): IcResolutionRouteFix[] {
  if (!isUsableIcResolutionGeo(primaryGeo)) return [];
  let candidates = rankedRoutePoints(points, eventTs, eventType).filter(point => {
    const distance = distanceMeters(primaryGeo, point.geo);
    return point.geo.accuracy != null
      && distance >= IC_GEO_MIN_SEPARATION_M
      && distance <= IC_GEO_MAX_EVENT_DISTANCE_M;
  });
  const selected: typeof candidates = [];
  while (candidates.length && selected.length < IC_GEO_SUPPLEMENT_LIMIT) {
    // Start nearest in time, then cover the remaining time span. The spatial
    // separation filter also prevents dense/duplicate fixes wasting requests.
    if (selected.length) {
      const timeSeparation = (point: typeof candidates[number]) =>
        Math.min(...selected.map(other => Math.abs(point.pointMs - other.pointMs)));
      candidates.sort((a, b) => timeSeparation(b) - timeSeparation(a) || a.deltaMs - b.deltaMs);
    }
    const next = candidates[0];
    selected.push(next);
    candidates = candidates.filter(point => distanceMeters(next.geo, point.geo) >= IC_GEO_MIN_SEPARATION_M);
  }
  return selected.map(point => ({ ...point.geo, ts: new Date(point.pointMs).toISOString() }));
}

async function loadRoutePoints(tripId: string, referenceTs: string): Promise<RoutePoint[]> {
  const eventMs = Date.parse(referenceTs);
  if (!Number.isFinite(eventMs)) return [];
  return db.routePoints
    .where('[tripId+ts]')
    .between(
      [tripId, new Date(eventMs - IC_GEO_FALLBACK_WINDOW_MS).toISOString()],
      [tripId, new Date(eventMs + IC_GEO_FUTURE_WINDOW_MS).toISOString()],
      true,
      true,
    )
    .toArray();
}

async function loadEventGeo(eventId: string) {
  const event = await db.events.get(eventId);
  if (!event) throw new Error('イベントが見つかりません');
  if (!isExpresswayEventType(event.type)) {
    throw new Error('高速道路イベントではありません');
  }
  const expectedVersion = captureIcResolutionEventVersion(event);
  const referenceTs = getIcResolutionReferenceTs(event);
  const context = { expectedVersion, referenceTs, tripId: event.tripId, eventType: event.type, extras: event.extras };
  // Reload the authoritative fix with the version guard. A queued request can
  // still carry the old geo after a driver corrects the event's location.
  if (isUsableIcResolutionGeo(event.geo)) {
    return { ...context, geo: event.geo, geoSource: 'event' as const, geoOffsetSeconds: 0 };
  }
  const points = await loadRoutePoints(event.tripId, referenceTs);
  const nearest = rankedRoutePoints(points, referenceTs, event.type)[0];
  return {
    ...context,
    geo: nearest?.geo,
    geoSource: 'route' as const,
    geoOffsetSeconds: nearest ? (nearest.pointMs - Date.parse(referenceTs)) / 1000 : 0,
    points,
  };
}

function normalizedIcName(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/g, '').replace(/インターチェンジ/g, 'ic');
}

class IcCatalogCandidateOverflowError extends Error {
  constructor() {
    super('保存軌跡付近のIC候補が上限を超えたため自動選択できません');
    this.name = 'IcCatalogCandidateOverflowError';
  }
}

async function resolveAtNearbyPoints(
  context: Awaited<ReturnType<typeof loadEventGeo>>,
  geo: Geo,
  resolveIc: typeof resolveNearestIC,
  mergeLocalCandidates = false,
): Promise<{
  result: IcResult;
  geoSource: 'event' | 'route';
  geoOffsetSeconds: number;
} | null> {
  const primaryResult = await resolveIc(geo.lat, geo.lng, undefined, { eventType: context.eventType });
  if (primaryResult) {
    return { result: primaryResult, geoSource: context.geoSource, geoOffsetSeconds: context.geoOffsetSeconds };
  }
  const points = 'points' in context && context.points
    ? context.points
    : await loadRoutePoints(context.tripId, context.referenceTs);
  const supplementalGeos = selectIcResolutionSupplementalPoints(
    points, context.referenceTs, context.eventType, geo,
  );
  const names = new Set<string>();
  const localNames = new Map<string, string>();
  let localDistanceUpperBound = 0;
  let best: { result: IcResult; geoSource: 'route'; geoOffsetSeconds: number } | null = null;
  for (const supplementalGeo of supplementalGeos) {
    // A thrown request must propagate, even after an earlier candidate: unseen
    // responses could disagree, and transport failure is not a map-data miss.
    const candidate = await resolveIc(supplementalGeo.lat, supplementalGeo.lng, undefined, { eventType: context.eventType });
    if (!candidate) continue;
    if (!mergeLocalCandidates) names.add(normalizedIcName(candidate.icName));
    // The API returns distance, not IC coordinates. Triangle inequality gives
    // a conservative 2 km upper bound from the original event/fallback fix.
    // A local result may contain multiple ICs; every one is within the catalog
    // radius, but distanceM describes only the representative. Bound the whole
    // set by that radius instead of silently selecting its nearest member.
    const candidateNames = candidate.candidates?.length
      ? candidate.candidates : [candidate.icName.replace(/[（(]推定(?:候補)?[）)]$/u, '')];
    const upperBound = distanceMeters(geo, supplementalGeo) + (
      mergeLocalCandidates && candidateNames.length > 1 ? IC_CATALOG_MAX_DISTANCE_M : candidate.distanceM
    );
    if (upperBound > IC_GEO_MAX_EVENT_DISTANCE_M) continue;
    if (mergeLocalCandidates) {
      localDistanceUpperBound = Math.max(localDistanceUpperBound, upperBound);
      for (const name of candidateNames) localNames.set(normalizedIcName(name), name);
    }
    if (!best || candidate.distanceM < best.result.distanceM) {
      best = {
        result: candidate,
        geoSource: 'route',
        geoOffsetSeconds: (Date.parse(supplementalGeo.ts) - Date.parse(context.referenceTs)) / 1000,
      };
    }
  }
  if (mergeLocalCandidates && best) {
    // Overflow is ambiguous evidence, not a catalog miss. Returning null would
    // enter the fallback (which also reads this catalog) and could save only one
    // route fix's subset. Stop this attempt without discarding alternatives.
    if (localNames.size > IC_CATALOG_MAX_CANDIDATES) throw new IcCatalogCandidateOverflowError();
    return { ...best, result: {
      ...best.result,
      confidence: 'estimated',
      candidates: [...localNames.values()],
      distanceM: Math.ceil(localDistanceUpperBound),
      note: `保存軌跡の補足点から得た近傍候補。距離は元イベント位置から候補全体までの保守的な上限。${best.result.note ?? '利用した入口・出口・進行方向は未確認。'}`,
    } };
  }
  if (names.size > 1) throw new Error('付近の軌跡でIC候補が一致しないため自動確定できません');
  return best;
}

async function performResolution(
  request: ExpresswayIcResolutionRequest,
  resolveIc: typeof resolveNearestIC,
  resolveOfflineIc?: typeof resolveLocalNearestIC,
): Promise<ExpresswayIcResolutionOutcome> {
  const eventId = request.eventId.trim();
  if (!eventId) throw new Error('eventId is required');
  const context = await loadEventGeo(eventId);
  const { geo, expectedVersion } = context;
  const guard = { expectedVersion };
  if (expectedVersion.resolvedManually) {
    return { status: 'deferred', source: request.source, reason: 'superseded',
      error: '手動修正済みのIC名は保持されます。変更する場合はIC名を編集してください' };
  }
  if (request.source !== 'manual' && !canRetryIcResolve(context.extras, Date.now())) {
    return { status: 'deferred', source: request.source, reason: 'temporary',
      error: '保存済みの再試行待ち時間と上限を維持しています' };
  }
  const offlineOutcome = (): ExpresswayIcResolutionOutcome => ({
    status: 'deferred', source: request.source, reason: 'offline',
  });
  if (!isOnline() && !resolveOfflineIc) return offlineOutcome();

  const saveFailure = async (
    message: string, category: ReturnType<typeof getRetryableIcResolverErrorCategory>,
  ): Promise<ExpresswayIcResolutionOutcome> => {
    const retryCount = getNextIcResolveDeferredRetryCount(context.extras, request.source === 'manual');
    const exhausted = retryCount >= IC_RESOLVE_RETRY_LIMIT;
    const delayMs = category
      ? computeIcResolveDeferredBackoffMs(category, retryCount)
      : computeIcResolveBackoffMs(retryCount);
    const applied = await updateExpresswayResolved({
      eventId,
      status: category && !exhausted ? 'pending' : 'failed',
      retryCount,
      nextRetryAt: exhausted ? null : new Date(Date.now() + delayMs).toISOString(),
      errorMessage: message,
      guard,
    });
    if (!applied) return supersededOutcome(request.source);
    if (category && !exhausted) {
      return { status: 'deferred', source: request.source, reason: 'temporary', error: message };
    }
    return { status: 'failed', source: request.source, error: message };
  };
  if (!geo) {
    if (!isOnline()) return offlineOutcome();
    return saveFailure('イベント付近の有効な位置情報が見つかりません', null);
  }

  try {
    // Complete the bounded saved-route catalog search before any request.
    // Otherwise a primary catalog miss followed by an upstream timeout would
    // prevent a usable nearby saved fix from ever being checked locally.
    const localResolved = resolveOfflineIc
      ? await resolveAtNearbyPoints(context, geo,
          async (lat, lon, _radius, lookupContext) => resolveOfflineIc(lat, lon, lookupContext), true)
      : null;
    const resolved = localResolved ?? (isOnline()
      ? await resolveAtNearbyPoints(context, geo, resolveIc)
      : null);
    if (!resolved) {
      if (!isOnline()) return offlineOutcome();
      throw new Error('近傍ICを取得できませんでした');
    }
    const { result } = resolved;
    const applied = await updateExpresswayResolved({
      eventId,
      status: 'resolved',
      icName: result.icName,
      icDistanceM: result.distanceM,
      resolutionSource: resolved.geoSource,
      resolutionOffsetSeconds: resolved.geoOffsetSeconds,
      ...(result.confidence === 'estimated' ? { estimate: {
        candidates: result.candidates ?? [result.icName],
        source: result.estimateSource ?? 'overpass_nearby',
        ...(result.sourceDatasetDate ? { sourceDatasetDate: result.sourceDatasetDate } : {}),
        sourceUrls: result.sourceUrls ?? [],
        note: result.note ?? '近接する地図上の候補。利用した入口・出口・進行方向は未確認。',
        estimatedAt: new Date(Date.now()).toISOString(),
      } } : {}),
      guard,
    });
    if (!applied) return supersededOutcome(request.source);
    return { status: 'resolved', source: request.source, result };
  } catch (error) {
    // Offline catalog misses/failures are not network attempts. Preserve the
    // persisted retry budget and last error until online recovery is possible.
    if (!isOnline()) return offlineOutcome();
    return saveFailure(errorMessage(error), getRetryableIcResolverErrorCategory(error));
  }
}

/** Keep the production database/write guards when substituting the network adapter. */
export function createExpresswayIcResolutionRunner(
  resolveIc = resolveNearestIC,
  resolveOfflineIc = resolveIc === resolveNearestIC ? resolveLocalNearestIC : undefined,
) {
  const inFlightByEventId = new Map<string, Promise<ExpresswayIcResolutionOutcome>>();
  return (request: ExpresswayIcResolutionRequest): Promise<ExpresswayIcResolutionOutcome> => {
    const eventId = request.eventId.trim();
    const current = inFlightByEventId.get(eventId);
    if (current) return current;
    const next = performResolution({ ...request, eventId }, resolveIc, resolveOfflineIc);
    inFlightByEventId.set(eventId, next);
    const clear = () => {
      if (inFlightByEventId.get(eventId) === next) inFlightByEventId.delete(eventId);
    };
    void next.then(clear, clear);
    return next;
  };
}

export const resolveExpresswayIcResolution = createExpresswayIcResolutionRunner();

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

export function createExpresswayIcRetryBatchRunner(
  resolve = resolveExpresswayIcResolution,
  allowOfflineCatalog = resolve === resolveExpresswayIcResolution,
) {
  let retryBatchInFlight: Promise<boolean> | null = null;
  return async (limit = 8, _legacyOptions?: { ignorePendingBackoff?: boolean }): Promise<boolean> => {
    const boundedLimit = Number.isFinite(limit) ? Math.min(20, Math.max(1, Math.round(limit))) : 8;
    // All triggers share the same bounded pass. A TOKEN_REFRESHED event raised
    // by this worker cannot enqueue another pass or erase persisted backoff.
    if (retryBatchInFlight) return retryBatchInFlight;
    if (!isOnline() && !allowOfflineCatalog) return false;
    retryBatchInFlight = (async () => {
      let updatedAny = false;
      const pending = (await getPendingExpresswayEvents()).slice(0, boundedLimit);
      let nextIndex = 0;
      const worker = async () => {
        while (nextIndex < pending.length && (isOnline() || allowOfflineCatalog)) {
          const event = pending[nextIndex++];
          try {
            const outcome = await resolve({ eventId: event.id, source: 'retry' });
            if (outcome.status !== 'deferred') updatedAny = true;
          } catch {
            // A record may be deleted or converted after the batch was read.
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, pending.length) }, worker));
      return updatedAny;
    })();
    try {
      return await retryBatchInFlight;
    } finally {
      retryBatchInFlight = null;
    }
  };
}

export const retryPendingExpresswayIcResolutions = createExpresswayIcRetryBatchRunner();

/**
 * Explicit recovery hook for online, sign-in, token refresh, or device
 * re-approval transitions. Persisted backoff and finite attempt budgets apply
 * to every automatic trigger, including app restart.
 */
export function retryPendingExpresswayIcResolutionsAfterRecovery(limit = 12) {
  return retryPendingExpresswayIcResolutions(limit);
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
