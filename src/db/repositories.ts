import { db } from './db';
import { requestRemoteSync } from '../app/remoteSyncSignal';
import type {
  AppEvent,
  TripStartEvent,
  TripEndEvent,
  RestStartEvent,
  RestEndEvent,
  Geo,
  EventType,
  RoutePoint,
} from '../domain/types';
import {
  AUTO_REST_REASON_BREAK_THRESHOLD,
  computeTotals,
  getOpenBreakToRestThresholdTs,
  isRestStartOdoCheckpoint,
  type BreakToRestTransition,
} from '../domain/metrics';
import {
  attachBreakToRestOdometer,
  canCloseDueBreakAfterConfirmation,
  createStoredBreakToRestConfirmation,
  findDueBreakToRestCandidate,
  normalizeOptionalRestStartOdometer,
  parseStoredBreakToRestConfirmation,
  serializeStoredBreakToRestConfirmation,
  type BreakToRestCandidate,
  type BreakToRestConfirmationStatus,
} from '../domain/breakToRestConfirmation';
import { parseJsonInput } from '../domain/jsonInput';
import {
  normalizeRoutePointAccuracy,
  normalizeRoutePointHeading,
  normalizeRoutePointSpeed,
} from '../domain/routePointTelemetry';
import {
  EXPRESSWAY_TOGGLE_DEFINITION,
  findAcceptedTogglePair,
  findOpenToggleSessionId,
  findOpenToggleStart,
  LEGACY_TOGGLE_SESSION_ID,
  PERSISTED_BASIC_TOGGLE_DEFINITIONS,
  resolveTogglePairing,
} from '../domain/togglePairing';
import { reverseGeocode } from '../services/geo';
import { resolveNearestIC } from '../services/icResolver';
import { notifyTrackLogEventsChanged } from '../services/localEventsChanged';
import {
  canApplyIcResolutionResult,
  canRetryIcResolve as canRetryIcResolveExtras,
  captureIcResolutionEventVersion,
  computeIcResolveBackoffMs,
  getIcResolveAlgorithmVersion as getIcResolveAlgorithmVersionFromExtras,
  getIcResolveRetryCount as getIcResolveRetryCountFromExtras,
  IC_RESOLVE_ALGORITHM_VERSION,
  IC_RESOLVE_RETRY_LIMIT,
  isStaleIcResolveAlgorithm as isStaleIcResolveAlgorithmExtras,
  type IcResolutionEventVersion,
} from '../services/expresswayIcRetryPolicy';

/*
 * Utilities
 */
function nowIso(): string {
  return new Date().toISOString();
}

function resolveOccurredAt(occurredAt?: string): string {
  if (occurredAt == null) return nowIso();
  const timestampMs = Date.parse(occurredAt);
  if (!Number.isFinite(timestampMs)) throw new Error('操作時刻が不正です');
  return new Date(timestampMs).toISOString();
}

export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as any).randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function setMeta(key: string, value: string | null) {
  if (value) {
    await db.meta.put({ key, value, updatedAt: nowIso() });
  } else {
    await db.meta.delete(key);
  }
}

async function getMeta(key: string): Promise<string | null> {
  const row = await db.meta.get(key);
  return row?.value ?? null;
}

function notifyRemoteMutation(reason: string) {
  requestRemoteSync(reason);
}

const META_ACTIVE_TRIP_ID = 'activeTripId';
const META_AUTO_EXPRESSWAY_CONFIG = 'autoExpresswayConfig';
const META_ROUTE_TRACKING_ENABLED = 'routeTrackingEnabled';
const META_ROUTE_TRACKING_MODE = 'routeTrackingMode';
const META_PENDING_EXPRESSWAY_END_PROMPT = 'pendingExpresswayEndPrompt';
const META_PENDING_EXPRESSWAY_END_DECISION = 'pendingExpresswayEndDecision';
const META_NATIVE_EXPRESSWAY_GENERATION_PREFIX = 'nativeExpresswayGeneration:';
const META_BREAK_TO_REST_CONFIRMATION_PREFIX = 'breakToRestConfirmation:';
const META_REMOTE_ROUTE_POINTS_UPLOADED_THROUGH = 'remoteRoutePointsUploadedThrough';
const EXPRESSWAY_EVENT_TYPES = ['expressway', 'expressway_start', 'expressway_end'] as const;
const REPORT_MIN_DURATION_MINUTES = 15;
const AUTO_REST_REASON_FERRY_BOARDING = 'ferry_boarding';

export type AutoExpresswayConfig = {
  speedKmh: number;
  durationSec: number;
  endSpeedKmh: number;
  endDurationSec: number;
};

export type PendingExpresswayEndPrompt = {
  tripId: string;
  promptId?: string;
  speedKmh: number;
  detectedAt: string;
  geo: Geo;
  reason?: AutoExpresswayDecisionReason;
};

export type PendingExpresswayEndDecision = {
  tripId: string;
  nativeDetectionId?: string;
  promptId?: string;
  action: 'end' | 'keep';
  decidedAt: string;
  speedKmh?: number;
  geo?: Geo;
};

export type BreakToRestConfirmationState = {
  tripId: string;
  breakStartId: string;
  breakStartTs: string;
  thresholdTs: string;
  status: BreakToRestConfirmationStatus;
};

export type BreakToRestPromptState = Omit<BreakToRestConfirmationState, 'status'> & {
  decision: Exclude<BreakToRestConfirmationStatus, 'declined'>;
};

function breakToRestConfirmationTripPrefix(tripId: string): string {
  return `${META_BREAK_TO_REST_CONFIRMATION_PREFIX}${encodeURIComponent(tripId)}:`;
}

function breakToRestConfirmationKey(tripId: string, breakStartId: string): string {
  return `${breakToRestConfirmationTripPrefix(tripId)}${encodeURIComponent(breakStartId)}`;
}

function publicBreakToRestConfirmationState(
  candidate: BreakToRestCandidate,
  status: BreakToRestConfirmationStatus,
): BreakToRestConfirmationState {
  return {
    tripId: candidate.tripId,
    breakStartId: candidate.breakStartId,
    breakStartTs: candidate.breakStartTs,
    thresholdTs: candidate.thresholdTs,
    status,
  };
}

async function clearBreakToRestConfirmationsForTripTx(tripId: string): Promise<void> {
  await db.meta.where('key').startsWith(breakToRestConfirmationTripPrefix(tripId)).delete();
}

async function assertDueBreakCanCloseTx(
  events: readonly AppEvent[],
  tripId: string,
  evaluatedAt: string,
): Promise<void> {
  const candidate = findDueBreakToRestCandidate(events, evaluatedAt);
  if (!candidate) return;
  const stored = parseStoredBreakToRestConfirmation(
    (await db.meta.get(breakToRestConfirmationKey(tripId, candidate.breakStartId)))?.value ?? null,
    candidate,
  );
  if (canCloseDueBreakAfterConfirmation(stored?.status ?? null)) return;
  if (stored?.status === 'approved') {
    throw new Error('休息開始ODOの入力を完了してください');
  }
  throw new Error('休息への変更確認で「はい」か「いいえ」を選択してください');
}

export type AutoExpresswayDecisionReason = {
  source: 'native-auto';
  nativeDetectionId?: string;
  nativeGeneration?: number;
  monotonicSessionId?: string;
  elapsedRealtimeMs?: number;
  action: 'start' | 'end-prompt';
  evaluatedAt: string;
  speedKmh: number;
  accelerationMs2?: number;
  accuracyM?: number;
  signalResolved: boolean;
  onExpresswayRoad: boolean;
  nearIc: boolean;
  nearEtcGate: boolean;
  nearestIcName?: string;
  nearestIcDistanceM?: number;
  config: {
    startSpeedKmh: number;
    startDurationSec: number;
    endSpeedKmh: number;
    endDurationSec: number;
  };
  confirm?: {
    hits: number;
    elapsedMs: number;
    minHits: number;
    minHoldMs: number;
  };
};

function normalizeNativeDetectionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 160 ? normalized : undefined;
}

function normalizeAutoExpresswayDecisionReason(raw: unknown): AutoExpresswayDecisionReason | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = raw as Record<string, unknown>;
  const source = row.source === 'native-auto' ? row.source : null;
  const action = row.action === 'start' || row.action === 'end-prompt' ? row.action : null;
  const evaluatedAt = typeof row.evaluatedAt === 'string' ? row.evaluatedAt : '';
  const speedKmh = Number(row.speedKmh);
  const nativeDetectionId = normalizeNativeDetectionId(row.nativeDetectionId);
  const nativeGeneration = Number(row.nativeGeneration);
  const monotonicSessionId = normalizeNativeDetectionId(row.monotonicSessionId);
  const elapsedRealtimeMs = Number(row.elapsedRealtimeMs);
  if (!source || !action || !evaluatedAt || !Number.isFinite(speedKmh)) return undefined;

  const configRaw = (row.config ?? null) as Record<string, unknown> | null;
  if (!configRaw) return undefined;
  const startSpeedKmh = Number(configRaw.startSpeedKmh);
  const startDurationSec = Number(configRaw.startDurationSec);
  const endSpeedKmh = Number(configRaw.endSpeedKmh);
  const endDurationSec = Number(configRaw.endDurationSec);
  if (
    !Number.isFinite(startSpeedKmh) ||
    !Number.isFinite(startDurationSec) ||
    !Number.isFinite(endSpeedKmh) ||
    !Number.isFinite(endDurationSec)
  ) {
    return undefined;
  }

  const nearestIcDistanceM = Number(row.nearestIcDistanceM);
  const accelerationMs2 = Number(row.accelerationMs2);
  const accuracyM = Number(row.accuracyM);
  const confirmRaw = (row.confirm ?? null) as Record<string, unknown> | null;
  let confirm: AutoExpresswayDecisionReason['confirm'];
  if (confirmRaw) {
    const hits = Number(confirmRaw.hits);
    const elapsedMs = Number(confirmRaw.elapsedMs);
    const minHits = Number(confirmRaw.minHits);
    const minHoldMs = Number(confirmRaw.minHoldMs);
    if (
      Number.isFinite(hits) &&
      Number.isFinite(elapsedMs) &&
      Number.isFinite(minHits) &&
      Number.isFinite(minHoldMs)
    ) {
      confirm = {
        hits: Math.max(0, Math.round(hits)),
        elapsedMs: Math.max(0, Math.round(elapsedMs)),
        minHits: Math.max(1, Math.round(minHits)),
        minHoldMs: Math.max(1, Math.round(minHoldMs)),
      };
    }
  }

  return {
    source,
    ...(nativeDetectionId ? { nativeDetectionId } : {}),
    ...(Number.isSafeInteger(nativeGeneration) && nativeGeneration >= 1
      ? { nativeGeneration }
      : {}),
    ...(monotonicSessionId ? { monotonicSessionId } : {}),
    ...(Number.isFinite(elapsedRealtimeMs) && elapsedRealtimeMs >= 0
      ? { elapsedRealtimeMs }
      : {}),
    action,
    evaluatedAt,
    speedKmh: Math.max(0, Math.min(200, Math.round(speedKmh))),
    ...(Number.isFinite(accelerationMs2) ? { accelerationMs2 } : {}),
    ...(Number.isFinite(accuracyM) ? { accuracyM: Math.max(0, Math.round(accuracyM)) } : {}),
    signalResolved: !!row.signalResolved,
    onExpresswayRoad: !!row.onExpresswayRoad,
    nearIc: !!row.nearIc,
    nearEtcGate: !!row.nearEtcGate,
    ...(typeof row.nearestIcName === 'string' && row.nearestIcName.trim()
      ? { nearestIcName: row.nearestIcName.trim() }
      : {}),
    ...(Number.isFinite(nearestIcDistanceM)
      ? { nearestIcDistanceM: Math.max(0, Math.round(nearestIcDistanceM)) }
      : {}),
    config: {
      startSpeedKmh: Math.max(0, Math.round(startSpeedKmh)),
      startDurationSec: Math.max(1, Math.round(startDurationSec)),
      endSpeedKmh: Math.max(0, Math.round(endSpeedKmh)),
      endDurationSec: Math.max(1, Math.round(endDurationSec)),
    },
    ...(confirm ? { confirm } : {}),
  };
}

function getIcResolveRetryCount(ev: AppEvent): number {
  return getIcResolveRetryCountFromExtras((ev as any).extras);
}

function getIcResolveAlgorithmVersion(ev: AppEvent): number {
  return getIcResolveAlgorithmVersionFromExtras((ev as any).extras);
}

function isStaleIcResolveAlgorithm(ev: AppEvent): boolean {
  return isStaleIcResolveAlgorithmExtras((ev as any).extras);
}

function canRetryIcResolve(ev: AppEvent, nowMs: number, ignorePendingBackoff = false): boolean {
  return canRetryIcResolveExtras((ev as any).extras, nowMs, ignorePendingBackoff);
}

function normalizePendingExpresswayEndPrompt(raw: unknown): PendingExpresswayEndPrompt | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const tripId = typeof row.tripId === 'string' ? row.tripId.trim() : '';
  const speedRaw = Number(row.speedKmh);
  const detectedAt = typeof row.detectedAt === 'string' ? row.detectedAt : '';
  const geoRaw = (row.geo ?? null) as Record<string, unknown> | null;
  if (!tripId || !Number.isFinite(speedRaw) || !detectedAt || !geoRaw) return null;
  const lat = Number(geoRaw.lat);
  const lng = Number(geoRaw.lng);
  const accuracy = Number(geoRaw.accuracy);
  const reason = normalizeAutoExpresswayDecisionReason(row.reason);
  const promptId = normalizeNativeDetectionId(row.promptId);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    tripId,
    ...(promptId ? { promptId } : {}),
    speedKmh: Math.max(0, Math.min(200, Math.round(speedRaw))),
    detectedAt,
    geo: {
      lat,
      lng,
      ...(Number.isFinite(accuracy) ? { accuracy } : {}),
    },
    ...(reason ? { reason } : {}),
  };
}

function normalizePendingExpresswayEndDecision(raw: unknown): PendingExpresswayEndDecision | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const tripId = typeof row.tripId === 'string' ? row.tripId.trim() : '';
  const action = row.action === 'end' || row.action === 'keep' ? row.action : null;
  const decidedAt = typeof row.decidedAt === 'string' ? row.decidedAt : '';
  if (!tripId || !action || !decidedAt) return null;
  const speedRaw = Number(row.speedKmh);
  const nativeDetectionId = normalizeNativeDetectionId(row.nativeDetectionId);
  const promptId = normalizeNativeDetectionId(row.promptId);
  const geoRaw = (row.geo ?? null) as Record<string, unknown> | null;
  let geo: Geo | undefined;
  if (geoRaw) {
    const lat = Number(geoRaw.lat);
    const lng = Number(geoRaw.lng);
    const accuracy = Number(geoRaw.accuracy);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      geo = {
        lat,
        lng,
        ...(Number.isFinite(accuracy) ? { accuracy } : {}),
      };
    }
  }
  return {
    tripId,
    ...(nativeDetectionId ? { nativeDetectionId } : {}),
    ...(promptId ? { promptId } : {}),
    action,
    decidedAt,
    ...(Number.isFinite(speedRaw) ? { speedKmh: Math.max(0, Math.min(200, Math.round(speedRaw))) } : {}),
    ...(geo ? { geo } : {}),
  };
}

export const DEFAULT_AUTO_EXPRESSWAY_CONFIG: AutoExpresswayConfig = {
  speedKmh: 78,
  durationSec: 6,
  endSpeedKmh: 34,
  endDurationSec: 24,
};

function normalizeAutoExpresswayConfig(raw: Partial<AutoExpresswayConfig> | null): AutoExpresswayConfig {
  const speed = Number(raw?.speedKmh);
  const duration = Number(raw?.durationSec);
  const endSpeed = Number(raw?.endSpeedKmh);
  const endDuration = Number(raw?.endDurationSec);
  const speedKmh = Number.isFinite(speed) ? Math.min(Math.max(Math.round(speed), 30), 160) : DEFAULT_AUTO_EXPRESSWAY_CONFIG.speedKmh;
  const durationSec = Number.isFinite(duration)
    ? Math.min(Math.max(Math.round(duration), 1), 60)
    : DEFAULT_AUTO_EXPRESSWAY_CONFIG.durationSec;
  const endSpeedKmh = Number.isFinite(endSpeed)
    ? Math.min(Math.max(Math.round(endSpeed), 10), 120)
    : DEFAULT_AUTO_EXPRESSWAY_CONFIG.endSpeedKmh;
  const endDurationSec = Number.isFinite(endDuration)
    ? Math.min(Math.max(Math.round(endDuration), 5), 300)
    : DEFAULT_AUTO_EXPRESSWAY_CONFIG.endDurationSec;
  return { speedKmh, durationSec, endSpeedKmh, endDurationSec };
}

export async function getAutoExpresswayConfig(): Promise<AutoExpresswayConfig> {
  const raw = await getMeta(META_AUTO_EXPRESSWAY_CONFIG);
  if (!raw) return DEFAULT_AUTO_EXPRESSWAY_CONFIG;
  try {
    const parsed = JSON.parse(raw) as Partial<AutoExpresswayConfig>;
    return normalizeAutoExpresswayConfig(parsed);
  } catch {
    return DEFAULT_AUTO_EXPRESSWAY_CONFIG;
  }
}

export async function setAutoExpresswayConfig(config: AutoExpresswayConfig): Promise<AutoExpresswayConfig> {
  const normalized = normalizeAutoExpresswayConfig(config);
  await setMeta(META_AUTO_EXPRESSWAY_CONFIG, JSON.stringify(normalized));
  return normalized;
}

export async function getRouteTrackingEnabled(): Promise<boolean> {
  const raw = await getMeta(META_ROUTE_TRACKING_ENABLED);
  return raw === '1';
}

export async function setRouteTrackingEnabled(enabled: boolean): Promise<void> {
  await setMeta(META_ROUTE_TRACKING_ENABLED, enabled ? '1' : null);
}

export type RouteTrackingMode = 'precision' | 'battery';

export const DEFAULT_ROUTE_TRACKING_MODE: RouteTrackingMode = 'precision';

function normalizeRouteTrackingMode(raw: string | null): RouteTrackingMode {
  if (raw === 'battery' || raw === 'precision') return raw;
  return DEFAULT_ROUTE_TRACKING_MODE;
}

export async function getRouteTrackingMode(): Promise<RouteTrackingMode> {
  const raw = await getMeta(META_ROUTE_TRACKING_MODE);
  return normalizeRouteTrackingMode(raw);
}

export async function setRouteTrackingMode(mode: RouteTrackingMode): Promise<RouteTrackingMode> {
  const normalized = normalizeRouteTrackingMode(mode);
  await setMeta(META_ROUTE_TRACKING_MODE, normalized);
  return normalized;
}

export async function getPendingExpresswayEndPrompt(): Promise<PendingExpresswayEndPrompt | null> {
  const raw = await getMeta(META_PENDING_EXPRESSWAY_END_PROMPT);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return normalizePendingExpresswayEndPrompt(parsed);
  } catch {
    return null;
  }
}

export async function setPendingExpresswayEndPrompt(prompt: PendingExpresswayEndPrompt): Promise<void> {
  const normalized = normalizePendingExpresswayEndPrompt(prompt);
  if (!normalized) {
    throw new Error('高速終了確認データが不正です');
  }
  const current = await getPendingExpresswayEndPrompt();
  const currentDetectionId = current?.reason?.nativeDetectionId;
  const nextDetectionId = normalized.reason?.nativeDetectionId;
  if (
    (currentDetectionId && currentDetectionId === nextDetectionId)
    || (current?.promptId && current.promptId === normalized.promptId)
  ) {
    return;
  }
  await setMeta(META_PENDING_EXPRESSWAY_END_PROMPT, JSON.stringify(normalized));
}

export async function clearPendingExpresswayEndPrompt(tripId?: string): Promise<void> {
  if (!tripId) {
    await setMeta(META_PENDING_EXPRESSWAY_END_PROMPT, null);
    return;
  }
  const current = await getPendingExpresswayEndPrompt();
  if (current?.tripId === tripId) {
    await setMeta(META_PENDING_EXPRESSWAY_END_PROMPT, null);
  }
}

export async function clearPendingExpresswayEndPromptIfMatches(expected: {
  tripId: string;
  promptId?: string;
  nativeDetectionId?: string;
}): Promise<boolean> {
  const promptId = normalizeNativeDetectionId(expected.promptId);
  const nativeDetectionId = normalizeNativeDetectionId(expected.nativeDetectionId);
  if (!promptId && !nativeDetectionId) return false;
  return db.transaction('rw', db.meta, async () => {
    const raw = (await db.meta.get(META_PENDING_EXPRESSWAY_END_PROMPT))?.value ?? null;
    if (!raw) return false;
    let current: PendingExpresswayEndPrompt | null = null;
    try {
      current = normalizePendingExpresswayEndPrompt(JSON.parse(raw) as unknown);
    } catch {
      return false;
    }
    if (
      current?.tripId !== expected.tripId
      || (promptId && current.promptId !== promptId)
      || (nativeDetectionId && current.reason?.nativeDetectionId !== nativeDetectionId)
    ) {
      return false;
    }
    await db.meta.delete(META_PENDING_EXPRESSWAY_END_PROMPT);
    return true;
  });
}

export async function getPendingExpresswayEndDecision(): Promise<PendingExpresswayEndDecision | null> {
  const raw = await getMeta(META_PENDING_EXPRESSWAY_END_DECISION);
  if (!raw) return null;
  try {
    return normalizePendingExpresswayEndDecision(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export async function setPendingExpresswayEndDecision(decision: PendingExpresswayEndDecision): Promise<void> {
  const normalized = normalizePendingExpresswayEndDecision(decision);
  if (!normalized) throw new Error('高速終了アクションが不正です');
  const current = await getPendingExpresswayEndDecision();
  if (
    (current?.nativeDetectionId
      && current.nativeDetectionId === normalized.nativeDetectionId)
    || (current?.promptId && current.promptId === normalized.promptId)
  ) {
    return;
  }
  await setMeta(META_PENDING_EXPRESSWAY_END_DECISION, JSON.stringify(normalized));
}

export async function clearPendingExpresswayEndDecision(tripId?: string): Promise<void> {
  if (!tripId) {
    await setMeta(META_PENDING_EXPRESSWAY_END_DECISION, null);
    return;
  }
  const current = await getPendingExpresswayEndDecision();
  if (current?.tripId === tripId) {
    await setMeta(META_PENDING_EXPRESSWAY_END_DECISION, null);
  }
}

export async function clearPendingExpresswayKeepDecision(tripId: string): Promise<boolean> {
  return db.transaction('rw', db.meta, async () => {
    const raw = (await db.meta.get(META_PENDING_EXPRESSWAY_END_DECISION))?.value ?? null;
    if (!raw) return false;
    let current: PendingExpresswayEndDecision | null = null;
    try {
      current = normalizePendingExpresswayEndDecision(JSON.parse(raw) as unknown);
    } catch {
      return false;
    }
    if (current?.tripId !== tripId || current.action !== 'keep') return false;
    await db.meta.delete(META_PENDING_EXPRESSWAY_END_DECISION);
    return true;
  });
}

function nativeExpresswayGenerationKey(tripId: string) {
  return `${META_NATIVE_EXPRESSWAY_GENERATION_PREFIX}${encodeURIComponent(tripId)}`;
}

export async function getNativeExpresswayGeneration(tripId: string): Promise<number> {
  const value = Number(await getMeta(nativeExpresswayGenerationKey(tripId)));
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export async function advanceNativeExpresswayGeneration(
  tripId: string,
  generation: number,
): Promise<number> {
  const normalized = Math.max(0, Math.trunc(generation));
  if (!Number.isSafeInteger(normalized)) throw new Error('高速判定世代が不正です');
  const key = nativeExpresswayGenerationKey(tripId);
  return db.transaction('rw', db.meta, async () => {
    const currentValue = Number((await db.meta.get(key))?.value);
    const current = Number.isSafeInteger(currentValue) && currentValue >= 0 ? currentValue : 0;
    const next = Math.max(current, normalized);
    if (next !== current) {
      await db.meta.put({ key, value: String(next), updatedAt: nowIso() });
    }
    return next;
  });
}

// Trip active handling

/**
 * Returns the active tripId from meta if it exists and hasn't been closed.
 * If meta is inconsistent it attempts to derive the active trip from events.
 */
export async function getActiveTripId(): Promise<string | null> {
  const metaTripId = await getMeta(META_ACTIVE_TRIP_ID);
  if (metaTripId) {
    const start = await db.events.where('[tripId+type]').equals([metaTripId, 'trip_start']).first();
    if (start) {
      const end = await db.events.where('[tripId+type]').equals([metaTripId, 'trip_end']).first();
      if (!end) return metaTripId;
    }
    await setMeta(META_ACTIVE_TRIP_ID, null);
  }
  // Derive from events: latest trip_start without trip_end.
  const starts = (await db.events.where('type').equals('trip_start').toArray()) as TripStartEvent[];
  starts.sort((a, b) => b.ts.localeCompare(a.ts));
  for (const s of starts) {
    const e = await db.events.where('[tripId+type]').equals([s.tripId, 'trip_end']).first();
    if (!e) {
      await setMeta(META_ACTIVE_TRIP_ID, s.tripId);
      return s.tripId;
    }
  }
  return null;
}

export async function clearActiveTripId() {
  await setMeta(META_ACTIVE_TRIP_ID, null);
}

export async function getRemoteRoutePointsUploadedThrough(): Promise<string | null> {
  return getMeta(META_REMOTE_ROUTE_POINTS_UPLOADED_THROUGH);
}

export async function setRemoteRoutePointsUploadedThrough(value: string | null): Promise<void> {
  await setMeta(META_REMOTE_ROUTE_POINTS_UPLOADED_THROUGH, value);
}

// Event CRUD

export async function updateEventAddress(eventId: string, address?: string) {
  await db.events.update(eventId, { address });
  notifyRemoteMutation('event-address-update');
}

export async function updateEventTimestamp(eventId: string, ts: string) {
  const ev = await db.events.get(eventId);
  if (!ev) throw new Error('イベントが見つかりません');
  await db.transaction('rw', db.events, db.routePoints, async () => {
    await db.events.update(eventId, { ts, syncStatus: 'pending' });
    const anchorId = getRoutePointAnchorId(eventId);
    const existingAnchor = await db.routePoints.get(anchorId);
    if (existingAnchor) {
      await db.routePoints.update(anchorId, { ts });
    }
  });
  await rebalanceDayCloseIndices(ev.tripId);
  notifyRemoteMutation('event-timestamp-update');
}

const SESSION_KEYS = [
  'restSessionId',
  'breakSessionId',
  'loadSessionId',
  'unloadSessionId',
  'expresswaySessionId',
  'ferrySessionId',
] as const;

type SessionKey = (typeof SESSION_KEYS)[number];

const SESSION_KEY_BY_TYPE: Partial<Record<EventType, SessionKey>> = {
  rest_start: 'restSessionId',
  rest_end: 'restSessionId',
  break_start: 'breakSessionId',
  break_end: 'breakSessionId',
  load_start: 'loadSessionId',
  load_end: 'loadSessionId',
  unload_start: 'unloadSessionId',
  unload_end: 'unloadSessionId',
  expressway_start: 'expresswaySessionId',
  expressway_end: 'expresswaySessionId',
  boarding: 'ferrySessionId',
  disembark: 'ferrySessionId',
};

const BASIC_TOGGLE_GROUPS = PERSISTED_BASIC_TOGGLE_DEFINITIONS;

const TOGGLE_GROUPS = [
  ...BASIC_TOGGLE_GROUPS,
  EXPRESSWAY_TOGGLE_DEFINITION,
] as const;

type ToggleGroup = (typeof TOGGLE_GROUPS)[number];
type BasicToggleGroup = (typeof BASIC_TOGGLE_GROUPS)[number];

function getToggleGroupByType(type: EventType): ToggleGroup | null {
  return TOGGLE_GROUPS.find(g => g.start === type || g.end === type) ?? null;
}

function pickExistingSessionId(extras: Record<string, unknown>): string | null {
  for (const key of SESSION_KEYS) {
    const val = extras[key];
    if (typeof val === 'string' && val.trim()) return val;
  }
  return null;
}

function findPairedToggleEvent(
  events: AppEvent[],
  ev: AppEvent,
  group: ToggleGroup,
  typeOverride?: EventType,
): AppEvent | undefined {
  const targetType = typeOverride ?? ev.type;
  const target = targetType === ev.type ? ev : ({ ...ev, type: targetType } as AppEvent);
  const candidateEvents = target === ev
    ? events
    : events.map(candidate => candidate.id === ev.id ? target : candidate);
  const result = resolveTogglePairing(candidateEvents, [group]);
  const pair = findAcceptedTogglePair(result, target);
  if (!pair) return undefined;
  return pair.start.id === target.id ? pair.end : pair.start;
}

function applyTypeExtras(
  type: EventType,
  extras: Record<string, unknown>,
  sessionId?: string,
): Record<string, unknown> {
  const targetSessionKey = SESSION_KEY_BY_TYPE[type];
  if (targetSessionKey) {
    const sid =
      (typeof sessionId === 'string' && sessionId.trim() ? sessionId : null) ??
      (typeof extras[targetSessionKey] === 'string' && String(extras[targetSessionKey]).trim()
        ? (extras[targetSessionKey] as string)
        : null) ??
      pickExistingSessionId(extras) ??
      uuid();
    extras[targetSessionKey] = sid;
    for (const key of SESSION_KEYS) {
      if (key !== targetSessionKey) {
        delete (extras as any)[key];
      }
    }
  } else {
    for (const key of SESSION_KEYS) {
      delete (extras as any)[key];
    }
  }

  if (type === 'rest_end') {
    if (typeof (extras as any).dayClose !== 'boolean') {
      (extras as any).dayClose = false;
    }
  }
  if (type === 'expressway' || type === 'expressway_start' || type === 'expressway_end') {
    if ((extras as any).icResolveStatus == null) {
      (extras as any).icResolveStatus = 'pending';
    }
  }
  return extras;
}

export async function updateEventType(eventId: string, nextType: EventType) {
  const ev = await db.events.get(eventId);
  if (!ev) throw new Error('イベントが見つかりません');
  if (ev.type === nextType) return;
  if (ev.type === 'trip_start' || ev.type === 'trip_end') {
    throw new Error('運行開始/終了の項目は変更できません');
  }
  if (nextType === 'trip_start' || nextType === 'trip_end') {
    throw new Error('運行開始/終了には変更できません');
  }

  const events = await getEventsByTripId(ev.tripId);
  const oldGroup = getToggleGroupByType(ev.type);
  const newGroup = getToggleGroupByType(nextType);
  let pairedEvent: AppEvent | undefined;

  if (oldGroup && !newGroup) {
    throw new Error('開始/終了のイベントは単独イベントに変更できません。ペアで変更してください。');
  }

  if (newGroup) {
    pairedEvent = oldGroup ? findPairedToggleEvent(events, ev, oldGroup) : undefined;
    if (!pairedEvent) {
      pairedEvent = findPairedToggleEvent(events, ev, newGroup, nextType);
    }
    if (!pairedEvent) {
      throw new Error('開始/終了の対になるイベントが見つかりません。ペアになるイベントを先に用意してください。');
    }
  }

  const extras = { ...(ev as any).extras } as Record<string, unknown>;

  if (nextType === 'rest_start') {
    const odo = Number((extras as any).odoKm);
    if (!Number.isFinite(odo) || odo <= 0) {
      throw new Error('休息開始に変更するにはODOが必要です。先にODOを入力してください。');
    }
  }

  const sessionKey = SESSION_KEY_BY_TYPE[nextType];
  const pairedExtras = pairedEvent ? ({ ...(pairedEvent as any).extras } as Record<string, unknown>) : null;
  const sessionId =
    (sessionKey && typeof extras[sessionKey] === 'string' && String(extras[sessionKey]).trim()
      ? (extras[sessionKey] as string)
      : null) ??
    (sessionKey && pairedExtras && typeof pairedExtras[sessionKey] === 'string' && String(pairedExtras[sessionKey]).trim()
      ? (pairedExtras[sessionKey] as string)
      : null) ??
    pickExistingSessionId(extras) ??
    (pairedExtras ? pickExistingSessionId(pairedExtras) : null) ??
    (sessionKey ? uuid() : null) ??
    undefined;

  const nextExtras = applyTypeExtras(nextType, extras, sessionId);
  const updates: Array<{ id: string; type: EventType; extras: Record<string, unknown> }> = [
    { id: ev.id, type: nextType, extras: nextExtras },
  ];

  let pairType: EventType | null = null;
  if (newGroup && pairedEvent) {
    pairType = nextType === newGroup.start ? newGroup.end : newGroup.start;
    const updatedPairExtras = applyTypeExtras(pairType, pairedExtras ?? {}, sessionId);
    updates.push({ id: pairedEvent.id, type: pairType, extras: updatedPairExtras });
  }

  await db.transaction('rw', db.events, async () => {
    for (const u of updates) {
      await db.events.update(u.id, { type: u.type, extras: u.extras, syncStatus: 'pending' });
    }
  });

  const needsRebalance =
    ev.type === 'rest_end' ||
    nextType === 'rest_end' ||
    (pairedEvent?.type === 'rest_end') ||
    pairType === 'rest_end';
  if (needsRebalance) {
    await rebalanceDayCloseIndices(ev.tripId);
  }
  const needsTotals =
    ev.type === 'rest_start' ||
    nextType === 'rest_start' ||
    (pairedEvent?.type === 'rest_start') ||
    pairType === 'rest_start';
  if (needsTotals) {
    await recomputeTripEndTotals(ev.tripId);
  }
  notifyRemoteMutation('event-type-update');
}

async function recomputeTripEndTotals(tripId: string) {
  const events = await getEventsByTripId(tripId);
  const start = events.find(e => e.type === 'trip_start') as TripStartEvent | undefined;
  const end = [...events].reverse().find(e => e.type === 'trip_end') as TripEndEvent | undefined;
  if (!start || !end) return;
  const restStarts = (events.filter(e => e.type === 'rest_start') as RestStartEvent[])
    .filter(isRestStartOdoCheckpoint);
  restStarts.sort((a, b) => a.ts.localeCompare(b.ts));
  const lastRestStartOdo = restStarts.length > 0 ? restStarts[restStarts.length - 1].extras.odoKm : undefined;
  const totals = computeTotals({
    odoStart: start.extras.odoKm,
    odoEnd: end.extras.odoKm,
    lastRestStartOdo,
  });
  const extras = { ...(end as any).extras, totalKm: totals.totalKm, lastLegKm: totals.lastLegKm };
  await db.events.update(end.id, { extras, syncStatus: 'pending' });
}

export async function updateEventOdo(eventId: string, odoKm: number) {
  if (!Number.isFinite(odoKm) || odoKm <= 0) throw new Error('オドメーターが不正です');
  const ev = await db.events.get(eventId);
  if (!ev) throw new Error('イベントが見つかりません');
  if (!['trip_start', 'rest_start', 'trip_end'].includes(ev.type)) {
    throw new Error('このイベントではオドメーターを編集できません');
  }
  const extras = { ...(ev as any).extras, odoKm };
  await db.events.update(eventId, { extras, syncStatus: 'pending' });
  await recomputeTripEndTotals(ev.tripId);
  notifyRemoteMutation('event-odo-update');
}

export async function updateEventLiters(eventId: string, liters: number) {
  if (!Number.isFinite(liters) || liters <= 0) throw new Error('給油量が不正です');
  const ev = await db.events.get(eventId);
  if (!ev) throw new Error('イベントが見つかりません');
  if (ev.type !== 'refuel') {
    throw new Error('給油イベントではありません');
  }
  const extras = { ...(ev as any).extras, liters };
  await db.events.update(eventId, { extras, syncStatus: 'pending' });
  notifyRemoteMutation('event-liters-update');
}

function assertExpresswayEvent(ev: AppEvent) {
  if (!EXPRESSWAY_EVENT_TYPES.includes(ev.type as any)) {
    throw new Error('高速道路イベントではありません');
  }
}

export async function updateExpresswayIcNameManual(eventId: string, icName: string) {
  const name = icName.trim();
  if (!name) throw new Error('IC名を入力してください');
  const ev = await db.events.get(eventId);
  if (!ev) throw new Error('イベントが見つかりません');
  assertExpresswayEvent(ev);
  const extras = { ...(ev as any).extras };
  extras.icName = name;
  extras.icResolveStatus = 'resolved';
  extras.icResolveAlgorithmVersion = IC_RESOLVE_ALGORITHM_VERSION;
  extras.icResolvedManually = true;
  extras.icResolveManualUpdatedAt = nowIso();
  extras.icResolveRetryCount = 0;
  delete extras.icDistanceM;
  delete extras.icResolveNextRetryAt;
  delete extras.icResolveLastAttemptAt;
  delete extras.icResolveError;
  await db.events.update(eventId, { extras, syncStatus: 'pending' });
  notifyRemoteMutation('expressway-ic-manual');
  notifyTrackLogEventsChanged();
}

export async function refreshExpresswayIcFromGeo(eventId: string): Promise<{ icName: string; distanceM: number }> {
  const ev = await db.events.get(eventId);
  if (!ev) throw new Error('イベントが見つかりません');
  assertExpresswayEvent(ev);
  const expectedVersion = captureIcResolutionEventVersion(ev);
  const preserveExistingManual = expectedVersion.resolvedManually;
  const geo = (ev as any).geo as Geo | undefined;
  if (!geo) {
    if (!preserveExistingManual) {
      await markExpresswayResolveFailure({
        eventId,
        errorMessage: '位置情報が未保存のためIC解決不可',
        nextRetryAt: null,
        guard: { expectedVersion, allowExistingManual: true },
      });
    }
    throw new Error('このイベントには位置情報が保存されていません');
  }

  const result = await resolveNearestIC(geo.lat, geo.lng);
  if (!result) {
    if (!preserveExistingManual) {
      await markExpresswayResolveFailure({
        eventId,
        errorMessage: '近傍ICを取得できませんでした',
        nextRetryAt: null,
        guard: { expectedVersion, allowExistingManual: true },
      });
    }
    throw new Error('近傍ICを取得できませんでした');
  }
  await updateExpresswayResolved({
    eventId,
    status: 'resolved',
    icName: result.icName,
    icDistanceM: result.distanceM,
    clearManualResolution: true,
    guard: { expectedVersion, allowExistingManual: true },
  });
  return result;
}

function getRoutePointAnchorId(eventId: string) {
  return `event-anchor-${eventId}`;
}

function buildRoutePointAnchorFromEvent(event: AppEvent): RoutePoint | null {
  if (!event.geo) return null;
  return {
    id: getRoutePointAnchorId(event.id),
    tripId: event.tripId,
    ts: event.ts,
    updatedAt: nowIso(),
    lat: event.geo.lat,
    lng: event.geo.lng,
    ...(Number.isFinite(event.geo.accuracy) ? { accuracy: event.geo.accuracy } : {}),
    source: 'event',
  };
}

async function putEventWithRoutePointTx(event: AppEvent) {
  await db.events.put(event);
  const routePoint = buildRoutePointAnchorFromEvent(event);
  if (routePoint) {
    await db.routePoints.put(routePoint);
  }
}

export async function addEvent(event: AppEvent) {
  await db.transaction('rw', db.events, db.routePoints, async () => {
    await putEventWithRoutePointTx(event);
  });
  notifyRemoteMutation(`event-${event.type}`);
}

export async function addRoutePoint(point: Omit<RoutePoint, 'id'> & { id?: string }): Promise<RoutePoint> {
  if (point.id) {
    const existing = await db.routePoints.get(point.id);
    if (existing) return existing;
  }
  const id = point.id ?? uuid();
  const row: RoutePoint = {
    id,
    tripId: point.tripId,
    ts: point.ts,
    updatedAt: nowIso(),
    lat: point.lat,
    lng: point.lng,
    accuracy: normalizeRoutePointAccuracy(point.accuracy) ?? undefined,
    speed: normalizeRoutePointSpeed(point.speed),
    heading: normalizeRoutePointHeading(point.heading),
    source: point.source,
  };
  await db.routePoints.put(row);
  notifyRemoteMutation('route-point');
  return row;
}

export async function pruneRoutePointsForRetention(params?: {
  maxClosedTripsToKeep?: number;
  maxAgeDays?: number;
}): Promise<{ removedTrips: number; removedPoints: number }> {
  const maxClosedTripsToKeep = Math.max(1, Math.round(params?.maxClosedTripsToKeep ?? 120));
  const maxAgeDays = Math.max(14, Math.round(params?.maxAgeDays ?? 120));
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  const activeTripId = await getActiveTripId();
  const starts = (await db.events.where('type').equals('trip_start').toArray()) as TripStartEvent[];
  const ends = (await db.events.where('type').equals('trip_end').toArray()) as TripEndEvent[];
  const endByTrip = new Map<string, TripEndEvent>();
  for (const e of ends) {
    const prev = endByTrip.get(e.tripId);
    if (!prev || e.ts > prev.ts) endByTrip.set(e.tripId, e);
  }

  const closed = starts
    .filter(s => !!endByTrip.get(s.tripId))
    .sort((a, b) => b.ts.localeCompare(a.ts));

  const keep = new Set<string>();
  if (activeTripId) keep.add(activeTripId);
  for (let i = 0; i < closed.length; i++) {
    const start = closed[i];
    const startMs = Date.parse(start.ts);
    const recentEnough = Number.isFinite(startMs) && startMs >= cutoffMs;
    if (i < maxClosedTripsToKeep || recentEnough) {
      keep.add(start.tripId);
    }
  }

  const allPointTripIds = Array.from(new Set((await db.routePoints.toArray()).map(p => p.tripId)));
  const staleTripIds = allPointTripIds.filter(tripId => !keep.has(tripId));
  if (staleTripIds.length === 0) return { removedTrips: 0, removedPoints: 0 };

  let removedPoints = 0;
  for (const tripId of staleTripIds) {
    const count = await db.routePoints.where('tripId').equals(tripId).count();
    if (count > 0) {
      await db.routePoints.where('tripId').equals(tripId).delete();
      removedPoints += count;
    }
  }
  return { removedTrips: staleTripIds.length, removedPoints };
}

export async function listRoutePointsByTripId(tripId: string): Promise<RoutePoint[]> {
  const arr = await db.routePoints.where('tripId').equals(tripId).toArray();
  arr.sort((a, b) => a.ts.localeCompare(b.ts));
  return arr;
}

export async function getAllRoutePoints(): Promise<RoutePoint[]> {
  const arr = await db.routePoints.toArray();
  arr.sort((a, b) => a.ts.localeCompare(b.ts));
  return arr;
}

export async function listRoutePointsChangedSince(updatedThrough: string | null): Promise<RoutePoint[]> {
  const arr = await db.routePoints
    .filter(point => !updatedThrough || (!!point.updatedAt && point.updatedAt > updatedThrough))
    .toArray();
  arr.sort((a, b) => a.ts.localeCompare(b.ts));
  return arr;
}

export async function getLatestRoutePoint(): Promise<RoutePoint | null> {
  const point = await db.routePoints.orderBy('ts').last();
  return point ?? null;
}

export async function getEventsByTripId(tripId: string): Promise<AppEvent[]> {
  const arr = await db.events.where('tripId').equals(tripId).toArray();
  arr.sort((a, b) => a.ts.localeCompare(b.ts));
  return arr;
}

export async function getAllEvents(): Promise<AppEvent[]> {
  const arr = await db.events.toArray();
  arr.sort((a, b) => a.ts.localeCompare(b.ts));
  return arr;
}

export async function getDeletedEventTombstones() {
  return db.deletedEventTombstones.orderBy('deletedAt').toArray();
}

// Trip operations

export async function startTrip(params: {
  odoKm: number;
  geo?: Geo;
  address?: string;
  occurredAt?: string;
}): Promise<{ tripId: string; event: TripStartEvent }> {
  const tripId = uuid();
  let event: TripStartEvent | undefined;
  await db.transaction('rw', db.events, db.meta, db.routePoints, async () => {
    const activeTripId = await getActiveTripId();
    if (activeTripId) {
      throw new Error('進行中の運行があるため、新しい運行を開始できません');
    }
    event = {
      id: uuid(),
      tripId,
      type: 'trip_start',
      ts: resolveOccurredAt(params.occurredAt),
      geo: params.geo,
      address: params.address,
      syncStatus: 'pending',
      extras: { odoKm: params.odoKm },
    };
    await putEventWithRoutePointTx(event);
    await setMeta(META_ACTIVE_TRIP_ID, tripId);
    await setMeta(META_PENDING_EXPRESSWAY_END_PROMPT, null);
    await setMeta(META_PENDING_EXPRESSWAY_END_DECISION, null);
  });
  if (!event) throw new Error('運行開始イベントを保存できませんでした');
  notifyRemoteMutation('trip-start');
  return { tripId, event };
}

export async function endTrip(params: {
  tripId: string;
  odoEndKm: number;
  geo?: Geo;
  address?: string;
  occurredAt?: string;
}): Promise<{ event: TripEndEvent }> {
  const occurredAt = resolveOccurredAt(params.occurredAt);
  let event: TripEndEvent | undefined;
  await db.transaction('rw', db.events, db.meta, db.routePoints, async () => {
    const activeTripId = await getActiveTripId();
    if (activeTripId !== params.tripId) {
      throw new Error('対象の運行は進行中ではありません');
    }
    const events = await getTripEventsCached(params.tripId);
    assertTripOpen(events);
    await assertDueBreakCanCloseTx(events, params.tripId, occurredAt);
    const start = events.find(e => e.type === 'trip_start') as TripStartEvent;
    const restStarts = (events.filter(e => e.type === 'rest_start') as RestStartEvent[])
      .filter(isRestStartOdoCheckpoint);
    restStarts.sort((a, b) => a.ts.localeCompare(b.ts));
    const lastRestStartOdo = restStarts.length > 0
      ? restStarts[restStarts.length - 1].extras.odoKm
      : undefined;
    if (params.odoEndKm < start.extras.odoKm) {
      throw new Error('運行終了メーターが運行開始より小さいため保存できません');
    }
    if (lastRestStartOdo != null && params.odoEndKm < lastRestStartOdo) {
      throw new Error('運行終了メーターが最後の休息開始メーターより小さいため保存できません');
    }
    const totals = computeTotals({
      odoStart: start.extras.odoKm,
      odoEnd: params.odoEndKm,
      lastRestStartOdo,
    });
    event = {
      id: uuid(),
      tripId: params.tripId,
      type: 'trip_end',
      ts: occurredAt,
      geo: params.geo,
      address: params.address,
      syncStatus: 'pending',
      extras: {
        odoKm: params.odoEndKm,
        totalKm: totals.totalKm,
        lastLegKm: totals.lastLegKm,
      },
    };
    await putEventWithRoutePointTx(event);
    await clearActiveTripId();
    await clearPendingExpresswayEndPrompt(params.tripId);
    await clearPendingExpresswayEndDecision(params.tripId);
    await clearBreakToRestConfirmationsForTripTx(params.tripId);
  });
  if (!event) throw new Error('運行終了イベントを保存できませんでした');
  notifyRemoteMutation('trip-end');
  return { event };
}

// Rest operations

export async function startRest(params: {
  tripId: string;
  odoKm: number;
  geo?: Geo;
  address?: string;
  occurredAt?: string;
}): Promise<{ restSessionId: string; event: RestStartEvent }> {
  const restSessionId = uuid();
  let event: RestStartEvent | undefined;
  await db.transaction('rw', db.events, db.routePoints, async () => {
    const events = await getTripEventsCached(params.tripId);
    assertTripOpen(events);
    assertCanStartBasicToggle(events, BASIC_TOGGLE_GROUPS[0]);
    const odoCheckpoint = normalizeOptionalRestStartOdometer(params.odoKm);
    const lastOdo = odoCheckpoint != null ? findLatestOdoCheckpoint(events) : null;
    if (odoCheckpoint != null && lastOdo != null && odoCheckpoint < lastOdo) {
      throw new Error('休息開始メーターが前回メーターより小さいため保存できません');
    }
    event = {
      id: uuid(),
      tripId: params.tripId,
      type: 'rest_start',
      ts: resolveOccurredAt(params.occurredAt),
      geo: params.geo,
      address: params.address,
      syncStatus: 'pending',
      extras: {
        restSessionId,
        ...(odoCheckpoint != null ? { odoKm: odoCheckpoint } : {}),
        reportMinDurationMinutes: REPORT_MIN_DURATION_MINUTES,
      },
    };
    await putEventWithRoutePointTx(event);
  });
  if (!event) throw new Error('休息開始イベントを保存できませんでした');
  notifyRemoteMutation('event-rest_start');
  return { restSessionId, event };
}

export async function endRest(params: {
  tripId: string;
  restSessionId: string;
  dayClose: boolean;
  geo?: Geo;
  address?: string;
  occurredAt?: string;
}): Promise<{ event: RestEndEvent }> {
  let event: RestEndEvent | undefined;
  const occurredAt = resolveOccurredAt(params.occurredAt);
  await db.transaction('rw', db.events, db.routePoints, async () => {
    const events = await getTripEventsCached(params.tripId);
    assertTripOpen(events);
    const open = requireOpenToggle(events, BASIC_TOGGLE_GROUPS[0]);
    if (open !== LEGACY_TOGGLE_SESSION_ID && open !== params.restSessionId) {
      throw new Error('対応する休息開始が進行中ではありません');
    }
    const dayIndex = params.dayClose ? getNextDayIndexFromTripEvents(events) : undefined;
    const openFerrySessionId = findOpenToggleSessionId(events, BASIC_TOGGLE_GROUPS[4]);
    event = {
      id: uuid(),
      tripId: params.tripId,
      type: 'rest_end',
      ts: occurredAt,
      geo: params.geo,
      address: params.address,
      syncStatus: 'pending',
      extras: {
        restSessionId: params.restSessionId,
        dayClose: params.dayClose,
        ...(dayIndex != null ? { dayIndex } : {}),
      },
    };
    if (openFerrySessionId) {
      await putEventWithRoutePointTx({
        id: uuid(),
        tripId: params.tripId,
        type: 'disembark',
        ts: occurredAt,
        geo: params.geo,
        address: params.address,
        syncStatus: 'pending',
        extras:
          openFerrySessionId === LEGACY_TOGGLE_SESSION_ID
            ? undefined
            : { ferrySessionId: openFerrySessionId },
      });
    }
    await putEventWithRoutePointTx(event);
  });
  if (!event) throw new Error('休息終了イベントを保存できませんでした');
  notifyRemoteMutation('rest-end');
  return { event };
}

// Helpers for day index and odometer checkpoints

export function getAcceptedRestDayCloses(events: readonly AppEvent[]): RestEndEvent[] {
  return resolveTogglePairing(events, [BASIC_TOGGLE_GROUPS[0]]).pairs
    .map(pair => pair.end)
    .filter((event): event is RestEndEvent => (
      event.type === 'rest_end' && (event as RestEndEvent).extras?.dayClose === true
    ));
}

export function getNextDayIndexFromTripEvents(events: AppEvent[]): number {
  const closes = getAcceptedRestDayCloses(events);
  const indices = closes
    .map(e => (e as any).extras?.dayIndex)
    .filter((n): n is number => typeof n === 'number');
  if (indices.length > 0) return Math.max(...indices) + 1;
  return closes.length + 1;
}

function findLatestOdoCheckpoint(events: AppEvent[]): number | null {
  const sorted = [...events].sort((a, b) => b.ts.localeCompare(a.ts));
  for (const e of sorted) {
    if (e.type === 'rest_start' && isRestStartOdoCheckpoint(e as RestStartEvent)) {
      return (e as RestStartEvent).extras.odoKm ?? null;
    }
    if (e.type === 'trip_start') return (e as TripStartEvent).extras.odoKm;
    if (e.type === 'trip_end') return (e as TripEndEvent).extras.odoKm;
  }
  return null;
}

// Toggle helpers
function baseEvent(params: {
  tripId: string;
  type: any;
  geo?: Geo;
  address?: string;
  occurredAt?: string;
  extras?: Record<string, unknown>;
}): AppEvent {
  return {
    id: uuid(),
    tripId: params.tripId,
    type: params.type,
    ts: resolveOccurredAt(params.occurredAt),
    geo: params.geo,
    address: params.address,
    syncStatus: 'pending',
    extras: params.extras,
  } as AppEvent;
}

async function getTripEventsCached(tripId: string) {
  const events = await db.events.where('tripId').equals(tripId).toArray();
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  return events;
}

function assertTripOpen(events: AppEvent[]): void {
  if (!events.some(event => event.type === 'trip_start')) {
    throw new Error('運行開始イベントが存在しません');
  }
  if (events.some(event => event.type === 'trip_end')) {
    throw new Error('終了済みの運行には操作を追加できません');
  }
}

function assertCanStartBasicToggle(events: AppEvent[], requested: BasicToggleGroup): void {
  for (const group of BASIC_TOGGLE_GROUPS) {
    const open = findOpenToggleSessionId(events, group);
    if (!open) continue;
    if (group.start === requested.start) {
      throw new Error(`${group.label}がすでに開始されています（終了してください）`);
    }
    throw new Error(`${group.label}が進行中です。終了してから${requested.label}を開始してください`);
  }
}

function requireOpenToggle(events: AppEvent[], group: BasicToggleGroup): string {
  const open = findOpenToggleSessionId(events, group);
  if (!open) throw new Error(`${group.label}が開始されていません`);
  return open;
}

async function startBasicToggleOperation(
  params: { tripId: string; geo?: Geo; address?: string; occurredAt?: string },
  group: BasicToggleGroup,
  notifyReason: string,
): Promise<{ sessionId: string; event: AppEvent }> {
  const sessionId = uuid();
  let event: AppEvent | undefined;
  await db.transaction('rw', db.events, db.routePoints, async () => {
    const events = await getTripEventsCached(params.tripId);
    assertTripOpen(events);
    assertCanStartBasicToggle(events, group);
    event = baseEvent({
      tripId: params.tripId,
      type: group.start,
      geo: params.geo,
      address: params.address,
      occurredAt: params.occurredAt,
      extras: {
        [group.key]: sessionId,
        reportMinDurationMinutes: REPORT_MIN_DURATION_MINUTES,
      },
    });
    await putEventWithRoutePointTx(event);
  });
  if (!event) throw new Error(`${group.label}開始イベントを保存できませんでした`);
  notifyRemoteMutation(notifyReason);
  return { sessionId, event };
}

async function endBasicToggleOperation(
  params: { tripId: string; geo?: Geo; address?: string; occurredAt?: string },
  group: BasicToggleGroup,
  notifyReason: string,
): Promise<AppEvent> {
  let event: AppEvent | undefined;
  await db.transaction('rw', db.events, db.routePoints, async () => {
    const events = await getTripEventsCached(params.tripId);
    assertTripOpen(events);
    const open = requireOpenToggle(events, group);
    event = baseEvent({
      tripId: params.tripId,
      type: group.end,
      geo: params.geo,
      address: params.address,
      occurredAt: params.occurredAt,
      extras: open === LEGACY_TOGGLE_SESSION_ID ? undefined : { [group.key]: open },
    });
    await putEventWithRoutePointTx(event);
  });
  if (!event) throw new Error(`${group.label}終了イベントを保存できませんでした`);
  notifyRemoteMutation(notifyReason);
  return event;
}

// Load (積込) operations
export async function startLoad(params: { tripId: string; geo?: Geo; address?: string; occurredAt?: string }) {
  const { sessionId } = await startBasicToggleOperation(
    params,
    BASIC_TOGGLE_GROUPS[2],
    'event-load_start',
  );
  return { loadSessionId: sessionId };
}

export async function endLoad(params: { tripId: string; geo?: Geo; address?: string; occurredAt?: string }) {
  await endBasicToggleOperation(params, BASIC_TOGGLE_GROUPS[2], 'event-load_end');
}

// Unload (荷卸) operations
export async function startUnload(params: { tripId: string; geo?: Geo; address?: string; occurredAt?: string }) {
  const { sessionId } = await startBasicToggleOperation(
    params,
    BASIC_TOGGLE_GROUPS[3],
    'event-unload_start',
  );
  return { unloadSessionId: sessionId };
}

export async function endUnload(params: { tripId: string; geo?: Geo; address?: string; occurredAt?: string }) {
  await endBasicToggleOperation(params, BASIC_TOGGLE_GROUPS[3], 'event-unload_end');
}

// Break (休憩) operations
export async function startBreak(params: { tripId: string; geo?: Geo; address?: string; occurredAt?: string }) {
  const { sessionId } = await startBasicToggleOperation(
    params,
    BASIC_TOGGLE_GROUPS[1],
    'event-break_start',
  );
  return { breakSessionId: sessionId };
}

async function putBreakToRestTransitionTx(transition: BreakToRestTransition): Promise<RestStartEvent> {
  const restStart: RestStartEvent = {
    ...transition.restStart,
    extras: {
      ...transition.restStart.extras,
      reportMinDurationMinutes: REPORT_MIN_DURATION_MINUTES,
    },
  };
  await putEventWithRoutePointTx(transition.breakEnd);
  await putEventWithRoutePointTx(restStart);
  return restStart;
}

export async function getBreakToRestConfirmationState(params: {
  tripId: string;
  evaluatedAt?: string;
}): Promise<BreakToRestConfirmationState | null> {
  const evaluatedAt = resolveOccurredAt(params.evaluatedAt);
  let state: BreakToRestConfirmationState | null = null;
  await db.transaction('rw', db.events, db.meta, async () => {
    const events = await getTripEventsCached(params.tripId);
    const thresholdTs = getOpenBreakToRestThresholdTs(events);
    if (!thresholdTs) return;
    const thresholdMs = Date.parse(thresholdTs);
    const evaluatedAtMs = Date.parse(evaluatedAt);
    if (!Number.isFinite(thresholdMs) || !Number.isFinite(evaluatedAtMs)) return;

    // A final answer belongs to the break-start identity, not to its editable
    // timestamp. Rebuild the candidate at the current threshold so an existing
    // declined/approved answer is still visible after a timeline edit, while a
    // brand-new break remains silent until it actually reaches three hours.
    const candidate = findDueBreakToRestCandidate(
      events,
      evaluatedAtMs < thresholdMs ? thresholdTs : evaluatedAt,
    );
    if (!candidate || candidate.tripId !== params.tripId) return;

    const key = breakToRestConfirmationKey(params.tripId, candidate.breakStartId);
    const raw = (await db.meta.get(key))?.value ?? null;
    let stored = parseStoredBreakToRestConfirmation(raw, candidate);
    if (!stored) {
      if (evaluatedAtMs < thresholdMs) return;
      stored = createStoredBreakToRestConfirmation({
        candidate,
        status: 'pending',
        updatedAt: nowIso(),
      });
      await db.meta.put({
        key,
        value: serializeStoredBreakToRestConfirmation(stored),
        updatedAt: stored.updatedAt,
      });
    }
    state = publicBreakToRestConfirmationState(candidate, stored.status);
  });
  return state;
}

export async function getBreakToRestPromptState(params: {
  tripId: string;
  evaluatedAt?: string;
}): Promise<BreakToRestPromptState | null> {
  const evaluatedAt = resolveOccurredAt(params.evaluatedAt);
  const state = await getBreakToRestConfirmationState({
    tripId: params.tripId,
    evaluatedAt,
  });
  if (!state || state.status === 'declined') return null;
  if (Date.parse(evaluatedAt) < Date.parse(state.thresholdTs)) return null;
  const { status, ...candidate } = state;
  return { ...candidate, decision: status };
}

export async function setBreakToRestPromptDecision(params: {
  tripId: string;
  breakStartId: string;
  decision: 'approved' | 'declined';
  evaluatedAt?: string;
}): Promise<BreakToRestConfirmationState> {
  if (params.decision !== 'approved' && params.decision !== 'declined') {
    throw new Error('休憩確認の回答が不正です');
  }
  const evaluatedAt = resolveOccurredAt(params.evaluatedAt);
  let state: BreakToRestConfirmationState | undefined;
  await db.transaction('rw', db.events, db.meta, async () => {
    const events = await getTripEventsCached(params.tripId);
    const candidate = findDueBreakToRestCandidate(events, evaluatedAt);
    if (!candidate || candidate.breakStartId !== params.breakStartId) {
      throw new Error('対象の休憩は確認待ちではありません');
    }

    const key = breakToRestConfirmationKey(params.tripId, params.breakStartId);
    const raw = (await db.meta.get(key))?.value ?? null;
    const stored = parseStoredBreakToRestConfirmation(raw, candidate);
    if (stored && stored.status !== 'pending' && stored.status !== params.decision) {
      throw new Error('この休憩の回答はすでに確定しています');
    }

    const updated = createStoredBreakToRestConfirmation({
      candidate,
      status: params.decision,
      updatedAt: nowIso(),
    });
    await db.meta.put({
      key,
      value: serializeStoredBreakToRestConfirmation(updated),
      updatedAt: updated.updatedAt,
    });
    state = publicBreakToRestConfirmationState(candidate, updated.status);
  });
  if (!state) throw new Error('休憩確認の回答を保存できませんでした');
  return state;
}

function getPersistedBreakToRestTransition(
  events: readonly AppEvent[],
  tripId: string,
  breakStartId: string,
): { restStart: RestStartEvent | null; partial: boolean } {
  const idBase = `auto-break-rest-${breakStartId}`;
  const breakEnd = events.find(event => event.id === `${idBase}-0-break-end`);
  const restStart = events.find(event => event.id === `${idBase}-1-rest-start`);
  if (!breakEnd && !restStart) return { restStart: null, partial: false };
  if (
    !breakEnd
    || !restStart
    || breakEnd.tripId !== tripId
    || restStart.tripId !== tripId
    || breakEnd.type !== 'break_end'
    || restStart.type !== 'rest_start'
    || breakEnd.ts !== restStart.ts
    || breakEnd.extras?.autoReason !== AUTO_REST_REASON_BREAK_THRESHOLD
    || restStart.extras?.autoReason !== AUTO_REST_REASON_BREAK_THRESHOLD
    || breakEnd.extras?.generatedFrom !== breakStartId
    || restStart.extras?.generatedFrom !== breakStartId
  ) {
    return { restStart: null, partial: true };
  }
  return { restStart: restStart as RestStartEvent, partial: false };
}

export async function confirmBreakToRest(params: {
  tripId: string;
  breakStartId: string;
  odoKm: number;
  evaluatedAt?: string;
}): Promise<{ transitioned: boolean; event: RestStartEvent }> {
  if (!Number.isFinite(params.odoKm) || params.odoKm < 0) {
    throw new Error('休息開始メーターが不正です');
  }
  const evaluatedAt = resolveOccurredAt(params.evaluatedAt);
  let transitioned = false;
  let event: RestStartEvent | undefined;
  await db.transaction('rw', db.events, db.meta, db.routePoints, async () => {
    const events = await getTripEventsCached(params.tripId);
    const existing = getPersistedBreakToRestTransition(events, params.tripId, params.breakStartId);
    if (existing.partial) throw new Error('休憩から休息への変換データが不完全です');
    if (existing.restStart) {
      event = existing.restStart;
      return;
    }

    assertTripOpen(events);
    const candidate = findDueBreakToRestCandidate(events, evaluatedAt);
    if (!candidate || candidate.breakStartId !== params.breakStartId) {
      throw new Error('対象の休憩は休息へ変更できません');
    }
    const key = breakToRestConfirmationKey(params.tripId, params.breakStartId);
    const stored = parseStoredBreakToRestConfirmation(
      (await db.meta.get(key))?.value ?? null,
      candidate,
    );
    if (stored?.status !== 'approved') {
      throw new Error('休息への変更が承認されていません');
    }

    if (params.odoKm > 0) {
      const lastOdo = findLatestOdoCheckpoint(events);
      if (lastOdo != null && params.odoKm < lastOdo) {
        throw new Error('休息開始メーターが前回メーターより小さいため保存できません');
      }
    }

    const transition = attachBreakToRestOdometer(candidate.transition, params.odoKm);
    event = await putBreakToRestTransitionTx(transition);
    await db.meta.delete(key);
    transitioned = true;
  });
  if (!event) throw new Error('休憩から休息への変更を保存できませんでした');
  if (transitioned) notifyRemoteMutation('event-break-confirmed-rest');
  return { transitioned, event };
}

/** @deprecated Use the confirmation APIs; this never converts events. */
export async function reconcileBreakToRestThreshold(params: {
  tripId: string;
  evaluatedAt?: string;
}): Promise<boolean> {
  await getBreakToRestConfirmationState(params);
  return false;
}

export async function endBreak(params: {
  tripId: string;
  geo?: Geo;
  address?: string;
  occurredAt?: string;
}) {
  const occurredAt = resolveOccurredAt(params.occurredAt);
  let event: AppEvent | undefined;
  await db.transaction('rw', db.events, db.meta, db.routePoints, async () => {
    const events = await getTripEventsCached(params.tripId);
    assertTripOpen(events);
    await assertDueBreakCanCloseTx(events, params.tripId, occurredAt);
    const openStart = findOpenToggleStart(events, BASIC_TOGGLE_GROUPS[1]);
    const open = requireOpenToggle(events, BASIC_TOGGLE_GROUPS[1]);
    event = baseEvent({
      tripId: params.tripId,
      type: 'break_end',
      geo: params.geo,
      address: params.address,
      occurredAt,
      extras: open === LEGACY_TOGGLE_SESSION_ID ? undefined : { breakSessionId: open },
    });
    await putEventWithRoutePointTx(event);
    if (openStart?.id) {
      await db.meta.delete(breakToRestConfirmationKey(params.tripId, openStart.id));
    }
  });
  if (!event) throw new Error('休憩終了イベントを保存できませんでした');
  notifyRemoteMutation('event-break_end');
  return { autoRestStarted: false };
}

// Refuel (給油)
export async function addRefuel(params: {
  tripId: string;
  liters: number;
  geo?: Geo;
  address?: string;
  occurredAt?: string;
}) {
  if (!Number.isFinite(params.liters) || params.liters <= 0) {
    throw new Error('給油量が不正です');
  }
  const e = baseEvent({
    tripId: params.tripId,
    type: 'refuel',
    geo: params.geo,
    address: params.address,
    occurredAt: params.occurredAt,
    extras: { liters: params.liters },
  });
  await addEvent(e);
}

// Ferry boarding / disembark (フェリー乗船 / 下船)
export async function addBoarding(
  params: { tripId: string; geo?: Geo; address?: string; occurredAt?: string },
): Promise<{ ferrySessionId: string; autoRestStarted: boolean }> {
  const occurredAt = resolveOccurredAt(params.occurredAt);
  const ferrySessionId = uuid();
  const boardingEventId = uuid();
  const generatedRestSessionId = uuid();
  let autoRestStarted = false;

  await db.transaction('rw', db.events, db.routePoints, async () => {
    const events = await getTripEventsCached(params.tripId);
    assertTripOpen(events);

    const openBreak = findOpenToggleSessionId(events, BASIC_TOGGLE_GROUPS[1]);
    const openLoad = findOpenToggleSessionId(events, BASIC_TOGGLE_GROUPS[2]);
    const openUnload = findOpenToggleSessionId(events, BASIC_TOGGLE_GROUPS[3]);
    if (openBreak || openLoad || openUnload) {
      throw new Error('進行中の休憩・積込・荷卸を終了してからフェリー乗船を記録してください');
    }

    const openFerry = findOpenToggleSessionId(events, BASIC_TOGGLE_GROUPS[4]);
    if (openFerry) throw new Error('フェリー乗船が開始済みです（下船を押してください）');
    const openRest = findOpenToggleSessionId(events, BASIC_TOGGLE_GROUPS[0]);
    autoRestStarted = !openRest;

    if (autoRestStarted) {
      await putEventWithRoutePointTx({
        id: uuid(),
        tripId: params.tripId,
        type: 'rest_start',
        ts: occurredAt,
        geo: params.geo,
        address: params.address,
        syncStatus: 'pending',
        extras: {
          restSessionId: generatedRestSessionId,
          autoReason: AUTO_REST_REASON_FERRY_BOARDING,
          generatedFrom: boardingEventId,
          reportMinDurationMinutes: REPORT_MIN_DURATION_MINUTES,
        },
      } as RestStartEvent);
    }

    await putEventWithRoutePointTx({
      id: boardingEventId,
      tripId: params.tripId,
      type: 'boarding',
      ts: occurredAt,
      geo: params.geo,
      address: params.address,
      syncStatus: 'pending',
      extras: {
        ferrySessionId,
        reportMinDurationMinutes: REPORT_MIN_DURATION_MINUTES,
        ...(autoRestStarted ? { autoRestSessionId: generatedRestSessionId } : {}),
      },
    });
  });
  notifyRemoteMutation('ferry-boarding');
  return { ferrySessionId, autoRestStarted };
}

export async function addDisembark(params: {
  tripId: string;
  geo?: Geo;
  address?: string;
  occurredAt?: string;
}) {
  const occurredAt = resolveOccurredAt(params.occurredAt);
  let event: AppEvent | undefined;
  await db.transaction('rw', db.events, db.routePoints, async () => {
    const events = await getTripEventsCached(params.tripId);
    assertTripOpen(events);
    const boarding = findOpenToggleStart(events, BASIC_TOGGLE_GROUPS[4]);
    const openFerrySessionId = requireOpenToggle(events, BASIC_TOGGLE_GROUPS[4]);
    const autoRestSessionId = typeof boarding?.extras?.autoRestSessionId === 'string'
      ? boarding.extras.autoRestSessionId.trim()
      : '';

    event = baseEvent({
      tripId: params.tripId,
      type: 'disembark',
      geo: params.geo,
      address: params.address,
      occurredAt,
      extras:
        openFerrySessionId === LEGACY_TOGGLE_SESSION_ID
          ? undefined
          : { ferrySessionId: openFerrySessionId },
    });
    await putEventWithRoutePointTx(event);

    if (
      autoRestSessionId
      && findOpenToggleSessionId(events, BASIC_TOGGLE_GROUPS[0]) === autoRestSessionId
    ) {
      await putEventWithRoutePointTx({
        id: uuid(),
        tripId: params.tripId,
        type: 'rest_end',
        ts: occurredAt,
        geo: params.geo,
        address: params.address,
        syncStatus: 'pending',
        extras: {
          restSessionId: autoRestSessionId,
          dayClose: false,
          autoReason: 'ferry_disembark',
          generatedFrom: event.id,
        },
      } as RestEndEvent);
    }
  });
  if (!event) throw new Error('フェリー下船イベントを保存できませんでした');
  notifyRemoteMutation('event-disembark');
}

// Point mark (地点マーク)
export async function addPointMark(params: {
  tripId: string;
  geo?: Geo;
  address?: string;
  label?: string;
  occurredAt?: string;
}) {
  const e = baseEvent({
    tripId: params.tripId,
    type: 'point_mark',
    geo: params.geo,
    address: params.address,
    occurredAt: params.occurredAt,
    extras: params.label ? { label: params.label } : undefined,
  });
  await addEvent(e);
}

// Expressway (高速道路)
export const STALE_NATIVE_EXPRESSWAY_DETECTION_ERROR = 'STALE_NATIVE_EXPRESSWAY_DETECTION';

function eventNativeDetectionId(event: AppEvent): string | undefined {
  const autoDecision = (event.extras as Record<string, unknown> | undefined)?.autoDecision;
  if (!autoDecision || typeof autoDecision !== 'object') return undefined;
  return normalizeNativeDetectionId((autoDecision as Record<string, unknown>).nativeDetectionId);
}

function latestExpresswayEventTs(events: readonly AppEvent[]): string | null {
  let latest: string | null = null;
  for (const event of events) {
    if (!EXPRESSWAY_EVENT_TYPES.includes(event.type as (typeof EXPRESSWAY_EVENT_TYPES)[number])) continue;
    if (!latest || event.ts > latest) latest = event.ts;
  }
  return latest;
}

function latestNativeExpresswayGeneration(events: readonly AppEvent[]): number | null {
  let latest: number | null = null;
  for (const event of events) {
    if (!EXPRESSWAY_EVENT_TYPES.includes(event.type as (typeof EXPRESSWAY_EVENT_TYPES)[number])) continue;
    const autoDecision = (event.extras as Record<string, unknown> | undefined)?.autoDecision;
    if (!autoDecision || typeof autoDecision !== 'object') continue;
    const generation = Number((autoDecision as Record<string, unknown>).nativeGeneration);
    if (Number.isSafeInteger(generation) && generation >= 1 && (latest == null || generation > latest)) {
      latest = generation;
    }
  }
  return latest;
}

function latestUnversionedExpresswayEventTs(events: readonly AppEvent[]): string | null {
  let latest: string | null = null;
  for (const event of events) {
    if (!EXPRESSWAY_EVENT_TYPES.includes(event.type as (typeof EXPRESSWAY_EVENT_TYPES)[number])) continue;
    const autoDecision = (event.extras as Record<string, unknown> | undefined)?.autoDecision;
    const generation = autoDecision && typeof autoDecision === 'object'
      ? Number((autoDecision as Record<string, unknown>).nativeGeneration)
      : Number.NaN;
    if (Number.isSafeInteger(generation) && generation >= 1) continue;
    if (!latest || event.ts > latest) latest = event.ts;
  }
  return latest;
}

export async function startExpressway(params: {
  tripId: string;
  geo?: Geo;
  address?: string;
  occurredAt?: string;
  autoDecision?: AutoExpresswayDecisionReason;
}) {
  let expresswaySessionId = uuid();
  let eventId = '';
  let created = false;
  const autoDecision = normalizeAutoExpresswayDecisionReason(params.autoDecision);
  const occurredAt = resolveOccurredAt(params.occurredAt);
  const e = baseEvent({
    tripId: params.tripId,
    type: 'expressway_start',
    geo: params.geo,
    address: params.address,
    occurredAt: params.occurredAt,
    extras: {
      expresswaySessionId,
      icResolveStatus: 'pending',
      icResolveRetryCount: 0,
      ...(autoDecision ? { autoDecision } : {}),
    },
  });
  await db.transaction('rw', db.events, db.meta, db.routePoints, async () => {
    const events = await db.events.where('tripId').equals(params.tripId).toArray();
    events.sort((a, b) => a.ts.localeCompare(b.ts));
    if (autoDecision?.nativeDetectionId) {
      const existing = events.find(event => (
        eventNativeDetectionId(event) === autoDecision.nativeDetectionId
      ));
      if (existing) {
        if (existing.type === 'expressway_start') {
          eventId = existing.id;
          expresswaySessionId = typeof existing.extras?.expresswaySessionId === 'string'
            ? existing.extras.expresswaySessionId
            : LEGACY_TOGGLE_SESSION_ID;
          return;
        }
        throw new Error(STALE_NATIVE_EXPRESSWAY_DETECTION_ERROR);
      }
      const latestGeneration = latestNativeExpresswayGeneration(events);
      const latestTs = latestExpresswayEventTs(events);
      const latestUnversionedTs = latestUnversionedExpresswayEventTs(events);
      if (
        (autoDecision.nativeGeneration != null
          && latestGeneration != null
          && autoDecision.nativeGeneration <= latestGeneration)
        || (autoDecision.nativeGeneration != null
          && latestUnversionedTs
          && autoDecision.evaluatedAt <= latestUnversionedTs)
        || (autoDecision.nativeGeneration == null && latestTs && e.ts <= latestTs)
      ) {
        throw new Error(STALE_NATIVE_EXPRESSWAY_DETECTION_ERROR);
      }
    }
    assertTripOpen(events);
    const open = findOpenToggleSessionId(events, EXPRESSWAY_TOGGLE_DEFINITION);
    if (open) throw new Error('高速道路が開始済みです（終了を押してください）');
    await putEventWithRoutePointTx(e);
    await clearPendingExpresswayEndPrompt(params.tripId);
    await clearPendingExpresswayEndDecision(params.tripId);
    eventId = e.id;
    created = true;
  });
  if (created) notifyRemoteMutation('expressway-start');
  return { expresswaySessionId, eventId, created };
}

export async function endExpressway(params: {
  tripId: string;
  geo?: Geo;
  address?: string;
  occurredAt?: string;
  autoDecision?: AutoExpresswayDecisionReason;
}) {
  let eventId = '';
  let created = false;
  const autoDecision = normalizeAutoExpresswayDecisionReason(params.autoDecision);
  const occurredAt = resolveOccurredAt(params.occurredAt);
  await db.transaction('rw', db.events, db.meta, db.routePoints, async () => {
    const events = await db.events.where('tripId').equals(params.tripId).toArray();
    events.sort((a, b) => a.ts.localeCompare(b.ts));
    if (autoDecision?.nativeDetectionId) {
      const existing = events.find(event => (
        eventNativeDetectionId(event) === autoDecision.nativeDetectionId
      ));
      if (existing) {
        if (existing.type === 'expressway_end') {
          eventId = existing.id;
          return;
        }
        throw new Error(STALE_NATIVE_EXPRESSWAY_DETECTION_ERROR);
      }
      const latestGeneration = latestNativeExpresswayGeneration(events);
      const latestTs = latestExpresswayEventTs(events);
      const latestUnversionedTs = latestUnversionedExpresswayEventTs(events);
      if (
        (autoDecision.nativeGeneration != null
          && latestGeneration != null
          && autoDecision.nativeGeneration <= latestGeneration)
        || (autoDecision.nativeGeneration != null
          && latestUnversionedTs
          && autoDecision.evaluatedAt <= latestUnversionedTs)
        || (autoDecision.nativeGeneration == null && latestTs && occurredAt <= latestTs)
      ) {
        throw new Error(STALE_NATIVE_EXPRESSWAY_DETECTION_ERROR);
      }
    }
    assertTripOpen(events);
    const open = findOpenToggleSessionId(events, EXPRESSWAY_TOGGLE_DEFINITION);
    if (!open) throw new Error('高速道路が開始されていません');
    const e = baseEvent({
      tripId: params.tripId,
      type: 'expressway_end',
      geo: params.geo,
      address: params.address,
      occurredAt,
      extras:
        open === LEGACY_TOGGLE_SESSION_ID
          ? {
              icResolveStatus: 'pending',
              icResolveRetryCount: 0,
              ...(autoDecision ? { autoDecision } : {}),
            }
          : {
              expresswaySessionId: open,
              icResolveStatus: 'pending',
              icResolveRetryCount: 0,
              ...(autoDecision ? { autoDecision } : {}),
            },
    });
    await putEventWithRoutePointTx(e);
    await clearPendingExpresswayEndPrompt(params.tripId);
    await clearPendingExpresswayEndDecision(params.tripId);
    eventId = e.id;
    created = true;
  });
  if (created) notifyRemoteMutation('expressway-end');
  return { eventId, created };
}

export async function getPendingExpresswayEvents(
  tripId?: string,
  options?: { ignorePendingBackoff?: boolean },
) {
  const arr = tripId
    ? await db.events.where('[tripId+type]').anyOf(EXPRESSWAY_EVENT_TYPES.map(t => [tripId, t])).toArray()
    : await db.events.where('type').anyOf([...EXPRESSWAY_EVENT_TYPES]).toArray();
  const nowMs = Date.now();
  return arr
    .filter(e => canRetryIcResolve(e, nowMs, options?.ignorePendingBackoff === true))
    .sort((a, b) => {
      const aStale = isStaleIcResolveAlgorithm(a);
      const bStale = isStaleIcResolveAlgorithm(b);
      if (aStale !== bStale) return aStale ? -1 : 1;
      return aStale ? a.ts.localeCompare(b.ts) : b.ts.localeCompare(a.ts);
    });
}

let expresswayIcBackfillInFlight: Promise<boolean> | null = null;

export async function backfillPendingExpresswayIcs(limit = 8): Promise<boolean> {
  if (expresswayIcBackfillInFlight) return expresswayIcBackfillInFlight;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return false;

  expresswayIcBackfillInFlight = (async () => {
    const candidates = (await getPendingExpresswayEvents()).slice(0, Math.max(1, limit));
    let updatedAny = false;

    for (const ev of candidates) {
      const guard = { expectedVersion: captureIcResolutionEventVersion(ev) };
      const geo = (ev as any).geo as Geo | undefined;
      if (!geo) {
        const failure = await markExpresswayResolveFailure({
          eventId: ev.id,
          errorMessage: '位置情報が未保存のためIC解決不可',
          nextRetryAt: null,
          guard,
        });
        updatedAny = failure.applied || updatedAny;
        continue;
      }

      try {
        const result = await resolveNearestIC(geo.lat, geo.lng);
        if (result) {
          const applied = await updateExpresswayResolved({
            eventId: ev.id,
            status: 'resolved',
            icName: result.icName,
            icDistanceM: result.distanceM,
            guard,
          });
          updatedAny = applied || updatedAny;
        } else {
          const failure = await markExpresswayResolveFailure({
            eventId: ev.id,
            errorMessage: '近傍ICを取得できませんでした',
            guard,
          });
          updatedAny = failure.applied || updatedAny;
        }
      } catch (error: any) {
        const failure = await markExpresswayResolveFailure({
          eventId: ev.id,
          errorMessage: error?.message ?? 'IC解決に失敗しました',
          guard,
        });
        updatedAny = failure.applied || updatedAny;
      }
    }

    return updatedAny;
  })();

  try {
    return await expresswayIcBackfillInFlight;
  } finally {
    expresswayIcBackfillInFlight = null;
  }
}

export type ExpresswayIcResolutionWriteGuard = {
  expectedVersion: IcResolutionEventVersion;
  /** Explicit user-requested network refresh may replace the unchanged manual value it started from. */
  allowExistingManual?: boolean;
};

export async function updateExpresswayResolved(params: {
  eventId: string;
  status: 'resolved' | 'failed' | 'pending';
  icName?: string;
  icDistanceM?: number;
  nextRetryAt?: string | null;
  errorMessage?: string;
  retryCount?: number;
  clearManualResolution?: boolean;
  guard?: ExpresswayIcResolutionWriteGuard;
}) {
  let applied = false;
  await db.transaction('rw', db.events, async () => {
    const ev = await db.events.get(params.eventId);
    if (!ev) return;
    if (
      params.guard
      && !canApplyIcResolutionResult(
        params.guard.expectedVersion,
        ev,
        {
          // A user-requested refresh may replace an unchanged manual value
          // only with a successful resolution. Pending/failed states never
          // downgrade the driver's confirmed IC name.
          allowExistingManual:
            params.status === 'resolved' && params.guard.allowExistingManual === true,
        },
      )
    ) {
      return;
    }
    const extras = { ...(ev as any).extras };
    extras.icResolveStatus = params.status;
    extras.icResolveAlgorithmVersion = IC_RESOLVE_ALGORITHM_VERSION;
    if (params.status === 'resolved') {
      if (params.icName) extras.icName = params.icName;
      if (params.icDistanceM != null) extras.icDistanceM = params.icDistanceM;
      extras.icResolveRetryCount = 0;
      delete extras.icResolveNextRetryAt;
      delete extras.icResolveLastAttemptAt;
      delete extras.icResolveError;
      if (params.clearManualResolution) {
        delete extras.icResolvedManually;
        delete extras.icResolveManualUpdatedAt;
      }
    }
    if (params.status === 'pending') {
      if (Number.isFinite(params.retryCount)) {
        extras.icResolveRetryCount = Math.max(0, Math.floor(params.retryCount ?? 0));
      } else if (extras.icResolveRetryCount == null) {
        extras.icResolveRetryCount = 0;
      }
      extras.icResolveLastAttemptAt = new Date().toISOString();
      if (params.nextRetryAt) {
        extras.icResolveNextRetryAt = params.nextRetryAt;
      } else {
        delete extras.icResolveNextRetryAt;
      }
      const message = params.errorMessage?.trim();
      if (message) {
        extras.icResolveError = message.slice(0, 180);
      } else {
        delete extras.icResolveError;
      }
    }
    await db.events.update(params.eventId, { extras, syncStatus: 'pending' });
    applied = true;
  });
  if (applied) {
    notifyRemoteMutation('expressway-resolved');
    notifyTrackLogEventsChanged();
  }
  return applied;
}

export async function markExpresswayResolveFailure(params: {
  eventId: string;
  errorMessage?: string;
  nextRetryAt?: string | null;
  guard?: ExpresswayIcResolutionWriteGuard;
}) {
  let result = {
    retryCount: 0,
    exhausted: true,
    nextRetryAt: null as string | null,
    applied: false,
  };
  await db.transaction('rw', db.events, async () => {
    const ev = await db.events.get(params.eventId);
    if (!ev) return;
    if (
      params.guard
      && !canApplyIcResolutionResult(
        params.guard.expectedVersion,
        ev,
        { allowExistingManual: false },
      )
    ) {
      return;
    }
    const previousAlgorithmVersion = getIcResolveAlgorithmVersion(ev);
    const previousResolveStatus = (ev as any).extras?.icResolveStatus;
    const previousRetryCount =
      previousAlgorithmVersion < IC_RESOLVE_ALGORITHM_VERSION || previousResolveStatus !== 'failed'
        ? 0
        : getIcResolveRetryCount(ev);
    const retryCount = previousRetryCount + 1;
    const exhausted = retryCount >= IC_RESOLVE_RETRY_LIMIT;
    const nowMs = Date.now();
    const hasExplicitNextRetryAt = Object.prototype.hasOwnProperty.call(params, 'nextRetryAt');
    const nextRetryAt =
      exhausted
        ? null
        : hasExplicitNextRetryAt
          ? params.nextRetryAt ?? null
          : new Date(nowMs + computeIcResolveBackoffMs(retryCount)).toISOString();

    const extras = { ...(ev as any).extras };
    extras.icResolveStatus = 'failed';
    extras.icResolveAlgorithmVersion = IC_RESOLVE_ALGORITHM_VERSION;
    extras.icResolveRetryCount = retryCount;
    extras.icResolveLastAttemptAt = new Date(nowMs).toISOString();
    if (nextRetryAt) {
      extras.icResolveNextRetryAt = nextRetryAt;
    } else {
      delete extras.icResolveNextRetryAt;
    }
    const message = params.errorMessage?.trim();
    if (message) {
      extras.icResolveError = message.slice(0, 180);
    } else {
      delete extras.icResolveError;
    }
    await db.events.update(params.eventId, { extras, syncStatus: 'pending' });
    result = { retryCount, exhausted, nextRetryAt, applied: true };
  });
  if (result.applied) {
    notifyRemoteMutation('expressway-resolve-failure');
    notifyTrackLogEventsChanged();
  }
  return result;
}

// Trip summary
export type TripSummary = {
  tripId: string;
  startTs: string;
  endTs?: string;
  odoStart: number;
  odoEnd?: number;
  totalKm?: number;
  lastLegKm?: number;
  status: 'active' | 'closed';
};

export async function listTrips(): Promise<TripSummary[]> {
  const starts = (await db.events.where('type').equals('trip_start').toArray()) as TripStartEvent[];
  const ends = (await db.events.where('type').equals('trip_end').toArray()) as TripEndEvent[];
  const startByTrip = new Map<string, TripStartEvent>();
  for (const s of starts) {
    const prev = startByTrip.get(s.tripId);
    if (!prev || s.ts < prev.ts) startByTrip.set(s.tripId, s);
  }
  const endByTrip = new Map<string, TripEndEvent>();
  for (const e of ends) {
    const prev = endByTrip.get(e.tripId);
    if (!prev || e.ts > prev.ts) endByTrip.set(e.tripId, e);
  }
  const summaries: TripSummary[] = Array.from(startByTrip.values()).map(s => {
    const end = endByTrip.get(s.tripId);
    return {
      tripId: s.tripId,
      startTs: s.ts,
      endTs: end?.ts,
      odoStart: s.extras.odoKm,
      odoEnd: end?.extras.odoKm,
      totalKm: end?.extras.totalKm,
      lastLegKm: end?.extras.lastLegKm,
      status: end ? 'closed' : 'active',
    };
  });
  summaries.sort((a, b) => b.startTs.localeCompare(a.startTs));
  return summaries;
}

/**
 * Backfill addresses for events that already have geo but no address (e.g. recordedオフライン).
 * Limits requests to avoid spamming the API.
 * Returns true if any address was updated.
 */
export async function backfillMissingAddresses(limit = 30, batches = 2): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.onLine) return false;

  let updatedAny = false;
  for (let i = 0; i < batches; i++) {
    const candidates = await db.events
      .filter(e => !e.address && !!(e as any).geo)
      .limit(limit)
      .toArray();
    if (candidates.length === 0) break;

    let updatedBatch = false;
    for (const ev of candidates) {
      const geo = (ev as any).geo as Geo;
      try {
        const addr = await reverseGeocode(geo);
        if (addr) {
          await updateEventAddress(ev.id, addr);
          updatedAny = true;
          updatedBatch = true;
        }
      } catch {
        // ignore failures; will retry later
      }
    }
    if (!updatedBatch) break; // avoid tight loops when nothing could be resolved
  }
  return updatedAny;
}

export async function deleteTrip(tripId: string): Promise<void> {
  await db.transaction('rw', db.events, db.meta, db.routePoints, db.reportTrips, async () => {
    await db.events.where('tripId').equals(tripId).delete();
    await db.routePoints.where('tripId').equals(tripId).delete();
    await db.reportTrips.delete(tripId);
    await clearBreakToRestConfirmationsForTripTx(tripId);
    await clearPendingExpresswayEndPrompt(tripId);
    await clearPendingExpresswayEndDecision(tripId);
    const active = await db.meta.get(META_ACTIVE_TRIP_ID);
    if (active?.value === tripId) {
      await db.meta.delete(META_ACTIVE_TRIP_ID);
    }
  });
  notifyRemoteMutation('trip-delete');
}

type RestoreSnapshotPayload = {
  events?: unknown[];
  routePoints?: unknown[];
  recordType?: string;
  tripId?: string;
  summary?: unknown;
  segments?: unknown[];
  timeline?: unknown[];
  cutoff?: unknown;
};

export type RestoreSnapshotResult = {
  importedEvents: number;
  importedRoutePoints: number;
  restoredTripIds: string[];
  activeTripId: string | null;
};

const RESTORE_EVENT_TYPES: Set<EventType> = new Set([
  'trip_start',
  'trip_end',
  'rest_start',
  'rest_end',
  'break_start',
  'break_end',
  'load_start',
  'load_end',
  'unload_start',
  'unload_end',
  'refuel',
  'boarding',
  'disembark',
  'expressway',
  'expressway_start',
  'expressway_end',
  'point_mark',
]);

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}

function normalizeRestoreGeo(raw: unknown): Geo | undefined {
  if (!isRecord(raw)) return undefined;
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  const accuracy = Number(raw.accuracy);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return {
    lat,
    lng,
    ...(Number.isFinite(accuracy) ? { accuracy } : {}),
  };
}

function normalizeRestoreEvent(raw: unknown): AppEvent | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const tripId = typeof raw.tripId === 'string' ? raw.tripId.trim() : '';
  const typeRaw = typeof raw.type === 'string' ? raw.type.trim() : '';
  const ts = typeof raw.ts === 'string' ? raw.ts.trim() : '';
  if (!id || !tripId || !ts || !Number.isFinite(Date.parse(ts))) return null;
  if (!RESTORE_EVENT_TYPES.has(typeRaw as EventType)) return null;
  const syncStatus =
    raw.syncStatus === 'synced' || raw.syncStatus === 'error' ? raw.syncStatus : 'pending';
  const geo = normalizeRestoreGeo(raw.geo);
  const extras = isRecord(raw.extras) ? { ...raw.extras } : undefined;
  const address = typeof raw.address === 'string' && raw.address.trim() ? raw.address.trim() : undefined;
  return {
    id,
    tripId,
    type: typeRaw as EventType,
    ts,
    syncStatus,
    ...(geo ? { geo } : {}),
    ...(address ? { address } : {}),
    ...(extras ? { extras } : {}),
  };
}

function normalizeRestoreRoutePoint(raw: unknown): RoutePoint | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const tripId = typeof raw.tripId === 'string' ? raw.tripId.trim() : '';
  const ts = typeof raw.ts === 'string' ? raw.ts.trim() : '';
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!id || !tripId || !ts || !Number.isFinite(Date.parse(ts)) || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  const accuracy = Number(raw.accuracy);
  const speed = Number(raw.speed);
  const heading = Number(raw.heading);
  const source =
    raw.source === 'foreground' || raw.source === 'background' || raw.source === 'event'
      ? raw.source
      : undefined;
  return {
    id,
    tripId,
    ts,
    lat,
    lng,
    ...(Number.isFinite(accuracy) ? { accuracy } : {}),
    ...(Number.isFinite(speed) ? { speed } : {}),
    ...(Number.isFinite(heading) ? { heading } : {}),
    ...(source ? { source } : {}),
  };
}

type OperationLogTimelineItem = {
  ts: string;
  title: string;
  detail?: string;
};

type OperationLogSegment = {
  index: number;
  toTs?: string;
  toOdo?: number;
  restSessionIdTo?: string;
};

type OperationLogSummary = {
  startTs: string;
  startAddress?: string;
  odoStart?: number;
};

function parseOperationLogSummary(raw: unknown): OperationLogSummary | null {
  if (!isRecord(raw)) return null;
  const startTs = typeof raw.startTs === 'string' ? raw.startTs.trim() : '';
  if (!startTs || !Number.isFinite(Date.parse(startTs))) return null;
  const odoStart = Number(raw.odoStart);
  return {
    startTs,
    ...(typeof raw.startAddress === 'string' && raw.startAddress.trim()
      ? { startAddress: raw.startAddress.trim() }
      : {}),
    ...(Number.isFinite(odoStart) ? { odoStart } : {}),
  };
}

function parseOperationLogSegments(raw: unknown): OperationLogSegment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(item => {
      if (!isRecord(item)) return null;
      const index = Number(item.index);
      const toTs = typeof item.toTs === 'string' && Number.isFinite(Date.parse(item.toTs)) ? item.toTs : undefined;
      const toOdo = Number(item.toOdo);
      const restSessionIdTo =
        typeof item.restSessionIdTo === 'string' && item.restSessionIdTo.trim()
          ? item.restSessionIdTo.trim()
          : undefined;
      if (!Number.isFinite(index)) return null;
      return {
        index: Math.max(1, Math.round(index)),
        ...(toTs ? { toTs } : {}),
        ...(Number.isFinite(toOdo) ? { toOdo } : {}),
        ...(restSessionIdTo ? { restSessionIdTo } : {}),
      } satisfies OperationLogSegment;
    })
    .filter((item): item is OperationLogSegment => item !== null)
    .sort((a, b) => a.index - b.index);
}

function parseOperationLogTimeline(raw: unknown): OperationLogTimelineItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(item => {
      if (!isRecord(item)) return null;
      const ts = typeof item.ts === 'string' ? item.ts.trim() : '';
      const title = typeof item.title === 'string' ? item.title.trim() : '';
      const detail = typeof item.detail === 'string' ? item.detail.trim() : undefined;
      if (!ts || !title || !Number.isFinite(Date.parse(ts))) return null;
      return { ts, title, ...(detail ? { detail } : {}) };
    })
    .filter((item): item is OperationLogTimelineItem => item !== null)
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

function makeRecoveryEventId(prefix: string, sourceTs: string, suffix = ''): string {
  const stamp = sourceTs.replace(/[-:.TZ]/g, '');
  const tail = suffix ? `-${suffix}` : '';
  return `recovery-${prefix}-${stamp}${tail}`;
}

function parseDetailDurationMinutes(detail?: string): number | null {
  if (!detail) return null;
  const m = detail.match(/（(?:(\d+)時間)?(\d+)分）/);
  if (!m) return null;
  const hours = Number(m[1] ?? 0);
  const minutes = Number(m[2] ?? 0);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function deriveEndTsFromDetail(startTs: string, detail?: string): string | null {
  const minutes = parseDetailDurationMinutes(detail);
  if (minutes == null) return null;
  return new Date(new Date(startTs).getTime() + minutes * 60000).toISOString();
}

function extractAddressFromDetail(detail?: string): string | undefined {
  if (!detail) return undefined;
  const parts = detail.split(' / ').map(part => part.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  const last = parts[parts.length - 1];
  return last || undefined;
}

function extractRefuelLiters(detail?: string): number | undefined {
  if (!detail) return undefined;
  const m = detail.match(/(\d+(?:\.\d+)?)\s*L/i);
  if (!m) return undefined;
  const liters = Number(m[1]);
  return Number.isFinite(liters) ? liters : undefined;
}

function buildOperationLogEvents(payload: RestoreSnapshotPayload): AppEvent[] {
  const tripId = typeof payload.tripId === 'string' ? payload.tripId.trim() : '';
  const summary = parseOperationLogSummary(payload.summary);
  const timeline = parseOperationLogTimeline(payload.timeline);
  const segments = parseOperationLogSegments(payload.segments);
  if (!tripId || !summary || timeline.length === 0) {
    return [];
  }

  const events: AppEvent[] = [
    {
      id: makeRecoveryEventId('trip-start', summary.startTs),
      tripId,
      type: 'trip_start',
      ts: summary.startTs,
      syncStatus: 'pending',
      ...(summary.startAddress ? { address: summary.startAddress } : {}),
      extras: {
        odoKm: Number.isFinite(summary.odoStart) ? summary.odoStart : 0,
      },
    } as TripStartEvent,
  ];

  let restIndex = 0;
  let pairIndex = 0;
  for (const item of timeline) {
    if (item.title === '運行開始') continue;
    const address = extractAddressFromDetail(item.detail);
    const title = item.title.trim();
    if (item.title === '休息') {
      const segment = segments[restIndex];
      const restSessionId = segment?.restSessionIdTo ?? makeRecoveryEventId('rest-session', item.ts);
      const restStart: AppEvent = {
        id: makeRecoveryEventId('rest-start', item.ts),
        tripId,
        type: 'rest_start',
        ts: item.ts,
        syncStatus: 'pending',
        ...(address ? { address } : {}),
        extras: {
          restSessionId,
          odoKm: Number.isFinite(segment?.toOdo) ? segment!.toOdo! : 0,
        },
      } as RestStartEvent;
      events.push(restStart);

      if (!item.detail?.includes('進行中')) {
        const endTs = deriveEndTsFromDetail(item.ts, item.detail);
        if (endTs) {
          events.push({
            id: makeRecoveryEventId('rest-end', endTs),
            tripId,
            type: 'rest_end',
            ts: endTs,
            syncStatus: 'pending',
            ...(address ? { address } : {}),
            extras: {
              restSessionId,
              dayClose: false,
            },
          } as RestEndEvent);
        }
      }
      restIndex += 1;
      continue;
    }

    const endTs = deriveEndTsFromDetail(item.ts, item.detail);
    const sessionId = makeRecoveryEventId('session', item.ts, String(pairIndex + 1));
    pairIndex += 1;
    switch (title) {
      case '積込':
      case '積込み':
        events.push({
          id: makeRecoveryEventId('load-start', item.ts),
          tripId,
          type: 'load_start',
          ts: item.ts,
          syncStatus: 'pending',
          ...(address ? { address } : {}),
          extras: { loadSessionId: sessionId },
        });
        if (endTs) {
          events.push({
            id: makeRecoveryEventId('load-end', endTs),
            tripId,
            type: 'load_end',
            ts: endTs,
            syncStatus: 'pending',
            ...(address ? { address } : {}),
            extras: { loadSessionId: sessionId },
          });
        }
        break;
      case '荷卸':
      case '積下ろし':
      case '積み下ろし':
      case '積み卸し':
        events.push({
          id: makeRecoveryEventId('unload-start', item.ts),
          tripId,
          type: 'unload_start',
          ts: item.ts,
          syncStatus: 'pending',
          ...(address ? { address } : {}),
          extras: { unloadSessionId: sessionId },
        });
        if (endTs) {
          events.push({
            id: makeRecoveryEventId('unload-end', endTs),
            tripId,
            type: 'unload_end',
            ts: endTs,
            syncStatus: 'pending',
            ...(address ? { address } : {}),
            extras: { unloadSessionId: sessionId },
          });
        }
        break;
      case '休憩':
        events.push({
          id: makeRecoveryEventId('break-start', item.ts),
          tripId,
          type: 'break_start',
          ts: item.ts,
          syncStatus: 'pending',
          ...(address ? { address } : {}),
          extras: { breakSessionId: sessionId },
        });
        if (endTs) {
          events.push({
            id: makeRecoveryEventId('break-end', endTs),
            tripId,
            type: 'break_end',
            ts: endTs,
            syncStatus: 'pending',
            ...(address ? { address } : {}),
            extras: { breakSessionId: sessionId },
          });
        }
        break;
      case '給油': {
        const liters = extractRefuelLiters(item.detail);
        events.push({
          id: makeRecoveryEventId('refuel', item.ts),
          tripId,
          type: 'refuel',
          ts: item.ts,
          syncStatus: 'pending',
          ...(address ? { address } : {}),
          extras: {
            ...(Number.isFinite(liters) ? { liters } : {}),
          },
        });
        break;
      }
      case 'フェリー':
      case '乗船':
      case 'フェリー乗船': {
        const ferrySessionId = makeRecoveryEventId('ferry-session', item.ts, String(pairIndex));
        events.push({
          id: makeRecoveryEventId('boarding', item.ts),
          tripId,
          type: 'boarding',
          ts: item.ts,
          syncStatus: 'pending',
          ...(address ? { address } : {}),
          extras: { ferrySessionId },
        });
        if (endTs) {
          events.push({
            id: makeRecoveryEventId('disembark', endTs),
            tripId,
            type: 'disembark',
            ts: endTs,
            syncStatus: 'pending',
            ...(address ? { address } : {}),
            extras: { ferrySessionId },
          });
        }
        break;
      }
      case '下船':
      case 'フェリー下船':
        events.push({
          id: makeRecoveryEventId('disembark', item.ts),
          tripId,
          type: 'disembark',
          ts: item.ts,
          syncStatus: 'pending',
          ...(address ? { address } : {}),
        });
        break;
      default:
        break;
    }
  }

  return events.sort((a, b) => a.ts.localeCompare(b.ts));
}

function findActiveTripIdFromEvents(events: AppEvent[]): string | null {
  const starts = events.filter(e => e.type === 'trip_start').sort((a, b) => b.ts.localeCompare(a.ts));
  for (const start of starts) {
    const ended = events.some(e => e.tripId === start.tripId && e.type === 'trip_end');
    if (!ended) return start.tripId;
  }
  return null;
}

export async function restoreSnapshotJson(jsonText: string): Promise<RestoreSnapshotResult> {
  const parsed = parseJsonInput<RestoreSnapshotPayload>(jsonText, 'JSON の解析に失敗しました');
  const events = Array.isArray(parsed.events)
    ? parsed.events.map(normalizeRestoreEvent).filter((event): event is AppEvent => event !== null)
    : parsed.recordType === 'operation_log'
      ? buildOperationLogEvents(parsed)
      : [];
  if (events.length === 0) {
    throw new Error('復元用 JSON に復元可能なイベントがありません');
  }
  const routePoints = Array.isArray(parsed.routePoints)
    ? parsed.routePoints
        .map(normalizeRestoreRoutePoint)
        .filter((point): point is RoutePoint => point !== null)
    : [];
  const restoredTripIds = [...new Set(events.map(event => event.tripId))];
  const activeTripId = findActiveTripIdFromEvents(events);

  await db.transaction('rw', db.events, db.meta, db.routePoints, async () => {
    await Promise.all(restoredTripIds.map(tripId => db.events.where('tripId').equals(tripId).delete()));
    await Promise.all(restoredTripIds.map(tripId => db.routePoints.where('tripId').equals(tripId).delete()));
    await db.events.bulkPut(events);
    if (routePoints.length > 0) {
      await db.routePoints.bulkPut(routePoints);
    }
    await clearPendingExpresswayEndPrompt();
    await clearPendingExpresswayEndDecision();
    await setMeta(META_ACTIVE_TRIP_ID, activeTripId);
  });
  notifyRemoteMutation('snapshot-restore');

  return {
    importedEvents: events.length,
    importedRoutePoints: routePoints.length,
    restoredTripIds,
    activeTripId,
  };
}

/**
 * Delete a single event. Trip startは運行の基点なので削除不可とする。
 * rest_end (dayClose) の並びが変わる場合は日次インデックスを再計算する。
 */
export async function deleteEvent(eventId: string): Promise<void> {
  const ev = await db.events.get(eventId);
  if (!ev) return;
  if (ev.type === 'trip_start') throw new Error('運行開始イベントは削除できません（運行ごと削除してください）');
  const deletedAt = nowIso();
  await db.transaction('rw', db.events, db.routePoints, db.deletedEventTombstones, async () => {
    await db.deletedEventTombstones.put({
      eventId: ev.id,
      tripId: ev.tripId,
      eventType: ev.type,
      eventTs: ev.ts,
      deletedAt,
      remoteRevision: ev.remoteRevision,
      remoteChangeSeq: ev.remoteChangeSeq,
      ownerUserId: ev.ownerUserId,
    });
    await db.events.delete(eventId);
    await db.routePoints.delete(getRoutePointAnchorId(eventId));
  });
  await rebalanceDayCloseIndices(ev.tripId);
  notifyRemoteMutation('event-delete');
}

/**
 * 手動で住所を上書きする。同期が必要な場合を想定し syncStatus を pending に戻す。
 */
export async function updateEventAddressManual(eventId: string, address: string) {
  if (!address.trim()) throw new Error('住所を入力してください');
  const ev = await db.events.get(eventId);
  if (!ev) throw new Error('イベントが見つかりません');
  await db.events.update(eventId, { address: address.trim(), syncStatus: 'pending' });
  notifyRemoteMutation('event-address-manual');
}

/**
 * 位置情報があるイベントに対して逆ジオコーディングを再実行する。
 * より詳細な住所を取得できた場合に上書きする。
 */
export async function refreshEventAddressFromGeo(eventId: string): Promise<string | undefined> {
  const ev = await db.events.get(eventId);
  if (!ev) throw new Error('イベントが見つかりません');
  const geo = (ev as any).geo as Geo | undefined;
  if (!geo) throw new Error('このイベントには位置情報が保存されていません');
  const addr = await reverseGeocode(geo);
  if (addr) {
    await db.events.update(eventId, { address: addr, syncStatus: 'pending' });
    notifyRemoteMutation('event-address-refresh');
  }
  return addr;
}

// ---- Helpers ----

async function rebalanceDayCloseIndices(tripId: string) {
  const events = await getEventsByTripId(tripId);
  const dayCloses = getAcceptedRestDayCloses(events);
  const sorted = [...dayCloses].sort((a, b) => a.ts.localeCompare(b.ts));
  await Promise.all(
    sorted.map((e, idx) => {
      const extras = { ...(e as any).extras, dayIndex: idx + 1 };
      return db.events.update(e.id, { extras });
    })
  );
}
