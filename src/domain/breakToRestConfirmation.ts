import { buildBreakToRestTransition, type BreakToRestTransition } from './metrics';
import type { AppEvent } from './types';

export type BreakToRestConfirmationStatus = 'pending' | 'approved' | 'declined';

export type BreakToRestCandidate = {
  tripId: string;
  breakStartId: string;
  breakStartTs: string;
  thresholdTs: string;
  transition: BreakToRestTransition;
};

export type StoredBreakToRestConfirmation = {
  version: 1;
  tripId: string;
  breakStartId: string;
  breakStartTs: string;
  thresholdTs: string;
  status: BreakToRestConfirmationStatus;
  updatedAt: string;
};

function isValidIso(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isConfirmationStatus(value: unknown): value is BreakToRestConfirmationStatus {
  return value === 'pending' || value === 'approved' || value === 'declined';
}

/**
 * Resolve the single open break that has reached the three-hour threshold.
 * Ended breaks, completed trips, and already-generated transitions return null
 * through buildBreakToRestTransition's open-toggle validation.
 */
export function findDueBreakToRestCandidate(
  events: readonly AppEvent[],
  evaluatedAt: string,
): BreakToRestCandidate | null {
  const transition = buildBreakToRestTransition(events, evaluatedAt);
  if (!transition) return null;

  const generatedFrom = transition.restStart.extras.generatedFrom;
  if (typeof generatedFrom !== 'string' || !generatedFrom.trim()) return null;
  const breakStart = events.find(event => (
    event.id === generatedFrom
    && event.tripId === transition.restStart.tripId
    && event.type === 'break_start'
  ));
  if (!breakStart || !isValidIso(breakStart.ts)) return null;

  return {
    tripId: transition.restStart.tripId,
    breakStartId: breakStart.id,
    breakStartTs: breakStart.ts,
    thresholdTs: transition.thresholdTs,
    transition,
  };
}

export function createStoredBreakToRestConfirmation(params: {
  candidate: BreakToRestCandidate;
  status: BreakToRestConfirmationStatus;
  updatedAt: string;
}): StoredBreakToRestConfirmation {
  if (!isValidIso(params.updatedAt)) throw new Error('休憩確認の更新時刻が不正です');
  return {
    version: 1,
    tripId: params.candidate.tripId,
    breakStartId: params.candidate.breakStartId,
    breakStartTs: params.candidate.breakStartTs,
    thresholdTs: params.candidate.thresholdTs,
    status: params.status,
    updatedAt: new Date(Date.parse(params.updatedAt)).toISOString(),
  };
}

/**
 * Parse local metadata only when the stable trip + break-start identity still
 * matches. Timestamps remain audit evidence, but timeline edits must not turn a
 * final "declined" answer back into a prompt for the same break-start event.
 */
export function parseStoredBreakToRestConfirmation(
  raw: string | null,
  candidate: BreakToRestCandidate,
): StoredBreakToRestConfirmation | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.version !== 1
      || value.tripId !== candidate.tripId
      || value.breakStartId !== candidate.breakStartId
      || !isValidIso(value.breakStartTs)
      || !isValidIso(value.thresholdTs)
      || !isConfirmationStatus(value.status)
      || !isValidIso(value.updatedAt)
    ) {
      return null;
    }
    return {
      version: 1,
      tripId: value.tripId,
      breakStartId: value.breakStartId,
      breakStartTs: value.breakStartTs,
      thresholdTs: value.thresholdTs,
      status: value.status,
      updatedAt: new Date(Date.parse(value.updatedAt)).toISOString(),
    };
  } catch {
    return null;
  }
}

export function serializeStoredBreakToRestConfirmation(
  value: StoredBreakToRestConfirmation,
): string {
  return JSON.stringify(value);
}

export function normalizeOptionalRestStartOdometer(odoKm: number): number | undefined {
  if (!Number.isFinite(odoKm) || odoKm < 0) {
    throw new Error('休息開始メーターが不正です');
  }
  return odoKm > 0 ? odoKm : undefined;
}

/**
 * Keep the native three-hour pause while a decision is unresolved. Declining
 * means the driver is continuing this interval as a break, so future route
 * points must resume even though the break toggle remains open.
 */
export function resolveBreakToRestRoutePauseAt(
  thresholdTs: string | null,
  status: BreakToRestConfirmationStatus | null,
): string | null {
  if (!thresholdTs) return null;
  return status === 'declined' ? null : thresholdTs;
}

/** A due break may be closed without conversion only after an explicit No. */
export function canCloseDueBreakAfterConfirmation(
  status: BreakToRestConfirmationStatus | null,
): boolean {
  return status === 'declined';
}

/** Attach an odometer checkpoint only for a positive reading. */
export function attachBreakToRestOdometer(
  transition: BreakToRestTransition,
  odoKm: number,
): BreakToRestTransition {
  const checkpoint = normalizeOptionalRestStartOdometer(odoKm);
  return {
    ...transition,
    restStart: {
      ...transition.restStart,
      extras: {
        ...transition.restStart.extras,
        ...(checkpoint != null ? { odoKm: checkpoint } : {}),
      },
    },
  };
}
