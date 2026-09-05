import type { AppEvent, DayRun } from '../../domain/types';
import {
  buildTripDetailReportSnapshot,
  buildTripDetailReportSnapshotSignature,
  createTripDetailReportSnapshotPersistence,
} from './tripDetailReportSnapshot';

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected=${String(expected)} actual=${String(actual)}`);
}

const tripId = 'trip-report-snapshot';
const events = [
  {
    id: 'start',
    tripId,
    type: 'trip_start',
    ts: '2026-09-04T00:00:00.000Z',
    extras: { odoKm: 100 },
  },
  {
    id: 'fuel',
    tripId,
    type: 'refuel',
    ts: '2026-09-04T01:00:00.000Z',
    extras: { liters: 40 },
  },
] as AppEvent[];
const dayRuns = [{ dayIndex: 1, dateKey: '2026-09-04', km: 0 }] as DayRun[];
const source = { tripId, events, dayRuns, fallbackLabel: '2026-09-04 の運行' };

const signature = buildTripDetailReportSnapshotSignature(source);
assertEqual(
  buildTripDetailReportSnapshotSignature(source),
  signature,
  'unchanged source keeps the same write-deduplication signature',
);
assertEqual(
  buildTripDetailReportSnapshotSignature({
    ...source,
    events: events.map(event => event.id === 'fuel' ? { ...event, extras: { liters: 41 } } : event),
  }) === signature,
  false,
  'a refuel edit changes the write-deduplication signature',
);

const preserved = buildTripDetailReportSnapshot(source, '会社提出用', '2026-09-04T02:00:00.000Z');
assertEqual(preserved.label, '会社提出用', 'an existing report label is preserved');
assertEqual(preserved.id, tripId, 'snapshot keeps the trip identifier');

const fallback = buildTripDetailReportSnapshot(source, '', '2026-09-04T02:00:00.000Z');
assertEqual(fallback.label, source.fallbackLabel, 'a missing report label uses the trip detail fallback');

async function runAsyncAssertions() {
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const orderedSaves: string[] = [];
let releaseFirstSave: (() => void) | undefined;
const firstSaveGate = new Promise<void>(resolve => {
  releaseFirstSave = resolve;
});
const orderingPersistence = createTripDetailReportSnapshotPersistence({
  loadExistingLabel: async () => undefined,
  saveSnapshot: async snapshot => {
    orderedSaves.push(snapshot.label);
    if (snapshot.label === 'older') await firstSaveGate;
  },
  now: () => '2026-09-04T02:00:00.000Z',
  scheduleRetry: callback => setTimeout(callback, 0),
  cancelRetry: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  onPermanentFailure: () => undefined,
});
orderingPersistence.enqueue({ ...source, fallbackLabel: 'older' });
await flush();
orderingPersistence.enqueue({
  ...source,
  events: events.map(event => event.id === 'fuel' ? { ...event, extras: { liters: 41 } } : event),
  fallbackLabel: 'newer',
});
await flush();
assertEqual(orderedSaves.join(','), 'older', 'a newer snapshot never writes over an in-flight older save');
releaseFirstSave?.();
await flush();
await flush();
assertEqual(orderedSaves.join(','), 'older,newer', 'the latest snapshot writes after the older save completes');
orderingPersistence.enqueue({
  ...source,
  events: events.map(event => event.id === 'fuel' ? { ...event, extras: { liters: 41 } } : event),
  fallbackLabel: 'newer',
});
await flush();
assertEqual(orderedSaves.length, 2, 'a successfully persisted signature is deduplicated');
orderingPersistence.dispose();

let retryAttempts = 0;
let permanentFailures = 0;
const retryCallbacks: Array<() => void> = [];
const retryPersistence = createTripDetailReportSnapshotPersistence({
  loadExistingLabel: async () => undefined,
  saveSnapshot: async () => {
    retryAttempts += 1;
    if (retryAttempts === 1) throw new Error('transient');
  },
  now: () => '2026-09-04T02:00:00.000Z',
  scheduleRetry: callback => {
    retryCallbacks.push(callback);
    return callback;
  },
  cancelRetry: handle => {
    const index = retryCallbacks.indexOf(handle as () => void);
    if (index >= 0) retryCallbacks.splice(index, 1);
  },
  onPermanentFailure: () => {
    permanentFailures += 1;
  },
});
retryPersistence.enqueue(source);
await flush();
assertEqual(retryAttempts, 1, 'the initial transient save is attempted once');
assertEqual(retryCallbacks.length, 1, 'a transient failure schedules one bounded retry');
retryCallbacks.shift()?.();
await flush();
assertEqual(retryAttempts, 2, 'the scheduled retry performs a second save attempt');
assertEqual(permanentFailures, 0, 'a successful retry does not report a permanent failure');
retryPersistence.enqueue(source);
await flush();
assertEqual(retryAttempts, 2, 'the signature is marked persisted only after the retry succeeds');
retryPersistence.dispose();

let boundedAttempts = 0;
let boundedFailures = 0;
const boundedCallbacks: Array<() => void> = [];
const boundedPersistence = createTripDetailReportSnapshotPersistence({
  loadExistingLabel: async () => undefined,
  saveSnapshot: async () => {
    boundedAttempts += 1;
    throw new Error('persistent');
  },
  now: () => '2026-09-04T02:00:00.000Z',
  scheduleRetry: callback => {
    boundedCallbacks.push(callback);
    return callback;
  },
  cancelRetry: () => undefined,
  onPermanentFailure: () => {
    boundedFailures += 1;
  },
});
boundedPersistence.enqueue(source);
await flush();
boundedCallbacks.shift()?.();
await flush();
assertEqual(boundedAttempts, 2, 'persistent failure is limited to the initial attempt and one retry');
assertEqual(boundedCallbacks.length, 0, 'persistent failure does not create an unbounded retry loop');
assertEqual(boundedFailures, 1, 'persistent failure emits one generic terminal notification');
boundedPersistence.dispose();

console.log('tripDetailReportSnapshot: 16 assertions passed');
}

void runAsyncAssertions().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
