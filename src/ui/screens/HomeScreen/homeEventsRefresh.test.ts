import assert from 'node:assert/strict';
import type { AppEvent } from '../../../domain/types';
import { TRACKLOG_EVENTS_CHANGED_EVENT } from '../../../services/localEventsChanged';
import { subscribeHomeEventsChanged } from './homeEventsRefresh';
import { summarizeExpressway } from './homeStatusModel';

const pendingStart: AppEvent = {
  id: 'event-1',
  tripId: 'trip-1',
  type: 'expressway_start',
  ts: '2026-08-23T05:00:00.000Z',
  syncStatus: 'pending',
  extras: { icResolveStatus: 'pending' },
};
const resolvedStart: AppEvent = {
  ...pendingStart,
  extras: { icResolveStatus: 'resolved', icName: '厚木IC' },
};

const target = new EventTarget();
let refreshCalls = 0;
let displayedSummary = summarizeExpressway([pendingStart], pendingStart);
const refresh = () => {
  refreshCalls += 1;
  displayedSummary = summarizeExpressway([resolvedStart], resolvedStart);
};

assert.equal(displayedSummary.value, '開始ICを確認中…');

// Model React StrictMode's setup -> cleanup -> setup lifecycle. Only the live
// subscription may refresh the Home snapshot when the resolver commits an IC.
const cleanupFirstMount = subscribeHomeEventsChanged(refresh, target);
cleanupFirstMount();
const cleanupSecondMount = subscribeHomeEventsChanged(refresh, target);
target.dispatchEvent(new Event(TRACKLOG_EVENTS_CHANGED_EVENT));

assert.equal(refreshCalls, 1);
assert.equal(displayedSummary.value, '高速区間（厚木ICから）');

cleanupSecondMount();
target.dispatchEvent(new Event(TRACKLOG_EVENTS_CHANGED_EVENT));
assert.equal(refreshCalls, 1, 'cleanup removes the Home refresh listener');

console.log('homeEventsRefresh tests passed');
