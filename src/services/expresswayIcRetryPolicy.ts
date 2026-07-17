export const IC_RESOLVE_RETRY_LIMIT = 6;
// Bump this when resolver behavior changes so previously exhausted failures retry.
export const IC_RESOLVE_ALGORITHM_VERSION = 9;

const IC_RESOLVE_BACKOFF_BASE_MS = 2 * 60 * 1000;
const IC_RESOLVE_BACKOFF_CAP_MS = 60 * 60 * 1000;

type IcResolveExtras = Record<string, unknown> | null | undefined;

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

export function canRetryIcResolve(
  extras: IcResolveExtras,
  nowMs: number,
  ignorePendingBackoff = false,
): boolean {
  const icName = extras?.icName;
  if (typeof icName === 'string' && icName.trim()) return false;
  if (isStaleIcResolveAlgorithm(extras)) return true;

  const status = extras?.icResolveStatus;
  if (status == null || status === 'pending') {
    if (ignorePendingBackoff) return true;
    const nextRetryMs = getIcResolveNextRetryAtMs(extras);
    return nextRetryMs == null || nextRetryMs <= nowMs;
  }
  if (status !== 'failed') return false;
  const retryCount = getIcResolveRetryCount(extras);
  if (retryCount >= IC_RESOLVE_RETRY_LIMIT) return false;
  const nextRetryMs = getIcResolveNextRetryAtMs(extras);
  return nextRetryMs == null || nextRetryMs <= nowMs;
}
