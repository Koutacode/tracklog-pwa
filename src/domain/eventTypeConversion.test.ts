import assert from 'node:assert/strict';
import type { AppEvent, EventType } from './types';
import {
  getEditableEventTypeOptions,
  planEventTypeConversion,
} from './eventTypeConversion';

const TRIP_ID = 'trip-edit';

function event(
  id: string,
  type: EventType,
  ts: string,
  extras?: Record<string, unknown>,
  tripId = TRIP_ID,
): AppEvent {
  return {
    id,
    tripId,
    type,
    ts,
    syncStatus: 'synced',
    ...(extras ? { extras } : {}),
  } as AppEvent;
}

const fixedSession = () => 'generated-session';

// An active/open start is independently editable. No artificial end is needed.
{
  const rest = event('open-rest', 'rest_start', '2026-08-29T01:00:00.000Z', {
    restSessionId: 'rest-open',
    odoKm: 1234,
    reportMinDurationMinutes: 15,
  });
  const input = [rest];
  const original = structuredClone(input);
  const plan = planEventTypeConversion(input, rest.id, 'break_start', fixedSession);

  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0]?.type, 'break_start');
  assert.deepEqual(plan.updates[0]?.extras, {
    breakSessionId: 'rest-open',
    reportMinDurationMinutes: 15,
  });
  assert.deepEqual(input, original, 'planning must not mutate live Dexie objects');
  assert.deepEqual(
    getEditableEventTypeOptions(input, rest.id),
    ['rest_start', 'break_start', 'load_start', 'unload_start'],
  );
}

// Ferry-generated rest is part of the boarding/disembark lifecycle and cannot
// be retyped independently, from either the start or the end side.
{
  const autoRestStart = event('auto-rest-start', 'rest_start', '2026-08-29T01:30:00.000Z', {
    restSessionId: 'ferry-rest',
    autoReason: 'ferry_boarding',
    generatedFrom: 'boarding',
    reportMinDurationMinutes: 15,
  });
  const boarding = event('boarding', 'boarding', '2026-08-29T01:30:00.000Z', {
    ferrySessionId: 'ferry',
    autoRestSessionId: 'ferry-rest',
  });
  const disembark = event('disembark', 'disembark', '2026-08-29T03:00:00.000Z', {
    ferrySessionId: 'ferry',
  });
  const autoRestEnd = event('auto-rest-end', 'rest_end', '2026-08-29T03:00:00.000Z', {
    restSessionId: 'ferry-rest',
    dayClose: false,
    autoReason: 'ferry_disembark',
    generatedFrom: 'disembark',
  });
  const input = [autoRestStart, boarding, disembark, autoRestEnd];

  assert.throws(
    () => planEventTypeConversion(input, autoRestStart.id, 'break_start', fixedSession),
    /フェリー乗船と連動する休息/,
  );
  assert.throws(
    () => planEventTypeConversion(input, autoRestEnd.id, 'break_end', fixedSession),
    /フェリー乗船と連動する休息/,
  );
  assert.deepEqual(getEditableEventTypeOptions(input, autoRestStart.id), ['rest_start']);
  assert.deepEqual(getEditableEventTypeOptions(input, autoRestEnd.id), ['rest_end']);
}

// Pairing uses the selected session ID before chronology. Intervening and
// simultaneous records from another session must never be rewritten.
{
  const selected = event('load-a-start', 'load_start', '2026-08-29T02:00:00.000Z', {
    loadSessionId: 'A',
    reportMinDurationMinutes: 15,
  });
  const unrelatedStart = event('load-b-start', 'load_start', '2026-08-29T02:05:00.000Z', {
    loadSessionId: 'B',
  });
  const unrelatedEnd = event('load-b-end', 'load_end', '2026-08-29T02:10:00.000Z', {
    loadSessionId: 'B',
  });
  const exactEnd = event('load-a-end', 'load_end', '2026-08-29T02:10:00.000Z', {
    loadSessionId: 'A',
  });
  const point = event('point-between', 'point_mark', '2026-08-29T02:07:00.000Z');
  const plan = planEventTypeConversion(
    [unrelatedEnd, point, exactEnd, unrelatedStart, selected],
    selected.id,
    'unload_start',
    fixedSession,
  );

  assert.deepEqual(plan.updates.map(update => update.id), ['load-a-start', 'load-a-end']);
  assert.deepEqual(plan.updates.map(update => update.type), ['unload_start', 'unload_end']);
  assert.ok(plan.updates.every(update => update.extras.unloadSessionId === 'A'));
  assert.ok(!plan.updates.some(update => update.id === unrelatedStart.id));
  assert.ok(!plan.updates.some(update => update.id === unrelatedEnd.id));
}

// Complete pairs can cross midnight and preserve the original shared session.
{
  const start = event('rest-cross-start', 'rest_start', '2026-08-29T23:55:00.000Z', {
    restSessionId: 'cross-day',
    odoKm: 500,
    reportMinDurationMinutes: 15,
  });
  const end = event('rest-cross-end', 'rest_end', '2026-08-30T08:10:00.000Z', {
    restSessionId: 'cross-day',
    dayClose: true,
    dayIndex: 4,
  });
  const plan = planEventTypeConversion([end, start], start.id, 'break_start', fixedSession);
  assert.deepEqual(plan.updates.map(update => update.type), ['break_start', 'break_end']);
  assert.equal(plan.updates[1]?.extras.dayClose, undefined);
  assert.equal(plan.updates[1]?.extras.dayIndex, undefined);
  assert.equal(plan.updates[1]?.extras.reportMinDurationMinutes, undefined);
  assert.equal(plan.updates[1]?.extras.breakSessionId, 'cross-day');
}

// Fully legacy pairs without a session ID still convert together and receive
// one new ID. Equal timestamps remain a causal zero-length pair.
{
  const start = event('legacy-start', 'break_start', '2026-08-30T09:00:00.000Z');
  const end = event('legacy-end', 'break_end', '2026-08-30T09:00:00.000Z');
  const plan = planEventTypeConversion([end, start], start.id, 'load_start', fixedSession);
  assert.deepEqual(plan.updates.map(update => update.id), ['legacy-start', 'legacy-end']);
  assert.ok(plan.updates.every(update => update.extras.loadSessionId === 'generated-session'));
}

// A selected session with only a differently identified end is an open start,
// not permission to mutate the other session.
{
  const start = event('stale-id-start', 'load_start', '2026-08-30T10:00:00.000Z', {
    loadSessionId: 'source-session',
  });
  const otherEnd = event('other-end', 'load_end', '2026-08-30T10:30:00.000Z', {
    loadSessionId: 'other-session',
  });
  const plan = planEventTypeConversion([start, otherEnd], start.id, 'break_start', fixedSession);
  assert.deepEqual(plan.updates.map(update => update.id), ['stale-id-start']);
  assert.equal(plan.updates[0]?.extras.breakSessionId, 'source-session');
}

// A missing session ID on one side is the narrow legacy repair case: the
// causal counterpart changes with it and gets the same regenerated group key.
{
  const start = event('legacy-partial-start', 'unload_start', '2026-08-30T11:00:00.000Z');
  const end = event('legacy-partial-end', 'unload_end', '2026-08-30T11:20:00.000Z', {
    unloadSessionId: 'end-only-session',
  });
  const plan = planEventTypeConversion([start, end], start.id, 'load_start', fixedSession);
  assert.deepEqual(plan.updates.map(update => update.id), [start.id, end.id]);
  assert.ok(plan.updates.every(update => update.extras.loadSessionId === 'end-only-session'));
}

// Isolated ends, role flips, and protected coupled features fail closed.
{
  const orphanEnd = event('orphan-end', 'break_end', '2026-08-30T12:00:00.000Z', {
    breakSessionId: 'orphan',
  });
  assert.throws(
    () => planEventTypeConversion([orphanEnd], orphanEnd.id, 'load_end', fixedSession),
    /対応する開始記録/,
  );
  assert.deepEqual(getEditableEventTypeOptions([orphanEnd], orphanEnd.id), ['break_end']);

  const openLoad = event('open-load', 'load_start', '2026-08-30T12:10:00.000Z', {
    loadSessionId: 'open-load-session',
  });
  assert.throws(
    () => planEventTypeConversion([openLoad], openLoad.id, 'unload_end', fixedSession),
    /開始は別の開始項目/,
  );

  for (const [sourceType, nextType] of [
    ['boarding', 'break_start'],
    ['expressway_start', 'load_start'],
    ['point_mark', 'expressway'],
  ] as const) {
    const source = event(`protected-${sourceType}`, sourceType, '2026-08-30T12:20:00.000Z');
    assert.throws(
      () => planEventTypeConversion([source], source.id, nextType, fixedSession),
      /フェリー・高速道路/,
    );
  }
}

// A conversion selected from an END also validates the START that would become
// rest_start. The UI omits rest until that paired start has a usable ODO.
{
  const startWithoutOdo = event('break-start-no-odo', 'break_start', '2026-08-30T12:30:00.000Z', {
    breakSessionId: 'break-pair',
  });
  const end = event('break-end-no-odo', 'break_end', '2026-08-30T12:45:00.000Z', {
    breakSessionId: 'break-pair',
  });
  assert.deepEqual(
    getEditableEventTypeOptions([startWithoutOdo, end], startWithoutOdo.id),
    ['break_start', 'load_start', 'unload_start'],
  );
  assert.deepEqual(
    getEditableEventTypeOptions([startWithoutOdo, end], end.id),
    ['break_end', 'load_end', 'unload_end'],
  );
  assert.throws(
    () => planEventTypeConversion([startWithoutOdo, end], end.id, 'rest_end', fixedSession),
    /ODOが必要/,
  );

  const startWithOdo = event('break-start-with-odo', 'break_start', '2026-08-30T12:50:00.000Z', {
    breakSessionId: 'break-with-odo',
    odoKm: 800,
  });
  const endWithOdo = event('break-end-with-odo', 'break_end', '2026-08-30T13:00:00.000Z', {
    breakSessionId: 'break-with-odo',
  });
  assert.ok(getEditableEventTypeOptions([startWithOdo, endWithOdo], endWithOdo.id).includes('rest_end'));
  const restPlan = planEventTypeConversion(
    [startWithOdo, endWithOdo],
    endWithOdo.id,
    'rest_end',
    fixedSession,
  );
  assert.equal(restPlan.updates.find(update => update.id === startWithOdo.id)?.type, 'rest_start');
}

// Duplicate exact IDs and ambiguous legacy candidates fail closed instead of
// choosing a counterpart by incidental array/timestamp order.
{
  const duplicateStartA = event('duplicate-start-a', 'load_start', '2026-08-30T13:10:00.000Z', {
    loadSessionId: 'duplicate',
  });
  const duplicateStartB = event('duplicate-start-b', 'load_start', '2026-08-30T13:11:00.000Z', {
    loadSessionId: 'duplicate',
  });
  const duplicateEnd = event('duplicate-end', 'load_end', '2026-08-30T13:20:00.000Z', {
    loadSessionId: 'duplicate',
  });
  const duplicates = [duplicateStartA, duplicateStartB, duplicateEnd];
  assert.throws(
    () => planEventTypeConversion(duplicates, duplicateStartA.id, 'unload_start', fixedSession),
    /記録を1件に特定できない/,
  );
  assert.deepEqual(getEditableEventTypeOptions(duplicates, duplicateStartA.id), ['load_start']);

  const oneStart = event('duplicate-end-start', 'unload_start', '2026-08-30T13:21:00.000Z', {
    unloadSessionId: 'duplicate-end-session',
  });
  const duplicateEndA = event('duplicate-end-a', 'unload_end', '2026-08-30T13:22:00.000Z', {
    unloadSessionId: 'duplicate-end-session',
  });
  const duplicateEndB = event('duplicate-end-b', 'unload_end', '2026-08-30T13:23:00.000Z', {
    unloadSessionId: 'duplicate-end-session',
  });
  assert.throws(
    () => planEventTypeConversion(
      [oneStart, duplicateEndA, duplicateEndB],
      duplicateEndA.id,
      'break_end',
      fixedSession,
    ),
    /記録を1件に特定できない/,
  );

  const legacyStart = event('ambiguous-legacy-start', 'break_start', '2026-08-30T13:30:00.000Z');
  const legacyEndA = event('ambiguous-legacy-end-a', 'break_end', '2026-08-30T13:40:00.000Z');
  const legacyEndB = event('ambiguous-legacy-end-b', 'break_end', '2026-08-30T13:50:00.000Z');
  const ambiguousLegacy = [legacyStart, legacyEndA, legacyEndB];
  assert.throws(
    () => planEventTypeConversion(ambiguousLegacy, legacyStart.id, 'load_start', fixedSession),
    /記録を1件に特定できない/,
  );
  assert.deepEqual(getEditableEventTypeOptions(ambiguousLegacy, legacyStart.id), ['break_start']);

  const legacyStartA = event('ambiguous-start-a', 'unload_start', '2026-08-30T14:00:00.000Z');
  const legacyStartB = event('ambiguous-start-b', 'unload_start', '2026-08-30T14:01:00.000Z');
  const legacyEnd = event('ambiguous-selected-end', 'unload_end', '2026-08-30T14:10:00.000Z');
  assert.throws(
    () => planEventTypeConversion(
      [legacyStartA, legacyStartB, legacyEnd],
      legacyEnd.id,
      'load_end',
      fixedSession,
    ),
    /記録を1件に特定できない/,
  );

  const impossibleExactEnd = event('impossible-exact-end', 'load_end', '2026-08-30T14:20:00.000Z', {
    loadSessionId: 'impossible-exact',
  });
  const impossibleExactStart = event('impossible-exact-start', 'load_start', '2026-08-30T14:30:00.000Z', {
    loadSessionId: 'impossible-exact',
  });
  const temptingLegacyEnd = event('tempting-legacy-end', 'load_end', '2026-08-30T14:40:00.000Z');
  const impossibleOrder = [impossibleExactEnd, impossibleExactStart, temptingLegacyEnd];
  assert.throws(
    () => planEventTypeConversion(
      impossibleOrder,
      impossibleExactStart.id,
      'unload_start',
      fixedSession,
    ),
    /記録を1件に特定できない/,
  );
  assert.throws(
    () => planEventTypeConversion(
      impossibleOrder,
      impossibleExactEnd.id,
      'unload_end',
      fixedSession,
    ),
    /記録を1件に特定できない/,
  );
  assert.deepEqual(
    getEditableEventTypeOptions(impossibleOrder, impossibleExactStart.id),
    ['load_start'],
  );
}

// Instant corrections stay instant and validate refuel-specific data.
{
  const refuel = event('refuel', 'refuel', '2026-08-30T13:00:00.000Z', { liters: 40 });
  const pointPlan = planEventTypeConversion([refuel], refuel.id, 'point_mark', fixedSession);
  assert.equal(pointPlan.updates[0]?.type, 'point_mark');
  assert.equal(pointPlan.updates[0]?.extras.liters, undefined);

  const point = event('point', 'point_mark', '2026-08-30T13:05:00.000Z');
  assert.throws(
    () => planEventTypeConversion([point], point.id, 'refuel', fixedSession),
    /給油量が必要/,
  );
  assert.deepEqual(getEditableEventTypeOptions([point], point.id), ['point_mark']);
}

// Rest conversion keeps the existing ODO prerequisite, and stale IDs never
// select an arbitrary row (including a row from another trip).
{
  const openBreak = event('break-no-odo', 'break_start', '2026-08-30T14:00:00.000Z', {
    breakSessionId: 'break-no-odo',
  });
  assert.throws(
    () => planEventTypeConversion([openBreak], openBreak.id, 'rest_start', fixedSession),
    /ODOが必要/,
  );
  assert.throws(
    () => planEventTypeConversion([openBreak], 'deleted-or-stale-id', 'load_start', fixedSession),
    /イベントが見つかりません/,
  );

  const sameSessionOtherTrip = event(
    'other-trip-end',
    'break_end',
    '2026-08-30T14:30:00.000Z',
    { breakSessionId: 'break-no-odo' },
    'different-trip',
  );
  const plan = planEventTypeConversion(
    [openBreak, sameSessionOtherTrip],
    openBreak.id,
    'load_start',
    fixedSession,
  );
  assert.deepEqual(plan.updates.map(update => update.id), [openBreak.id]);
}

console.log('eventTypeConversion: atomic plan and safe pairing assertions passed');
