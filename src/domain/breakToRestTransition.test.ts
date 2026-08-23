import assert from 'node:assert/strict';
import {
  AUTO_REST_REASON_BREAK_THRESHOLD,
  buildBreakToRestTransition,
  computeSegments,
  getOpenBreakToRestThresholdTs,
  isRestStartOdoCheckpoint,
  projectAutomaticBreakAsRest,
} from './metrics';
import {
  attachBreakToRestOdometer,
  canCloseDueBreakAfterConfirmation,
  createStoredBreakToRestConfirmation,
  findDueBreakToRestCandidate,
  normalizeOptionalRestStartOdometer,
  parseStoredBreakToRestConfirmation,
  resolveBreakToRestRoutePauseAt,
  serializeStoredBreakToRestConfirmation,
} from './breakToRestConfirmation';
import type { AppEvent, RestStartEvent } from './types';

const tripId = 'trip-break-threshold';
const breakStartTs = '2026-07-17T00:00:00.000Z';
const breakSessionId = 'break-session-1';

function openBreakEvents(): AppEvent[] {
  return [
    {
      id: 'trip-start-1',
      tripId,
      type: 'trip_start',
      ts: '2026-07-16T23:00:00.000Z',
      syncStatus: 'pending',
      extras: { odoKm: 100 },
    },
    {
      id: 'break-start-1',
      tripId,
      type: 'break_start',
      ts: breakStartTs,
      syncStatus: 'pending',
      extras: { breakSessionId },
    },
  ];
}

assert.equal(
  buildBreakToRestTransition(openBreakEvents(), '2026-07-17T02:59:59.000Z'),
  null,
  '179:59 must remain break time',
);
assert.equal(
  findDueBreakToRestCandidate(openBreakEvents(), '2026-07-17T02:59:59.999Z'),
  null,
  'the confirmation must not become pending before the exact threshold',
);
assert.equal(
  getOpenBreakToRestThresholdTs(openBreakEvents()),
  '2026-07-17T03:00:00.000Z',
  'native route pause uses the same exact threshold',
);

const atThreshold = buildBreakToRestTransition(
  openBreakEvents(),
  '2026-07-17T03:00:00.000Z',
);
assert.ok(atThreshold, '180:00 must produce a break-to-rest transition');
assert.equal(atThreshold.thresholdTs, '2026-07-17T03:00:00.000Z');
assert.equal(atThreshold.breakEnd.ts, atThreshold.thresholdTs);
assert.equal(atThreshold.restStart.ts, atThreshold.thresholdTs);
assert.equal(atThreshold.breakEnd.extras?.breakSessionId, breakSessionId);
assert.equal(atThreshold.restStart.extras.odoKm, undefined);
assert.equal(atThreshold.restStart.extras.autoReason, AUTO_REST_REASON_BREAK_THRESHOLD);
assert.equal(atThreshold.restStart.extras.generatedFrom, 'break-start-1');

const dueCandidate = findDueBreakToRestCandidate(
  openBreakEvents(),
  '2026-07-17T03:00:00.000Z',
);
assert.ok(dueCandidate, 'the exact threshold must produce a confirmation candidate');
const pendingConfirmation = createStoredBreakToRestConfirmation({
  candidate: dueCandidate,
  status: 'pending',
  updatedAt: '2026-07-17T03:00:00.000Z',
});
const persistedConfirmation = serializeStoredBreakToRestConfirmation(pendingConfirmation);
assert.deepEqual(
  parseStoredBreakToRestConfirmation(persistedConfirmation, dueCandidate),
  pendingConfirmation,
  'pending confirmation survives a serialized meta round trip',
);
const declinedConfirmation = createStoredBreakToRestConfirmation({
  candidate: dueCandidate,
  status: 'declined',
  updatedAt: '2026-07-17T03:01:00.000Z',
});
assert.equal(
  parseStoredBreakToRestConfirmation(
    serializeStoredBreakToRestConfirmation(declinedConfirmation),
    dueCandidate,
  )?.status,
  'declined',
  'a declined decision remains final after restoring meta',
);

const editedTimestampCandidate = findDueBreakToRestCandidate(
  openBreakEvents().map(event => (
    event.id === 'break-start-1'
      ? { ...event, ts: '2026-07-17T00:30:00.000Z' }
      : event
  )),
  '2026-07-17T03:30:00.000Z',
);
assert.ok(editedTimestampCandidate);
assert.equal(
  parseStoredBreakToRestConfirmation(
    serializeStoredBreakToRestConfirmation(declinedConfirmation),
    editedTimestampCandidate,
  )?.status,
  'declined',
  'editing timestamps on the same break-start id must not re-prompt after No',
);

const differentIdCandidate = {
  ...dueCandidate,
  breakStartId: 'break-start-other',
};
assert.equal(
  parseStoredBreakToRestConfirmation(persistedConfirmation, differentIdCandidate),
  null,
  'metadata from a different break-start id must be rejected',
);

const positiveOdoTransition = attachBreakToRestOdometer(atThreshold, 12345);
assert.equal(positiveOdoTransition.restStart.extras.odoKm, 12345);
const zeroOdoTransition = attachBreakToRestOdometer(atThreshold, 0);
assert.equal(
  zeroOdoTransition.restStart.extras.odoKm,
  undefined,
  'zero confirms rest without persisting a distance checkpoint',
);
assert.equal(normalizeOptionalRestStartOdometer(0), undefined);
assert.equal(normalizeOptionalRestStartOdometer(12345), 12345);
assert.equal(canCloseDueBreakAfterConfirmation(null), false);
assert.equal(canCloseDueBreakAfterConfirmation('pending'), false);
assert.equal(canCloseDueBreakAfterConfirmation('approved'), false);
assert.equal(
  canCloseDueBreakAfterConfirmation('declined'),
  true,
  'only an explicit No allows the due break or trip to be closed without conversion',
);
assert.equal(
  resolveBreakToRestRoutePauseAt(dueCandidate.thresholdTs, 'pending'),
  dueCandidate.thresholdTs,
  'native route pause remains at the threshold until the driver answers',
);
assert.equal(
  resolveBreakToRestRoutePauseAt(dueCandidate.thresholdTs, 'approved'),
  dueCandidate.thresholdTs,
  'native route pause remains while the approved ODO entry is pending',
);
assert.equal(
  resolveBreakToRestRoutePauseAt(dueCandidate.thresholdTs, 'declined'),
  null,
  'declining rest conversion resumes future route recording',
);
const editedFutureThreshold = '2026-07-17T04:00:00.000Z';
const restoredDeclinedBeforeEditedThreshold = parseStoredBreakToRestConfirmation(
  serializeStoredBreakToRestConfirmation(declinedConfirmation),
  { ...dueCandidate, breakStartTs: '2026-07-17T01:00:00.000Z', thresholdTs: editedFutureThreshold },
);
assert.equal(restoredDeclinedBeforeEditedThreshold?.status, 'declined');
assert.equal(
  resolveBreakToRestRoutePauseAt(
    editedFutureThreshold,
    restoredDeclinedBeforeEditedThreshold?.status ?? null,
  ),
  null,
  'editing the same declined break before its new threshold must not pause routing again',
);

const persistedTransitionEvents = [
  ...openBreakEvents(),
  atThreshold.breakEnd,
  atThreshold.restStart,
];
const persistedSnapshot = JSON.stringify(persistedTransitionEvents);
const projectedTransitionEvents = projectAutomaticBreakAsRest(persistedTransitionEvents);
assert.deepEqual(
  projectedTransitionEvents.map(event => event.type),
  ['trip_start', 'rest_start'],
  'the confirmed break pair is hidden from the product view',
);
assert.equal(
  projectedTransitionEvents.find(event => event.type === 'rest_start')?.ts,
  breakStartTs,
  'the full break interval is reclassified as rest',
);
assert.equal(
  JSON.stringify(persistedTransitionEvents),
  persistedSnapshot,
  'projection must not mutate persisted event evidence',
);
assert.deepEqual(
  projectAutomaticBreakAsRest(projectedTransitionEvents),
  projectedTransitionEvents,
  'projection is idempotent',
);

const sameInputAgain = buildBreakToRestTransition(
  openBreakEvents(),
  '2026-07-17T04:00:00.000Z',
);
assert.ok(sameInputAgain);
assert.equal(sameInputAgain.thresholdTs, atThreshold.thresholdTs);
assert.equal(sameInputAgain.breakEnd.id, atThreshold.breakEnd.id);
assert.equal(sameInputAgain.restStart.id, atThreshold.restStart.id);
assert.equal(
  sameInputAgain.restStart.extras.restSessionId,
  atThreshold.restStart.extras.restSessionId,
);

const reconciledEvents = [
  ...persistedTransitionEvents,
];
assert.equal(
  buildBreakToRestTransition(reconciledEvents, '2026-07-17T04:00:00.000Z'),
  null,
  'reconciliation must be idempotent after the deterministic pair is applied',
);

const editedBelowThreshold = persistedTransitionEvents.map(event => (
  event.id === 'break-start-1'
    ? { ...event, ts: '2026-07-17T02:00:00.000Z' }
    : event
));
assert.deepEqual(
  projectAutomaticBreakAsRest(editedBelowThreshold),
  editedBelowThreshold,
  'an edited interval shorter than three hours must remain a break despite old auto markers',
);

const endedBreakEvents: AppEvent[] = [
  ...openBreakEvents(),
  {
    id: 'manual-break-end-1',
    tripId,
    type: 'break_end',
    ts: '2026-07-17T02:00:00.000Z',
    syncStatus: 'pending',
    extras: { breakSessionId },
  },
];
assert.equal(
  buildBreakToRestTransition(endedBreakEvents, '2026-07-17T04:00:00.000Z'),
  null,
  'an ended break must not be converted',
);

const incompleteAutomaticTransition = [
  ...openBreakEvents(),
  atThreshold.breakEnd,
];
assert.deepEqual(
  projectAutomaticBreakAsRest(incompleteAutomaticTransition),
  incompleteAutomaticTransition,
  'a missing generated rest start must preserve the raw break evidence',
);

const manualLongBreak: AppEvent[] = [
  ...openBreakEvents(),
  {
    id: 'manual-break-end-long',
    tripId,
    type: 'break_end',
    ts: '2026-07-17T04:00:00.000Z',
    syncStatus: 'pending',
    extras: { breakSessionId },
  },
];
assert.deepEqual(
  projectAutomaticBreakAsRest(manualLongBreak),
  manualLongBreak,
  'a manual long break without generation markers must remain a break',
);

const manualRestStart: RestStartEvent = {
  id: 'manual-rest-start-1',
  tripId,
  type: 'rest_start',
  ts: '2026-07-17T05:00:00.000Z',
  syncStatus: 'pending',
  extras: { restSessionId: 'manual-rest-1', odoKm: 140 },
};
const legacyZeroOdoRestStart: RestStartEvent = {
  ...manualRestStart,
  id: 'legacy-zero-odo-rest-start',
  extras: { ...manualRestStart.extras, odoKm: 0 },
};
assert.equal(
  isRestStartOdoCheckpoint(legacyZeroOdoRestStart),
  false,
  'legacy zero-valued rest rows are treated as distance not recorded',
);
assert.equal(isRestStartOdoCheckpoint(manualRestStart), true);
const segments = computeSegments({
  odoStart: 100,
  tripStartTs: '2026-07-16T23:00:00.000Z',
  restStarts: [atThreshold.restStart, legacyZeroOdoRestStart, manualRestStart],
  tripEnd: { odoEnd: 160, tripEndTs: '2026-07-17T06:00:00.000Z' },
});
assert.deepEqual(
  segments.map(segment => [segment.fromOdo, segment.toOdo, segment.km]),
  [[100, 140, 40], [140, 160, 20]],
  'automatic rest without an odometer must not create a distance checkpoint',
);

console.log('breakToRestTransition: threshold, projection, and odometer assertions passed');
