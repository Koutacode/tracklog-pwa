const REMOTE_SYNC_REQUEST_EVENT = 'tracklog:remote-sync-request';

let suppressedDepth = 0;

export function requestRemoteSync(reason = 'mutation') {
  if (suppressedDepth > 0 || typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(REMOTE_SYNC_REQUEST_EVENT, {
      detail: {
        reason,
        requestedAt: Date.now(),
      },
    }),
  );
}

export function requestImmediateRemoteSync(reason = 'mutation') {
  requestRemoteSync(reason);
}

export function withRemoteSyncSignalsSuppressed<T>(fn: () => Promise<T>): Promise<T> {
  suppressedDepth += 1;
  return fn().finally(() => {
    suppressedDepth = Math.max(0, suppressedDepth - 1);
  });
}

export function subscribeRemoteSyncRequests(listener: (reason: string) => void) {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ reason?: string }>).detail;
    listener(detail?.reason?.trim() || 'mutation');
  };
  window.addEventListener(REMOTE_SYNC_REQUEST_EVENT, handler as EventListener);
  return () => {
    window.removeEventListener(REMOTE_SYNC_REQUEST_EVENT, handler as EventListener);
  };
}

export function subscribeRemoteSyncSignal(listener: (reason: string) => void) {
  return subscribeRemoteSyncRequests(listener);
}
