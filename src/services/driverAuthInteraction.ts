/** Shared with other tabs: interaction completion precedes a new Google attempt.
 * Storage has a separate lock so SDK writes inside an interaction never reenter it.
 */
function gate(name: string) {
  let tail: Promise<unknown> = Promise.resolve();
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.catch(() => undefined).then(async () => {
      if (typeof navigator !== 'undefined' && navigator.locks) {
        return await navigator.locks.request(name, async () => await fn());
      }
      return await fn();
    });
    tail = run.catch(() => undefined);
    return await run;
  };
}
export const withDriverAuthInteraction = gate('tracklog-driver-auth-interaction');
export const withDriverAuthStorageMutation = gate('tracklog-driver-auth-storage-mutation');
