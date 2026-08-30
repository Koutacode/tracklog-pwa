import {
  millisecondsUntilNextTripDetailRefresh,
  shouldRefreshTripDetailOnAppState,
  shouldRefreshTripDetailOnVisibility,
  shouldScheduleTripDetailRefresh,
} from './tripDetailLiveRefresh';

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected=${String(expected)} actual=${String(actual)}`);
}

assertEqual(shouldScheduleTripDetailRefresh(false), true, 'active trip schedules live refresh');
assertEqual(shouldScheduleTripDetailRefresh(true), false, 'finished trip does not schedule live refresh');
assertEqual(shouldRefreshTripDetailOnVisibility('visible'), true, 'visible tab refreshes immediately');
assertEqual(shouldRefreshTripDetailOnVisibility('hidden'), false, 'hidden tab does not refresh');
assertEqual(shouldRefreshTripDetailOnAppState(true), true, 'active native app refreshes immediately');
assertEqual(shouldRefreshTripDetailOnAppState(false), false, 'background native app does not refresh');
assertEqual(millisecondsUntilNextTripDetailRefresh(0), 60_000, 'exact boundary waits one interval');
assertEqual(millisecondsUntilNextTripDetailRefresh(1), 59_999, 'refresh aligns to the next minute');
assertEqual(millisecondsUntilNextTripDetailRefresh(59_999), 1, 'last millisecond reaches the next minute');
assertEqual(millisecondsUntilNextTripDetailRefresh(Number.NaN), 60_000, 'invalid current time is safe');
assertEqual(millisecondsUntilNextTripDetailRefresh(1_000, 0), 60_000, 'invalid interval is safe');

console.log('tripDetailLiveRefresh: 11 assertions passed');
