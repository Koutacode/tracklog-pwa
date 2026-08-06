import assert from 'node:assert/strict';
import {
  LEGACY_TOGGLE_SESSION_ID,
  PERSISTED_BASIC_TOGGLE_DEFINITIONS,
  findAcceptedTogglePair,
  findExcludedToggleEnd,
  findOpenToggleSessionId,
  findOpenToggleStart,
  resolveTogglePairing,
  type TogglePairingEvent,
} from './togglePairing';

type TestEvent = TogglePairingEvent & { id?: string };

const loadDefinition = PERSISTED_BASIC_TOGGLE_DEFINITIONS.find(
  definition => definition.channel === 'load',
)!;

function event(
  id: string | undefined,
  type: string,
  ts: string,
  sessionKey?: string,
  sessionId?: string,
): TestEvent {
  return {
    ...(id ? { id } : {}),
    type,
    ts,
    ...(sessionKey && sessionId ? { extras: { [sessionKey]: sessionId } } : {}),
  };
}

function elapsedFloorMinutes(start: TestEvent, end: TestEvent): number {
  return Math.floor((Date.parse(end.ts) - Date.parse(start.ts)) / 60_000);
}

// Regression fixture recovered from the Work/Notion investigation. The first
// mismatched end reconnects A -> B, C pairs exactly, and the delayed second A
// end must not consume anything after the rest began.
const notionEvents: TestEvent[] = [
  event('load-a-start', 'load_start', '2026-07-27T04:21:01.054Z', 'loadSessionId', 'A'),
  event('load-b-end', 'load_end', '2026-07-27T07:23:33.195Z', 'loadSessionId', 'B'),
  event('load-c-start', 'load_start', '2026-07-27T08:05:34.046Z', 'loadSessionId', 'C'),
  event('load-c-end', 'load_end', '2026-07-27T09:22:22.273Z', 'loadSessionId', 'C'),
  event('rest-start', 'rest_start', '2026-07-27T11:00:21.341Z', 'restSessionId', 'R'),
  event('late-load-a-end', 'load_end', '2026-07-27T11:00:40.498Z', 'loadSessionId', 'A'),
];
const notionResult = resolveTogglePairing(notionEvents, PERSISTED_BASIC_TOGGLE_DEFINITIONS);
const notionLoadPairs = notionResult.pairs.filter(pair => pair.definition.channel === 'load');

assert.equal(notionLoadPairs.length, 2);
assert.equal(notionLoadPairs[0].startSessionId, 'A');
assert.equal(notionLoadPairs[0].endSessionId, 'B');
assert.equal(notionLoadPairs[0].match, 'reconnected');
assert.equal(elapsedFloorMinutes(notionLoadPairs[0].start, notionLoadPairs[0].end), 182);
assert.equal(notionLoadPairs[1].match, 'exact');
assert.equal(elapsedFloorMinutes(notionLoadPairs[1].start, notionLoadPairs[1].end), 76);
assert.deepEqual(
  notionResult.excludedEnds.map(excluded => [excluded.end.id, excluded.reason]),
  [['late-load-a-end', 'stale_end']],
);
assert.ok(
  notionResult.normalEvents.some(candidate => candidate.id === 'rest-start'),
  'an unrelated rest start must remain in the normal timeline',
);
assert.ok(
  !notionResult.normalEvents.some(candidate => candidate.id === 'late-load-a-end'),
  'the stale end is review-only',
);
assert.ok(
  notionResult.rawEvents.some(candidate => candidate.id === 'late-load-a-end'),
  'the stale end remains available to repair/review screens',
);
assert.equal(
  notionResult.openStarts.find(open => open.definition.channel === 'rest')?.start.id,
  'rest-start',
);

// Same-ID pair: session IDs prove the exact match.
const exactStart = event('exact-start', 'load_start', '2026-07-28T00:00:00.000Z', 'loadSessionId', 'exact');
const exactEnd = event('exact-end', 'load_end', '2026-07-28T00:05:00.000Z', 'loadSessionId', 'exact');
const exactResult = resolveTogglePairing([exactEnd, exactStart], [loadDefinition]);
assert.equal(exactResult.pairs.length, 1, 'timestamp chronology is independent of input order');
assert.equal(exactResult.pairs[0]?.match, 'exact');
assert.equal(exactResult.openStarts.length, 0);

const causalExactResult = resolveTogglePairing([exactStart, exactEnd], [loadDefinition]);
assert.equal(causalExactResult.pairs[0]?.match, 'exact');
assert.equal(findAcceptedTogglePair(causalExactResult, 'exact-end')?.start.id, 'exact-start');
assert.equal(findAcceptedTogglePair(causalExactResult, exactStart)?.end.id, 'exact-end');

// An end without any causally open start is an orphan and only that end is
// removed from the normal projection.
const unrelated = event('point', 'point_mark', '2026-07-28T00:01:00.000Z');
const orphanEnd = event('orphan', 'load_end', '2026-07-28T00:02:00.000Z', 'loadSessionId', 'O');
const orphanResult = resolveTogglePairing([unrelated, orphanEnd], [loadDefinition]);
assert.equal(orphanResult.excludedEnds[0]?.reason, 'orphan_end');
assert.deepEqual(orphanResult.normalEvents.map(candidate => candidate.id), ['point']);
assert.equal(findExcludedToggleEnd(orphanResult, orphanEnd)?.reason, 'orphan_end');

// A duplicate end uses a consumed alias and is therefore stale, not orphan.
const duplicateResult = resolveTogglePairing([
  event('dup-start', 'load_start', '2026-07-28T01:00:00.000Z', 'loadSessionId', 'D'),
  event('dup-end-1', 'load_end', '2026-07-28T01:10:00.000Z', 'loadSessionId', 'D'),
  event('dup-end-2', 'load_end', '2026-07-28T01:10:00.000Z', 'loadSessionId', 'D'),
], [loadDefinition]);
assert.equal(duplicateResult.pairs.length, 1);
assert.equal(duplicateResult.pairs[0].match, 'exact');
assert.deepEqual(
  duplicateResult.excludedEnds.map(excluded => [excluded.end.id, excluded.reason]),
  [['dup-end-2', 'stale_end']],
);

// An end earlier than its would-be start cannot pair backwards.
const endBeforeStartResult = resolveTogglePairing([
  event('future-start', 'load_start', '2026-07-28T03:00:00.000Z', 'loadSessionId', 'F'),
  event('early-end', 'load_end', '2026-07-28T02:59:59.999Z', 'loadSessionId', 'F'),
], [loadDefinition]);
assert.equal(endBeforeStartResult.excludedEnds[0]?.reason, 'orphan_end');
assert.equal(endBeforeStartResult.openStarts[0]?.start.id, 'future-start');

// A pair may span midnight/day boundaries.
const crossDayResult = resolveTogglePairing([
  event('cross-start', 'load_start', '2026-07-28T23:59:00.000Z', 'loadSessionId', 'X'),
  event('cross-end', 'load_end', '2026-07-29T00:01:00.000Z', 'loadSessionId', 'X'),
], [loadDefinition]);
assert.equal(crossDayResult.pairs.length, 1);
assert.equal(crossDayResult.pairs[0].match, 'exact');

// Legacy records may lack both event IDs and session IDs. FIFO still reconnects
// them, and the open-session helper exposes the established legacy marker.
const legacyStart = event(undefined, 'load_start', '2026-07-29T01:00:00.000Z');
const legacyEnd = event(undefined, 'load_end', '2026-07-29T01:10:00.000Z');
const legacyResult = resolveTogglePairing([legacyStart, legacyEnd], [loadDefinition]);
assert.equal(legacyResult.pairs.length, 1);
assert.equal(legacyResult.pairs[0].match, 'reconnected');
assert.equal(findOpenToggleStart([legacyStart], loadDefinition), legacyStart);
assert.equal(findOpenToggleSessionId([legacyStart], loadDefinition), LEGACY_TOGGLE_SESSION_ID);
assert.equal(
  findOpenToggleSessionId([legacyStart], 'load_start', 'load_end', 'loadSessionId'),
  LEGACY_TOGGLE_SESSION_ID,
  'the compatibility helper signature follows the same resolver',
);

// A stale alias cannot close a different currently open session.
const differentOpenResult = resolveTogglePairing([
  event('a-start', 'load_start', '2026-07-29T02:00:00.000Z', 'loadSessionId', 'A'),
  event('a-end', 'load_end', '2026-07-29T02:10:00.000Z', 'loadSessionId', 'A'),
  event('b-start', 'load_start', '2026-07-29T02:20:00.000Z', 'loadSessionId', 'B'),
  event('a-late', 'load_end', '2026-07-29T02:20:00.000Z', 'loadSessionId', 'A'),
], [loadDefinition]);
assert.equal(differentOpenResult.excludedEnds[0]?.reason, 'stale_end');
assert.equal(differentOpenResult.openStarts[0]?.sessionId, 'B');
assert.equal(findOpenToggleSessionId(
  differentOpenResult.rawEvents,
  loadDefinition,
), 'B');

// Equal timestamps use definition channel order, then start-before-end, then
// immutable IDs. Recomputing is deterministic and never mutates the caller's
// array or depend on its DB/index order.
const equalTimestamp = '2026-07-29T03:00:00.000Z';
const equalTimeEvents = [
  event('second-name-first-input', 'load_start', equalTimestamp, 'loadSessionId', 'B'),
  event('first-name-second-input', 'load_start', equalTimestamp, 'loadSessionId', 'A'),
  event('equal-end-1', 'load_end', equalTimestamp, 'loadSessionId', 'X'),
  event('equal-end-2', 'load_end', equalTimestamp, 'loadSessionId', 'Y'),
];
const originalIds = equalTimeEvents.map(candidate => candidate.id);
const equalResultOne = resolveTogglePairing(equalTimeEvents, [loadDefinition]);
const equalResultTwo = resolveTogglePairing(equalTimeEvents, [loadDefinition]);
assert.deepEqual(
  equalResultOne.pairs.map(pair => pair.start.id),
  ['first-name-second-input', 'second-name-first-input'],
);
assert.deepEqual(
  equalResultTwo.pairs.map(pair => [pair.start.id, pair.end.id, pair.match]),
  equalResultOne.pairs.map(pair => [pair.start.id, pair.end.id, pair.match]),
);
assert.deepEqual(equalTimeEvents.map(candidate => candidate.id), originalIds);

const endFirstAtEqualTime = resolveTogglePairing([
  event('equal-orphan', 'load_end', equalTimestamp, 'loadSessionId', 'Z'),
  event('equal-open', 'load_start', equalTimestamp, 'loadSessionId', 'Z'),
], [loadDefinition]);
assert.equal(endFirstAtEqualTime.pairs.length, 1, 'same-time start is ordered before its end');
assert.equal(endFirstAtEqualTime.pairs[0].match, 'exact');
assert.equal(endFirstAtEqualTime.pairs[0].start.id, 'equal-open');
assert.equal(endFirstAtEqualTime.pairs[0].end.id, 'equal-orphan');
assert.equal(
  Date.parse(endFirstAtEqualTime.pairs[0].end.ts)
    - Date.parse(endFirstAtEqualTime.pairs[0].start.ts),
  0,
  'a simultaneous start/end is an explicit zero-length pair',
);
assert.equal(endFirstAtEqualTime.excludedEnds.length, 0);
assert.equal(endFirstAtEqualTime.openStarts.length, 0);

const crossChannelAtEqualTime = resolveTogglePairing([
  event('load-end-same-time', 'load_end', equalTimestamp, 'loadSessionId', 'L'),
  event('rest-end-same-time', 'rest_end', equalTimestamp, 'restSessionId', 'R'),
  event('load-start-same-time', 'load_start', equalTimestamp, 'loadSessionId', 'L'),
  event('rest-start-same-time', 'rest_start', equalTimestamp, 'restSessionId', 'R'),
], PERSISTED_BASIC_TOGGLE_DEFINITIONS);
assert.deepEqual(
  crossChannelAtEqualTime.rawEvents.map(candidate => candidate.id),
  [
    'rest-start-same-time',
    'rest-end-same-time',
    'load-start-same-time',
    'load-end-same-time',
  ],
  'definition order stabilizes different channels and start precedes end in each',
);
assert.deepEqual(
  crossChannelAtEqualTime.pairs.map(pair => [pair.definition.channel, pair.match]),
  [['rest', 'exact'], ['load', 'exact']],
);

// Automatic transitions persist a closing event and one or more opening events
// at exactly the same timestamp. Cross-channel ends must remain ahead of starts:
// break closes, then rest starts, then boarding starts in definition order.
const transitionTimestamp = '2026-07-29T04:00:00.000Z';
const automaticTransitionResult = resolveTogglePairing([
  event('break-start-before-transition', 'break_start', '2026-07-29T03:30:00.000Z', 'breakSessionId', 'BR'),
  event('boarding-at-transition', 'boarding', transitionTimestamp, 'ferrySessionId', 'F'),
  event('rest-start-at-transition', 'rest_start', transitionTimestamp, 'restSessionId', 'R'),
  event('break-end-at-transition', 'break_end', transitionTimestamp, 'breakSessionId', 'BR'),
], PERSISTED_BASIC_TOGGLE_DEFINITIONS);
assert.deepEqual(
  automaticTransitionResult.rawEvents.map(candidate => candidate.id),
  [
    'break-start-before-transition',
    'break-end-at-transition',
    'rest-start-at-transition',
    'boarding-at-transition',
  ],
  'a transition closes the prior channel before opening new channels',
);
assert.equal(
  automaticTransitionResult.pairs.find(pair => pair.definition.channel === 'break')?.match,
  'exact',
);
assert.deepEqual(
  automaticTransitionResult.openStarts.map(open => open.definition.channel),
  ['rest', 'ferry'],
  'same-role starts remain stable by definition order',
);

console.log('togglePairing: regression, causality, legacy, and deterministic-order assertions passed');
