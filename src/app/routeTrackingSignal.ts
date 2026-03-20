export const ROUTE_TRACKING_SYNC_EVENT = 'tracklog:route-tracking-sync';

export function requestRouteTrackingSync() {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new CustomEvent(ROUTE_TRACKING_SYNC_EVENT));
}
