import {
  isLocationUploadThrottled,
  isValidCoordinate,
  LOCATION_UPLOAD_INTERVAL_MS,
} from './policy.ts';

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test('location upload throttle is at least 30 seconds', () => {
  const now = Date.parse('2026-07-10T05:00:30.000Z');
  assert(isLocationUploadThrottled('2026-07-10T05:00:00.001Z', now), '29.999 seconds must throttle');
  assert(!isLocationUploadThrottled('2026-07-10T05:00:00.000Z', now), '30 seconds may upload');
  assert(LOCATION_UPLOAD_INTERVAL_MS === 30_000, 'interval changed unexpectedly');
});

Deno.test('coordinate validation rejects non-finite and out-of-range values', () => {
  assert(isValidCoordinate(35.5, -90, 90), 'valid latitude rejected');
  assert(!isValidCoordinate(91, -90, 90), 'invalid latitude accepted');
  assert(!isValidCoordinate('not-a-number', -180, 180), 'invalid longitude accepted');
});
