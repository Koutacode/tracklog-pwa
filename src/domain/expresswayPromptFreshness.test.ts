import type { AppEvent, RoutePoint } from './types';
import {
  isFreshExpresswayEndPrompt,
  matchesExpresswayPromptDecision,
} from './expresswayPromptFreshness';

const tripId = 'synthetic-trip';
const detectedAt = '2026-08-23T01:00:00.000Z';
const geo = { lat: 10, lng: 20, accuracy: 10 };
const event = (type: AppEvent['type'], ts: string): AppEvent => ({
  id: `${type}-${ts}`, tripId, type, ts, syncStatus: 'pending',
});
const fix = (ts: string, lng: number, source: RoutePoint['source'] = 'background'): RoutePoint => ({
  id: `fix-${ts}`, tripId, ts, lat: 10, lng, accuracy: 10, source,
});
const check = (decidedAt: string, events: AppEvent[] = [], latestFix?: RoutePoint | null) =>
  isFreshExpresswayEndPrompt({ detectedAt, decidedAt, geo, events, latestFix });
function assert(value: unknown, message: string) { if (!value) throw new Error(message); }

assert(check('2026-08-23T01:02:00.000Z'), 'fresh exit remains confirmable without GPS');
assert(!check('2026-08-23T13:00:00.000Z'), 'overnight prompt expires without GPS');
assert(!check('2026-08-23T01:07:00.000Z', [
  event('rest_start', '2026-08-23T01:03:00.000Z'),
  event('rest_end', '2026-08-23T01:06:00.000Z'),
]), 'rest and re-drive revoke the old prompt');
assert(!check('2026-08-23T01:07:00.000Z', [
  event('boarding', '2026-08-23T01:03:00.000Z'),
  event('disembark', '2026-08-23T01:06:00.000Z'),
]), 'ferry pause revokes the old prompt');
assert(!check('2026-08-23T01:07:00.000Z', [
  event('rest_start', '2026-08-23T00:59:00.000Z'),
  event('rest_end', '2026-08-23T01:04:00.000Z'),
]), 'a candidate detected during an existing rest is invalid');
assert(!check('2026-08-23T01:07:00.000Z', [
  event('boarding', '2026-08-23T00:59:00.000Z'),
  event('disembark', '2026-08-23T01:04:00.000Z'),
]), 'a candidate detected during an existing ferry pause is invalid');
assert(!check('2026-08-23T01:08:00.000Z', [], fix('2026-08-23T01:04:00.000Z', 20.05)),
  'five-kilometre re-drive revokes even a recently confirmed prompt');
assert(check('2026-08-23T01:08:00.000Z', [], fix('2026-08-23T01:07:00.000Z', 20.0001)),
  'nearby real GPS keeps a fresh exit available');
assert(check('2026-08-23T01:08:00.000Z', [], fix('2026-08-23T01:07:00.000Z', 20.05, 'event')),
  'an event anchor is never treated as movement evidence');
assert(check('2026-08-23T01:15:00.000Z'),
  'a later keep remains possible in sustained traffic without GPS');
assert(check('2026-08-23T01:02:00.000Z', [
  event('rest_start', '2026-08-23T01:03:00.000Z'),
]), 'a confirmation made before rest remains valid when replayed later');
assert(!check('2026-08-23T00:59:00.000Z'), 'decision before detection is invalid');
assert(matchesExpresswayPromptDecision({ tripId, promptId: 'prompt-new' },
  { tripId, promptId: 'prompt-new', detectedAt }), 'matching notification action can resume');
assert(!matchesExpresswayPromptDecision({ tripId, promptId: 'prompt-old' },
  { tripId, promptId: 'prompt-new', detectedAt }),
  'old Web action cannot borrow a newer prompt coordinate');
assert(matchesExpresswayPromptDecision({ tripId, detectedAt },
  { tripId, detectedAt }), 'Web fallback notification resumes by detection time');
assert(!matchesExpresswayPromptDecision({ tripId, detectedAt },
  { tripId, detectedAt: '2026-08-23T01:05:00.000Z' }),
  'old fallback notification cannot borrow a later prompt');
assert(!matchesExpresswayPromptDecision({ tripId },
  { tripId, detectedAt }), 'unidentified legacy action cannot bind an unrelated candidate');
console.log('expresswayPromptFreshness: 17 tests passed');
