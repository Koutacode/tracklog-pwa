import { db } from '../db/db';
import type { BaseEvent, Geo } from '../domain/types';
import { canRecoverExhaustedIcResolve } from './expresswayIcRetryPolicy';

// Local scheduler state only: no coordinates, account data or new server fields.
export const IC_UPSTREAM_RECOVERY_KEY = 'ic-upstream-recovery-v1';
export const IC_UPSTREAM_SUCCESS_TTL_MS = 5 * 60_000;
export const IC_UPSTREAM_RECOVERY_INTERVAL_MS = 60_000;
export const icUpstreamRecoverySpentKey = (eventId: string) => `ic-upstream-recovery-used:${eventId}`;

export type IcUpstreamRecoveryState = { observedAt: number; nextAttemptAt: number };

export function parseIcUpstreamRecoveryState(raw: string | undefined): IcUpstreamRecoveryState {
  try {
    const value = JSON.parse(raw ?? '{}');
    return {
      observedAt: Number.isFinite(value?.observedAt) ? value.observedAt : 0,
      nextAttemptAt: Number.isFinite(value?.nextAttemptAt) ? value.nextAttemptAt : 0,
    };
  } catch {
    return { observedAt: 0, nextAttemptAt: 0 };
  }
}

export function canUseIcUpstreamRecovery(state: IcUpstreamRecoveryState, nowMs: number): boolean {
  return Number.isFinite(nowMs) && state.observedAt > 0 && state.observedAt <= nowMs
    && nowMs - state.observedAt <= IC_UPSTREAM_SUCCESS_TTL_MS
    && state.nextAttemptAt <= nowMs;
}

/** Called only after an ordinary lookup received explicitly Overpass-derived data. */
export async function recordIcUpstreamSuccess() {
  const nowMs = Date.now();
  if (!Number.isFinite(nowMs) || nowMs <= 0) return;
  await db.transaction('rw', db.meta, async () => {
    const previous = parseIcUpstreamRecoveryState((await db.meta.get(IC_UPSTREAM_RECOVERY_KEY))?.value);
    await db.meta.put({ key: IC_UPSTREAM_RECOVERY_KEY,
      value: JSON.stringify({ observedAt: nowMs, nextAttemptAt: previous.nextAttemptAt }),
      updatedAt: new Date(nowMs).toISOString() });
  });
}

/** No health/location probe: only a short-lived receipt from existing business traffic. */
export async function getIcUpstreamRecoveryCandidates(
  isUsableGeo: (geo: Geo | undefined) => boolean, limit = 20,
): Promise<BaseEvent[]> {
  const nowMs = Date.now();
  const state = parseIcUpstreamRecoveryState((await db.meta.get(IC_UPSTREAM_RECOVERY_KEY))?.value);
  if (!canUseIcUpstreamRecovery(state, nowMs)) return [];
  const events = await db.events.where('type').anyOf(['expressway', 'expressway_start', 'expressway_end']).toArray();
  // This extra recovery is deliberately limited to usable saved event fixes.
  // Geo-less rows must not repeatedly occupy the bounded page; ordinary/manual
  // lookup retains its existing route fallback for those records.
  const eligible = events.filter(event => isUsableGeo(event.geo)
    && canRecoverExhaustedIcResolve(event.extras, nowMs, state.observedAt))
    .sort((a, b) => Date.parse(String(a.extras?.icResolveLastAttemptAt)) - Date.parse(String(b.extras?.icResolveLastAttemptAt)));
  const spent = await db.meta.bulkGet(eligible.map(event => icUpstreamRecoverySpentKey(event.id)));
  return eligible.filter((_event, index) => !spent[index])
    .slice(0, Math.min(20, Math.max(0, Number.isFinite(limit) ? Math.floor(limit) : 0)));
}
