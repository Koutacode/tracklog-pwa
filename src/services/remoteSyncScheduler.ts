export const ROUTE_SYNC_BATCH_DELAY_MS = 30_000;
export const ROUTE_SYNC_BATCH_SIZE = 100;
export const IMPORTANT_SYNC_DELAY_MS = 1_200;

type SchedulerOptions = {
  sync: (reason: string) => void;
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => number;
  clearTimer: (timer: number) => void;
};

/** Coalesce routine route writes without postponing important mutations. */
export function createRemoteSyncScheduler(options: SchedulerOptions) {
  let timer: number | null = null;
  let dueAt = 0;
  let routeMutationCount = 0;

  const cancel = () => {
    if (timer !== null) options.clearTimer(timer);
    timer = null;
    routeMutationCount = 0;
  };

  const request = (reason: string) => {
    const routeWrite = reason === 'route-points-create' || reason === 'route-points-update';
    const routineRoute = routeWrite || reason === 'route-point';
    // Repositories also emit route-point after the Dexie hook. Count the hook
    // only so one saved point does not count twice toward the batch threshold.
    if (routeWrite) routeMutationCount += 1;
    const delayMs = routineRoute && routeMutationCount < ROUTE_SYNC_BATCH_SIZE
      ? ROUTE_SYNC_BATCH_DELAY_MS
      : IMPORTANT_SYNC_DELAY_MS;
    const nextDueAt = options.now() + delayMs;
    // Keep the first deadline. A continuous stream cannot starve the batch,
    // and a later route point cannot delay an event/deletion/profile update.
    if (timer !== null && dueAt <= nextDueAt) return;
    if (timer !== null) options.clearTimer(timer);
    dueAt = nextDueAt;
    timer = options.setTimer(() => {
      timer = null;
      routeMutationCount = 0;
      options.sync(reason);
    }, delayMs);
  };

  return { request, cancel };
}
