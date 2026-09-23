import type { BaseEvent } from '../domain/types';

export const IC_RESOLVE_RETRY_LIMIT = 6;
// Bump this when resolver behavior changes so previously exhausted failures retry.
export const IC_RESOLVE_ALGORITHM_VERSION = 13;

const IC_RESOLVE_BACKOFF_BASE_MS = 2 * 60 * 1000;
const IC_RESOLVE_BACKOFF_CAP_MS = 60 * 60 * 1000;
const IC_RESOLVE_TEMPORARY_BACKOFF_BASE_MS = 15 * 1000;
export const IC_RESOLVE_TEMPORARY_BACKOFF_CAP_MS = 60 * 60 * 1000;
const IC_RESOLVE_AUTH_BACKOFF_BASE_MS = 15 * 60 * 1000;
export const IC_RESOLVE_AUTH_BACKOFF_CAP_MS = 12 * 60 * 60 * 1000;
const IC_RESOLVE_PERSISTED_RETRY_COUNT_CAP = 32;

export type IcResolveDeferredCategory = 'authorization-recoverable' | 'temporary';

type IcResolveExtras = Record<string, unknown> | null | undefined;

export type IcResolutionEventVersionSource = Partial<Pick<BaseEvent,
  'tripId' | 'type' | 'ts' | 'geo' | 'localRevision' | 'syncMutationId' | 'extras'
>>;

export type IcResolutionEventVersion = {
  localRevision: number | null;
  syncMutationId: string | null;
  status: string | null;
  name: string | null;
  resolvedManually: boolean;
  manualUpdatedAt: string | null;
  inputSignature: string | null;
  resolutionSignature: string;
};

function normalizedVersionText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function captureIcResolutionEventVersion(
  event: IcResolutionEventVersionSource,
): IcResolutionEventVersion {
  const revision = event.localRevision;
  const decision = event.extras?.autoDecision;
  const autoDecision = decision && typeof decision === 'object'
    ? decision as Record<string, unknown>
    : undefined;
  return {
    localRevision: typeof revision === 'number' && Number.isFinite(revision)
      ? Math.max(0, Math.trunc(revision))
      : null,
    syncMutationId: normalizedVersionText(event.syncMutationId),
    status: normalizedVersionText(event.extras?.icResolveStatus),
    name: normalizedVersionText(event.extras?.icName),
    resolvedManually: event.extras?.icResolvedManually === true,
    manualUpdatedAt: normalizedVersionText(event.extras?.icResolveManualUpdatedAt),
    // Snapshot primitive inputs instead of holding mutable geo/extras objects.
    // Address completion and sync acknowledgement may change the general row
    // revision while this request is running; neither invalidates an IC lookup.
    inputSignature: event.tripId && event.type && event.ts ? JSON.stringify([
      event.tripId, event.type, event.ts,
      event.geo ? [event.geo.lat, event.geo.lng, event.geo.accuracy ?? null] : null,
      event.extras?.expresswaySessionId ?? null,
      autoDecision?.source ?? null, autoDecision?.action ?? null, autoDecision?.evaluatedAt ?? null,
    ]) : null,
    resolutionSignature: JSON.stringify(Object.entries(event.extras ?? {})
      .filter(([key]) => key.startsWith('ic'))
      .sort(([a], [b]) => a.localeCompare(b))),
  };
}

/**
 * Match the exact IC inputs/state observed before the network request while
 * allowing unrelated address/sync updates. Partial legacy callers retain the
 * stricter general revision comparison because they cannot supply all inputs.
 */
export function canApplyIcResolutionResult(
  expected: IcResolutionEventVersion,
  currentEvent: IcResolutionEventVersionSource,
  options?: { allowExistingManual?: boolean },
): boolean {
  const current = captureIcResolutionEventVersion(currentEvent);
  if (current.resolvedManually && options?.allowExistingManual !== true) return false;
  const sameInput = expected.inputSignature != null && current.inputSignature != null
    ? expected.inputSignature === current.inputSignature
    : current.localRevision === expected.localRevision && current.syncMutationId === expected.syncMutationId;
  return sameInput
    && current.resolutionSignature === expected.resolutionSignature
    && current.status === expected.status
    && current.name === expected.name
    && current.resolvedManually === expected.resolvedManually
    && current.manualUpdatedAt === expected.manualUpdatedAt;
}

function parsePositiveInt(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

export function getIcResolveRetryCount(extras: IcResolveExtras): number {
  return parsePositiveInt(extras?.icResolveRetryCount);
}

export function getIcResolveAlgorithmVersion(extras: IcResolveExtras): number {
  return parsePositiveInt(extras?.icResolveAlgorithmVersion);
}

export function isStaleIcResolveAlgorithm(extras: IcResolveExtras): boolean {
  return getIcResolveAlgorithmVersion(extras) < IC_RESOLVE_ALGORITHM_VERSION;
}

function getIcResolveNextRetryAtMs(extras: IcResolveExtras): number | null {
  const nextRetryAt = extras?.icResolveNextRetryAt;
  if (typeof nextRetryAt !== 'string' || !nextRetryAt.trim()) return null;
  const ms = Date.parse(nextRetryAt);
  return Number.isFinite(ms) ? ms : null;
}

export function computeIcResolveBackoffMs(retryCount: number): number {
  const exponent = Math.max(0, retryCount - 1);
  return Math.min(IC_RESOLVE_BACKOFF_CAP_MS, IC_RESOLVE_BACKOFF_BASE_MS * 2 ** exponent);
}

export function getNextIcResolveDeferredRetryCount(
  extras: IcResolveExtras,
  resetAfterRecovery = false,
): number {
  if (
    resetAfterRecovery
    || isStaleIcResolveAlgorithm(extras)
    || extras?.icResolveStatus !== 'pending'
  ) {
    return 1;
  }
  return Math.min(IC_RESOLVE_PERSISTED_RETRY_COUNT_CAP, getIcResolveRetryCount(extras) + 1);
}

export function computeIcResolveDeferredBackoffMs(
  category: IcResolveDeferredCategory,
  retryCount: number,
): number {
  const exponent = Math.max(0, Math.min(30, retryCount - 1));
  if (category === 'authorization-recoverable') {
    return Math.min(IC_RESOLVE_AUTH_BACKOFF_CAP_MS, IC_RESOLVE_AUTH_BACKOFF_BASE_MS * 2 ** exponent);
  }
  return Math.min(
    IC_RESOLVE_TEMPORARY_BACKOFF_CAP_MS,
    IC_RESOLVE_TEMPORARY_BACKOFF_BASE_MS * 2 ** exponent,
  );
}

export function canRetryIcResolve(
  extras: IcResolveExtras,
  nowMs: number,
  ignorePendingBackoff = false,
): boolean {
  const icName = extras?.icName;
  const status = extras?.icResolveStatus;
  // Legacy named events did not always persist a status. Keep those stable, but
  // do not let an older name hide a pending/failed resolver attempt. A failed
  // retry deliberately leaves the previous name in place until it can be
  // replaced by a newly resolved value.
  if (
    typeof icName === 'string'
    && icName.trim()
    && (status == null || status === 'resolved')
  ) {
    return false;
  }
  if (isStaleIcResolveAlgorithm(extras)) return true;

  if (status == null || status === 'pending') {
    if (ignorePendingBackoff) return true;
    const nextRetryMs = getIcResolveNextRetryAtMs(extras);
    return nextRetryMs == null || nextRetryMs <= nowMs;
  }
  if (status !== 'failed') return false;
  const retryCount = getIcResolveRetryCount(extras);
  if (retryCount >= IC_RESOLVE_RETRY_LIMIT) return false;
  const nextRetryMs = getIcResolveNextRetryAtMs(extras);
  // A failed event with no next-at timestamp is explicitly terminal. Ordinary
  // transient failures always receive a timestamp from the repository helper.
  return nextRetryMs != null && nextRetryMs <= nowMs;
}
