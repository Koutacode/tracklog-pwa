import assert from 'node:assert/strict';
import type { AppEvent, EventType } from '../domain/types';
import {
  getAcceptedRestDayCloses,
  getNextDayIndexFromTripEvents,
} from './repositories';

function event(params: {
  id: string;
  type: EventType;
  ts: string;
  extras?: Record<string, unknown>;
}): AppEvent {
  return {
    id: params.id,
    tripId: 'trip-day-close',
    type: params.type,
    ts: params.ts,
    syncStatus: 'synced',
    extras: params.extras,
  } as AppEvent;
}

const events: AppEvent[] = [
  event({
    id: 'orphan-end',
    type: 'rest_end',
    ts: '2026-08-07T00:30:00.000Z',
    extras: { restSessionId: 'orphan', dayClose: true, dayIndex: 98 },
  }),
  event({
    id: 'exact-start',
    type: 'rest_start',
    ts: '2026-08-07T01:00:00.000Z',
    extras: { restSessionId: 'exact' },
  }),
  event({
    id: 'exact-end',
    type: 'rest_end',
    ts: '2026-08-07T02:00:00.000Z',
    extras: { restSessionId: 'exact', dayClose: true, dayIndex: 1 },
  }),
  event({
    id: 'reconnected-start',
    type: 'rest_start',
    ts: '2026-08-07T03:00:00.000Z',
    extras: { restSessionId: 'start-alias' },
  }),
  event({
    id: 'reconnected-end',
    type: 'rest_end',
    ts: '2026-08-07T04:00:00.000Z',
    extras: { restSessionId: 'end-alias', dayClose: true, dayIndex: 2 },
  }),
  event({
    id: 'stale-end',
    type: 'rest_end',
    ts: '2026-08-07T05:00:00.000Z',
    extras: { restSessionId: 'exact', dayClose: true, dayIndex: 99 },
  }),
];

const original = structuredClone(events);
assert.deepEqual(
  getAcceptedRestDayCloses(events).map(item => item.id),
  ['exact-end', 'reconnected-end'],
  'rebalance candidates contain accepted exact/reconnected ends only',
);
assert.equal(
  getNextDayIndexFromTripEvents(events),
  3,
  'accepted exact/reconnected rest ends count, while orphan/stale ends do not advance dayIndex',
);
assert.deepEqual(events, original, 'dayIndex derivation must not mutate raw events or extras');

assert.equal(
  getNextDayIndexFromTripEvents(events.filter(item => item.id !== 'reconnected-end')),
  2,
  'an unmatched rest start does not count as a day close',
);
assert.equal(
  getNextDayIndexFromTripEvents(events.filter(item => (
    item.id === 'orphan-end' || item.id === 'stale-end'
  ))),
  1,
  'excluded rest ends alone do not create a completed day',
);

console.log('repositoriesDayClose: accepted-only dayIndex assertions passed');
