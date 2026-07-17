import { db } from '../db/db';
import {
  getPendingExpresswayEvents,
  markExpresswayResolveFailure,
  updateExpresswayResolved,
} from '../db/repositories';
import type { Geo } from '../domain/types';
import {
  isRetryableIcResolverError,
  resolveNearestIC,
  type IcResult,
} from './icResolver';

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
};

type EnqueueRequest = Omit<ExpresswayIcResolutionRequest, 'source'> & {
  source?: 'immediate' | 'notification-end';
};

const EXPRESSWAY_EVENT_TYPES = new Set(['expressway', 'expressway_start', 'expressway_end']);
const TEMPORARY_RETRY_DELAY_MS = 2 * 60 * 1000;
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

async function loadEventGeo(eventId: string, suppliedGeo?: Geo) {
  const event = await db.events.get(eventId);
  if (!event) throw new Error('イベントが見つかりません');
  if (!EXPRESSWAY_EVENT_TYPES.has(event.type)) {
    throw new Error('高速道路イベントではありません');
  }
  return suppliedGeo ?? event.geo;
}

async function performResolution(
  request: ExpresswayIcResolutionRequest,
): Promise<ExpresswayIcResolutionOutcome> {
  const eventId = request.eventId.trim();
  if (!eventId) throw new Error('eventId is required');
  const geo = await loadEventGeo(eventId, request.geo);

  if (!isOnline()) {
    await updateExpresswayResolved({ eventId, status: 'pending' });
    return { status: 'deferred', source: request.source, reason: 'offline' };
  }

  if (request.source === 'manual') {
    await updateExpresswayResolved({ eventId, status: 'pending' });
  }

  if (!geo) {
    const message = '位置情報が未保存のためIC解決不可';
    await markExpresswayResolveFailure({ eventId, errorMessage: message, nextRetryAt: null });
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
    });
    return { status: 'resolved', source: request.source, result };
  } catch (error) {
    const message = errorMessage(error);
    if (isRetryableIcResolverError(error)) {
      await updateExpresswayResolved({
        eventId,
        status: 'pending',
        nextRetryAt: new Date(Date.now() + TEMPORARY_RETRY_DELAY_MS).toISOString(),
        errorMessage: message,
      });
      return {
        status: 'deferred',
        source: request.source,
        reason: 'temporary',
        error: message,
      };
    }
    await markExpresswayResolveFailure({ eventId, errorMessage: message });
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
