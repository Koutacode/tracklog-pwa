import { canRetryIcResolve, computeIcResolveBackoffMs } from './expresswayIcRetryPolicy';

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

const nowMs = Date.parse('2026-07-17T08:00:00.000Z');

assertEqual(
  canRetryIcResolve({ icName: '札幌IC', icResolveAlgorithmVersion: 1 }, nowMs),
  false,
  'an already named event is never reprocessed just because its algorithm is old',
);
assertEqual(
  canRetryIcResolve({ icResolveAlgorithmVersion: 1, icResolveRetryCount: 6 }, nowMs),
  true,
  'an unnamed event from an old algorithm is retried even after exhaustion',
);
assertEqual(
  canRetryIcResolve({
    icResolveAlgorithmVersion: 9,
    icResolveStatus: 'pending',
    icResolveNextRetryAt: '2026-07-17T08:02:00.000Z',
  }, nowMs),
  false,
  'pending backoff is observed during the timer run',
);
assertEqual(
  canRetryIcResolve({
    icResolveAlgorithmVersion: 9,
    icResolveStatus: 'pending',
    icResolveNextRetryAt: '2026-07-17T08:02:00.000Z',
  }, nowMs, true),
  true,
  'auth and online recovery can bypass pending backoff',
);
assertEqual(
  canRetryIcResolve({
    icResolveAlgorithmVersion: 9,
    icResolveStatus: 'failed',
    icResolveRetryCount: 5,
    icResolveNextRetryAt: '2026-07-17T07:59:00.000Z',
  }, nowMs),
  true,
  'a due non-exhausted failure is retried',
);
assertEqual(
  canRetryIcResolve({
    icResolveAlgorithmVersion: 9,
    icResolveStatus: 'failed',
    icResolveRetryCount: 6,
  }, nowMs),
  false,
  'an exhausted current-algorithm failure is not retried forever',
);
assertEqual(computeIcResolveBackoffMs(1), 120_000, 'first failure uses two-minute backoff');
assertEqual(computeIcResolveBackoffMs(10), 3_600_000, 'backoff is capped at one hour');

console.log('expresswayIcRetryPolicy: 8 tests passed');
