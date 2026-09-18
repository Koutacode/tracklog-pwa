import type { LocationPayload } from './routeTracking';

/** Own only the automatic Web heartbeat; explicit location requests bypass it. */
export function createLocationHeartbeatSubscription(dependencies: {
  nativeOwnsHeartbeat: () => boolean;
  subscribe: (listener: (location: LocationPayload) => void) => () => void;
  onLocation: (location: LocationPayload) => void;
  onStart: () => void;
}) {
  let unsubscribe: (() => void) | null = null;
  const stop = () => {
    unsubscribe?.();
    unsubscribe = null;
  };
  return {
    start() {
      if (dependencies.nativeOwnsHeartbeat()) {
        stop();
        return;
      }
      if (unsubscribe) return;
      dependencies.onStart();
      unsubscribe = dependencies.subscribe(dependencies.onLocation);
    },
    stop,
  };
}
