export const TRIP_DETAIL_REFRESH_INTERVAL_MS = 60_000;

export function shouldScheduleTripDetailRefresh(hasTripEnd: boolean): boolean {
  return !hasTripEnd;
}

export function shouldRefreshTripDetailOnVisibility(visibilityState: DocumentVisibilityState): boolean {
  return visibilityState === 'visible';
}

export function shouldRefreshTripDetailOnAppState(isActive: boolean): boolean {
  return isActive;
}

export function millisecondsUntilNextTripDetailRefresh(
  nowMs: number,
  intervalMs = TRIP_DETAIL_REFRESH_INTERVAL_MS,
): number {
  if (!Number.isFinite(nowMs) || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    return TRIP_DETAIL_REFRESH_INTERVAL_MS;
  }
  const remainder = ((nowMs % intervalMs) + intervalMs) % intervalMs;
  return remainder === 0 ? intervalMs : intervalMs - remainder;
}
