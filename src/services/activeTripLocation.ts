import { ROUTE_TRACKING_SYNC_EVENT } from '../app/routeTrackingSignal';

const pendingRequests = new Set<() => void>();

/** Cancel one-shot provider subscriptions as soon as a trip is committed closed. */
export function cancelActiveTripLocationRequests() {
  for (const cancel of [...pendingRequests]) cancel();
}

export async function requestActiveTripPosition(
  options: PositionOptions = {},
): Promise<GeolocationPosition | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return null;
  const { getActiveTripId } = await import('../db/repositories');
  const tripId = await getActiveTripId();
  if (!tripId) return null;
  const provider = navigator.geolocation;
  return new Promise(resolve => {
    let watcher: number | null = null;
    let settled = false;
    const finish = (position: GeolocationPosition | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (watcher != null) provider.clearWatch(watcher);
      pendingRequests.delete(cancel);
      if (typeof window !== 'undefined') window.removeEventListener(ROUTE_TRACKING_SYNC_EVENT, onTrackingChange);
      resolve(position);
    };
    const cancel = () => finish(null);
    const onTrackingChange = () => {
      void getActiveTripId().then(active => { if (active !== tripId) cancel(); }).catch(cancel);
    };
    const timer = setTimeout(cancel, Math.max(1, Math.min(options.timeout ?? 10_000, 15_000)));
    pendingRequests.add(cancel);
    if (typeof window !== 'undefined') window.addEventListener(ROUTE_TRACKING_SYNC_EVENT, onTrackingChange);
    try {
      // getCurrentPosition cannot be cancelled. A one-fix watcher can be cleared
      // on completion, timeout, or trip end, including an in-flight admin request.
      watcher = provider.watchPosition(
        position => {
          void getActiveTripId().then(active => finish(active === tripId ? position : null)).catch(cancel);
        },
        cancel,
        options,
      );
      if (settled && watcher != null) provider.clearWatch(watcher);
    } catch {
      cancel();
    }
  });
}
