import {
  STALE_NATIVE_EXPRESSWAY_DETECTION_ERROR,
  advanceNativeExpresswayGeneration,
  clearPendingExpresswayEndPrompt,
  clearPendingExpresswayEndPromptIfMatches,
  clearPendingExpresswayKeepDecision,
  endExpressway,
  getActiveTripId,
  getAutoExpresswayConfig,
  getEventsByTripId,
  getNativeExpresswayGeneration,
  setPendingExpresswayEndDecision,
  setPendingExpresswayEndPrompt,
  startExpressway,
  type AutoExpresswayConfig,
  type AutoExpresswayDecisionReason,
} from '../db/repositories';
import type { AppEvent, Geo } from '../domain/types';
import {
  EXPRESSWAY_TOGGLE_DEFINITION,
  PERSISTED_BASIC_TOGGLE_DEFINITIONS,
  findOpenToggleStart,
  type TogglePairDefinition,
} from '../domain/togglePairing';
import { enqueueExpresswayIcResolution } from './expresswayIcResolution';
import {
  acknowledgeNativeResidentExpresswayEvents,
  peekNativeResidentExpresswayEvents,
  type NativeResidentExpresswayEvent,
} from './nativeResidentLocation';

const MAX_NATIVE_EVENT_BATCH = 100;
const MAX_NATIVE_EVENT_ID_LENGTH = 160;

const [REST_TOGGLE_DEFINITION, , , , FERRY_TOGGLE_DEFINITION] =
  PERSISTED_BASIC_TOGGLE_DEFINITIONS;

type NativeExpresswayEventHandoffDependencies = {
  peek(limit: number): Promise<{ events: NativeResidentExpresswayEvent[]; remaining: number }>;
  acknowledge(ids: string[]): Promise<{ remaining: number }>;
  getActiveTripId(): Promise<string | null>;
  getEventsByTripId(tripId: string): Promise<AppEvent[]>;
  getAutoExpresswayConfig(): Promise<AutoExpresswayConfig>;
  getGeneration(tripId: string): Promise<number>;
  advanceGeneration(tripId: string, generation: number): Promise<number>;
  startExpressway: typeof startExpressway;
  endExpressway: typeof endExpressway;
  setPendingPrompt: typeof setPendingExpresswayEndPrompt;
  clearPendingPrompt: typeof clearPendingExpresswayEndPrompt;
  clearPendingPromptIfMatches: typeof clearPendingExpresswayEndPromptIfMatches;
  clearPendingKeepDecision: typeof clearPendingExpresswayKeepDecision;
  setPendingDecision: typeof setPendingExpresswayEndDecision;
  enqueueIcResolution: typeof enqueueExpresswayIcResolution;
};

const DEFAULT_DEPENDENCIES: NativeExpresswayEventHandoffDependencies = {
  peek: peekNativeResidentExpresswayEvents,
  acknowledge: acknowledgeNativeResidentExpresswayEvents,
  getActiveTripId,
  getEventsByTripId,
  getAutoExpresswayConfig,
  getGeneration: getNativeExpresswayGeneration,
  advanceGeneration: advanceNativeExpresswayGeneration,
  startExpressway,
  endExpressway,
  setPendingPrompt: setPendingExpresswayEndPrompt,
  clearPendingPrompt: clearPendingExpresswayEndPrompt,
  clearPendingPromptIfMatches: clearPendingExpresswayEndPromptIfMatches,
  clearPendingKeepDecision: clearPendingExpresswayKeepDecision,
  setPendingDecision: setPendingExpresswayEndDecision,
  enqueueIcResolution: enqueueExpresswayIcResolution,
};

export type NativeExpresswayEventDrainResult = {
  observed: number;
  materialized: number;
  terminal: number;
  deferred: number;
  acknowledged: number;
  remaining: number;
};

export const NATIVE_EXPRESSWAY_TRIP_END_HANDOFF_ERROR =
  '高速道路の自動判定を保存できませんでした。通信状態を確認して、もう一度運行終了を押してください。';

type NormalizedNativeExpresswayEvent = Omit<NativeResidentExpresswayEvent, 'reason'> & {
  reason: Record<string, unknown>;
};

function normalizedId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result && result.length <= MAX_NATIVE_EVENT_ID_LENGTH ? result : null;
}

function normalizedIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const atMs = Date.parse(value);
  return Number.isFinite(atMs) ? new Date(atMs).toISOString() : null;
}

function normalizedGeo(value: unknown): Geo | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const lat = Number(row.lat);
  const lng = Number(row.lon);
  const accuracy = Number(row.accuracy);
  if (
    !Number.isFinite(lat)
    || lat < -90
    || lat > 90
    || !Number.isFinite(lng)
    || lng < -180
    || lng > 180
  ) {
    return null;
  }
  return {
    lat,
    lng,
    ...(Number.isFinite(accuracy) && accuracy >= 0 ? { accuracy } : {}),
  };
}

export function normalizeNativeResidentExpresswayEvent(
  value: unknown,
): NormalizedNativeExpresswayEvent | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const id = normalizedId(row.id);
  const tripId = normalizedId(row.tripId);
  const kind = row.kind === 'start'
    || row.kind === 'end_prompt'
    || row.kind === 'decision_end'
    || row.kind === 'decision_keep'
    ? row.kind
    : null;
  const detectedAt = normalizedIso(row.detectedAt);
  const decidedAt = row.decidedAt == null ? undefined : normalizedIso(row.decidedAt);
  const geo = normalizedGeo(row.geo);
  const speedKmh = Number(row.speedKmh);
  const generation = Number(row.generation);
  if (
    !id
    || !tripId
    || !kind
    || !detectedAt
    || !geo
    || !Number.isFinite(speedKmh)
    || !Number.isSafeInteger(generation)
    || generation < 1
    || ((kind === 'decision_end' || kind === 'decision_keep') && !decidedAt)
  ) {
    return null;
  }
  const reason = row.reason && typeof row.reason === 'object'
    ? { ...(row.reason as Record<string, unknown>) }
    : {};
  const promptId = normalizedId(row.promptId);
  const monotonicSessionId = normalizedId(row.monotonicSessionId);
  const elapsedRealtimeMs = Number(row.elapsedRealtimeMs);
  return {
    id,
    tripId,
    kind,
    generation,
    detectedAt,
    ...(decidedAt ? { decidedAt } : {}),
    ...(promptId ? { promptId } : {}),
    geo: {
      lat: geo.lat,
      lon: geo.lng,
      ...(geo.accuracy != null ? { accuracy: geo.accuracy } : {}),
    },
    speedKmh: Math.max(0, Math.min(220, speedKmh)),
    ...(monotonicSessionId ? { monotonicSessionId } : {}),
    ...(Number.isFinite(elapsedRealtimeMs) && elapsedRealtimeMs >= 0
      ? { elapsedRealtimeMs }
      : {}),
    reason,
  };
}

function hasOpen(events: readonly AppEvent[], definition: TogglePairDefinition) {
  return findOpenToggleStart(events, definition) !== null;
}

function expresswayEventWatermark(events: readonly AppEvent[]) {
  let latestNativeGeneration: number | null = null;
  let latestUnversionedAtMs: number | null = null;
  for (const event of events) {
    if (
      event.type !== 'expressway'
      && event.type !== 'expressway_start'
      && event.type !== 'expressway_end'
    ) {
      continue;
    }
    const autoDecision = event.extras?.autoDecision;
    const generation = autoDecision && typeof autoDecision === 'object'
      ? Number((autoDecision as Record<string, unknown>).nativeGeneration)
      : Number.NaN;
    if (Number.isSafeInteger(generation) && generation >= 1) {
      if (latestNativeGeneration == null || generation > latestNativeGeneration) {
        latestNativeGeneration = generation;
      }
      continue;
    }
    const atMs = Date.parse(event.ts);
    if (Number.isFinite(atMs) && (latestUnversionedAtMs == null || atMs > latestUnversionedAtMs)) {
      latestUnversionedAtMs = atMs;
    }
  }
  return { latestNativeGeneration, latestUnversionedAtMs };
}

function eventNativeDetectionId(event: AppEvent): string | null {
  const autoDecision = event.extras?.autoDecision;
  if (!autoDecision || typeof autoDecision !== 'object') return null;
  return normalizedId((autoDecision as Record<string, unknown>).nativeDetectionId);
}

function autoDecisionReason(
  event: NormalizedNativeExpresswayEvent,
  config: AutoExpresswayConfig,
): AutoExpresswayDecisionReason {
  const raw = event.reason;
  const rawConfig = raw.config && typeof raw.config === 'object'
    ? raw.config as Record<string, unknown>
    : {};
  const finiteOr = (value: unknown, fallback: number) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  };
  const nativeDetectionId = normalizedId(raw.nativeDetectionId) ?? event.id;
  const nearestIcName = typeof raw.nearestIcName === 'string' && raw.nearestIcName.trim()
    ? raw.nearestIcName.trim()
    : undefined;
  const nearestIcDistanceM = Number(raw.nearestIcDistanceM);
  const accelerationMs2 = Number(raw.accelerationMs2);
  const accuracyM = Number(raw.accuracyM);
  const confirm = raw.confirm && typeof raw.confirm === 'object'
    ? raw.confirm as Record<string, unknown>
    : null;
  const confirmValues = confirm
    ? {
        hits: Number(confirm.hits),
        elapsedMs: Number(confirm.elapsedMs),
        minHits: Number(confirm.minHits),
        minHoldMs: Number(confirm.minHoldMs),
      }
    : null;
  const validConfirm = confirmValues
    && Object.values(confirmValues).every(Number.isFinite)
    ? confirmValues
    : null;
  return {
    source: 'native-auto',
    nativeDetectionId,
    nativeGeneration: event.generation,
    ...(event.monotonicSessionId ? { monotonicSessionId: event.monotonicSessionId } : {}),
    ...(event.elapsedRealtimeMs != null ? { elapsedRealtimeMs: event.elapsedRealtimeMs } : {}),
    action: event.kind === 'start' ? 'start' : 'end-prompt',
    evaluatedAt: event.detectedAt,
    speedKmh: event.speedKmh,
    ...(Number.isFinite(accelerationMs2) ? { accelerationMs2 } : {}),
    ...(Number.isFinite(accuracyM) ? { accuracyM } : {}),
    signalResolved: raw.signalResolved === true,
    onExpresswayRoad: raw.onExpresswayRoad === true,
    nearIc: raw.nearIc === true,
    nearEtcGate: raw.nearEtcGate === true,
    ...(nearestIcName ? { nearestIcName } : {}),
    ...(Number.isFinite(nearestIcDistanceM) ? { nearestIcDistanceM } : {}),
    config: {
      startSpeedKmh: finiteOr(rawConfig.startSpeedKmh, config.speedKmh),
      startDurationSec: finiteOr(rawConfig.startDurationSec, config.durationSec),
      endSpeedKmh: finiteOr(rawConfig.endSpeedKmh, config.endSpeedKmh),
      endDurationSec: finiteOr(rawConfig.endDurationSec, config.endDurationSec),
    },
    ...(validConfirm ? { confirm: validConfirm } : {}),
  };
}

type MaterializationOutcome = 'materialized' | 'terminal' | 'deferred';

async function materializeEvent(
  event: NormalizedNativeExpresswayEvent,
  dependencies: NativeExpresswayEventHandoffDependencies,
): Promise<MaterializationOutcome> {
  const storedGeneration = await dependencies.getGeneration(event.tripId);
  if (event.generation <= storedGeneration) return 'terminal';

  const activeTripId = await dependencies.getActiveTripId();
  if (activeTripId !== event.tripId) return 'terminal';
  const events = await dependencies.getEventsByTripId(event.tripId);
  if (
    !events.some(candidate => candidate.type === 'trip_start')
    || events.some(candidate => candidate.type === 'trip_end')
  ) {
    return 'terminal';
  }
  if (hasOpen(events, REST_TOGGLE_DEFINITION) || hasOpen(events, FERRY_TOGGLE_DEFINITION)) {
    return 'deferred';
  }

  const config = await dependencies.getAutoExpresswayConfig();
  const reason = autoDecisionReason(event, config);
  const geo: Geo = {
    lat: event.geo.lat,
    lng: event.geo.lon,
    ...(event.geo.accuracy != null ? { accuracy: event.geo.accuracy } : {}),
  };
  const openExpressway = hasOpen(events, EXPRESSWAY_TOGGLE_DEFINITION);
  const watermark = expresswayEventWatermark(events);
  const detectedAtMs = Date.parse(event.detectedAt);
  const staleAtEventWatermark = (
    watermark.latestNativeGeneration != null
    && event.generation <= watermark.latestNativeGeneration
  ) || (
    watermark.latestUnversionedAtMs != null
    && detectedAtMs <= watermark.latestUnversionedAtMs
  );

  if (event.kind === 'start') {
    if (openExpressway || staleAtEventWatermark) return 'terminal';
    try {
      const result = await dependencies.startExpressway({
        tripId: event.tripId,
        occurredAt: event.detectedAt,
        geo,
        autoDecision: reason,
      });
      dependencies.enqueueIcResolution({ eventId: result.eventId, geo });
      return result.created ? 'materialized' : 'terminal';
    } catch (error) {
      if (error instanceof Error && error.message === STALE_NATIVE_EXPRESSWAY_DETECTION_ERROR) {
        return 'terminal';
      }
      throw error;
    }
  }

  if (event.kind === 'end_prompt') {
    if (!openExpressway || staleAtEventWatermark) return 'terminal';
    // A new Java prompt proves that its earlier keep suppression recovered.
    // Remove only an old keep marker; never consume an end action here.
    await dependencies.clearPendingKeepDecision(event.tripId);
    await dependencies.setPendingPrompt({
      tripId: event.tripId,
      promptId: event.promptId ?? event.id,
      speedKmh: event.speedKmh,
      detectedAt: event.detectedAt,
      geo,
      reason,
    });
    return 'materialized';
  }

  if (event.kind === 'decision_keep') {
    if (!openExpressway || staleAtEventWatermark) {
      await dependencies.clearPendingPromptIfMatches({
        tripId: event.tripId,
        promptId: event.promptId,
      });
      return 'terminal';
    }
    await dependencies.setPendingDecision({
      tripId: event.tripId,
      nativeDetectionId: reason.nativeDetectionId,
      promptId: event.promptId,
      action: 'keep',
      decidedAt: event.decidedAt ?? event.detectedAt,
      speedKmh: event.speedKmh,
      geo,
    });
    await dependencies.clearPendingPromptIfMatches({
      tripId: event.tripId,
      promptId: event.promptId,
    });
    return 'materialized';
  }

  const sameEnd = events.find(candidate => (
    candidate.type === 'expressway_end'
    && eventNativeDetectionId(candidate) === reason.nativeDetectionId
  ));
  if (staleAtEventWatermark || (!openExpressway && !sameEnd)) {
    await dependencies.clearPendingPromptIfMatches({
      tripId: event.tripId,
      promptId: event.promptId,
    });
    return 'terminal';
  }
  try {
    const result = await dependencies.endExpressway({
      tripId: event.tripId,
      occurredAt: event.decidedAt ?? event.detectedAt,
      geo,
      autoDecision: reason,
      source: 'automatic_detection',
      automaticConfirmation: 'confirmed',
    });
    await dependencies.clearPendingPromptIfMatches({
      tripId: event.tripId,
      promptId: event.promptId,
    });
    dependencies.enqueueIcResolution({ eventId: result.eventId, geo, source: 'notification-end' });
    return result.created ? 'materialized' : 'terminal';
  } catch (error) {
    if (error instanceof Error && error.message === STALE_NATIVE_EXPRESSWAY_DETECTION_ERROR) {
      await dependencies.clearPendingPromptIfMatches({
        tripId: event.tripId,
        promptId: event.promptId,
      });
      return 'terminal';
    }
    throw error;
  }
}

/**
 * Replays Java-owned expressway transitions in FIFO order. Every transition is
 * durably materialized (or classified terminal) and generation-watermarked
 * before it is acknowledged, making WebView/process death safe.
 */
export async function drainNativeResidentExpresswayEventQueue(
  options: {
    enabled: boolean;
    limit?: number;
    dependencies?: Partial<NativeExpresswayEventHandoffDependencies>;
  },
): Promise<NativeExpresswayEventDrainResult> {
  const empty: NativeExpresswayEventDrainResult = {
    observed: 0,
    materialized: 0,
    terminal: 0,
    deferred: 0,
    acknowledged: 0,
    remaining: 0,
  };
  if (!options.enabled) return empty;
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? MAX_NATIVE_EVENT_BATCH), MAX_NATIVE_EVENT_BATCH));
  const batch = await dependencies.peek(limit);
  const result = { ...empty, observed: batch.events.length, remaining: batch.remaining };
  for (const rawEvent of batch.events) {
    const event = normalizeNativeResidentExpresswayEvent(rawEvent);
    if (!event) {
      const invalidId = normalizedId((rawEvent as unknown as Record<string, unknown>)?.id);
      if (!invalidId) throw new Error('native expressway event is missing a valid id');
      const ack = await dependencies.acknowledge([invalidId]);
      result.terminal += 1;
      result.acknowledged += 1;
      result.remaining = ack.remaining;
      continue;
    }
    const outcome = await materializeEvent(event, dependencies);
    if (outcome === 'deferred') {
      result.deferred += 1;
      break;
    }
    await dependencies.advanceGeneration(event.tripId, event.generation);
    const ack = await dependencies.acknowledge([event.id]);
    result[outcome] += 1;
    result.acknowledged += 1;
    result.remaining = ack.remaining;
  }
  return result;
}

/**
 * Trip close is a destructive boundary for queued native transitions. Drain
 * every current FIFO batch immediately before `trip_end`; if the active trip
 * changed, storage failed, or a rest/ferry pause defers the head, fail closed
 * so the UI keeps the trip open and offers a safe retry.
 */
export async function prepareNativeExpresswayEventsForTripEnd(options: {
  enabled: boolean;
  tripId: string;
  dependencies?: Partial<NativeExpresswayEventHandoffDependencies>;
}): Promise<NativeExpresswayEventDrainResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  const empty: NativeExpresswayEventDrainResult = {
    observed: 0,
    materialized: 0,
    terminal: 0,
    deferred: 0,
    acknowledged: 0,
    remaining: 0,
  };
  if (!options.enabled) return empty;
  if (await dependencies.getActiveTripId() !== options.tripId) {
    throw new Error(NATIVE_EXPRESSWAY_TRIP_END_HANDOFF_ERROR);
  }

  const total = { ...empty };
  // A bounded loop avoids an infinite close operation if native production
  // unexpectedly outruns the drain. One batch already supports 100 events.
  for (let batchIndex = 0; batchIndex < 20; batchIndex += 1) {
    const result = await drainNativeResidentExpresswayEventQueue({
      enabled: true,
      limit: MAX_NATIVE_EVENT_BATCH,
      dependencies,
    });
    total.observed += result.observed;
    total.materialized += result.materialized;
    total.terminal += result.terminal;
    total.deferred += result.deferred;
    total.acknowledged += result.acknowledged;
    total.remaining = result.remaining;
    if (result.deferred > 0 || (result.remaining > 0 && result.acknowledged === 0)) {
      throw new Error(NATIVE_EXPRESSWAY_TRIP_END_HANDOFF_ERROR);
    }
    if (result.remaining <= 0) return total;
    if (await dependencies.getActiveTripId() !== options.tripId) {
      throw new Error(NATIVE_EXPRESSWAY_TRIP_END_HANDOFF_ERROR);
    }
  }
  throw new Error(NATIVE_EXPRESSWAY_TRIP_END_HANDOFF_ERROR);
}
