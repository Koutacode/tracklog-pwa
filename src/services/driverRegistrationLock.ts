let tail: Promise<unknown> = Promise.resolve();
/** Do not let SIGNED_IN initialization enroll an unfinished profile. */
export function withDriverRegistrationMutation<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.catch(() => undefined).then(async () => {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return await navigator.locks.request('tracklog-driver-registration', async () => await fn());
    }
    return await fn();
  });
  tail = run.catch(() => undefined);
  return run;
}
