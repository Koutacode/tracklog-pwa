import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { withRemoteSyncSignalsSuppressed } from '../app/remoteSyncSignal';
import { db } from './db';
import {
  STALE_NATIVE_EXPRESSWAY_DETECTION_ERROR,
  clearPendingExpresswayEndPromptIfMatches,
  endExpressway,
  getPendingExpresswayEndPrompt,
  setPendingExpresswayEndPrompt,
  type AutoExpresswayDecisionReason,
} from './repositories';

const tripId = 'synthetic-replay-trip';
const oldAt = '2026-08-23T01:00:00.000Z';
const oldGeo = { lat: 10, lng: 20, accuracy: 10 };
const reason = (id: string, evaluatedAt: string): AutoExpresswayDecisionReason => ({
  source: 'native-auto', action: 'end-prompt', nativeDetectionId: id,
  nativeGeneration: id === 'old-end' ? 2 : 3,
  evaluatedAt, speedKmh: 18, signalResolved: false,
  onExpresswayRoad: false, nearIc: false, nearEtcGate: false,
  config: { startSpeedKmh: 78, startDurationSec: 6, endSpeedKmh: 34, endDurationSec: 24 },
});

async function run() {
await withRemoteSyncSignalsSuppressed(async () => {
  await db.events.clear();
  await db.routePoints.clear();
  await db.meta.clear();
  await db.events.bulkPut([
    { id: 'trip-start', tripId, type: 'trip_start',
      ts: '2026-08-23T00:00:00.000Z', syncStatus: 'pending', extras: { odoKm: 0 } },
    { id: 'expressway-start', tripId, type: 'expressway_start',
      ts: '2026-08-23T00:30:00.000Z', syncStatus: 'pending',
      extras: { expresswaySessionId: 'synthetic-session' } },
  ]);
  await db.routePoints.put({ id: 'new-real-fix', tripId,
    ts: '2026-08-23T01:06:00.000Z', lat: 10, lng: 20.05,
    accuracy: 10, source: 'background' });
  await assert.rejects(endExpressway({ tripId, geo: oldGeo,
    occurredAt: '2026-08-23T01:07:00.000Z', autoDecision: reason('old-end', oldAt),
    source: 'automatic_detection', automaticConfirmation: 'confirmed',
  }), error => error instanceof Error && error.message === STALE_NATIVE_EXPRESSWAY_DETECTION_ERROR);
  assert.equal((await db.events.where('type').equals('expressway_end').count()), 0,
    'a moved prompt cannot create an expressway end');
  assert.equal((await db.routePoints.toArray()).filter(point => point.source === 'event').length, 0,
    'a moved prompt cannot create an event anchor');

  await db.routePoints.clear();
  await db.events.bulkPut([
    { id: 'rest-start', tripId, type: 'rest_start',
      ts: '2026-08-23T01:01:00.000Z', syncStatus: 'pending',
      extras: { restSessionId: 'synthetic-rest' } },
    { id: 'rest-end', tripId, type: 'rest_end',
      ts: '2026-08-23T01:02:00.000Z', syncStatus: 'pending',
      extras: { restSessionId: 'synthetic-rest' } },
  ]);
  await assert.rejects(endExpressway({ tripId, geo: oldGeo,
    occurredAt: '2026-08-23T01:04:00.000Z', autoDecision: reason('old-end', oldAt),
    source: 'automatic_detection', automaticConfirmation: 'confirmed',
  }), error => error instanceof Error && error.message === STALE_NATIVE_EXPRESSWAY_DETECTION_ERROR);
  assert.equal((await db.events.where('type').equals('expressway_end').count()), 0,
    'a rest boundary rejects an old confirmation even without GPS');
  await db.routePoints.put({ id: 'fresh-real-fix', tripId,
    ts: '2026-08-23T01:06:30.000Z', lat: 10, lng: 20.05,
    accuracy: 10, source: 'background' });

  const fresh = { tripId, geo: { lat: 10, lng: 20.05, accuracy: 10 },
    occurredAt: '2026-08-23T01:07:00.000Z',
    autoDecision: reason('fresh-end', '2026-08-23T01:06:30.000Z'),
    source: 'automatic_detection' as const, automaticConfirmation: 'confirmed' as const };
  const first = await endExpressway(fresh);
  const repeated = await endExpressway(fresh);
  assert.equal(first.created, true, 'a fresh exit still ends normally');
  assert.equal(repeated.created, false, 'native/Web replay stays idempotent');
  assert.equal(repeated.eventId, first.eventId);
  assert.equal((await db.routePoints.toArray()).filter(point => point.source === 'event').length, 1,
    'only the fresh confirmed end receives an event anchor');
  await setPendingExpresswayEndPrompt({ tripId, promptId: 'new-prompt',
    speedKmh: 10, detectedAt: '2026-08-23T01:08:00.000Z',
    geo: { lat: 10, lng: 20.05 } });
  assert.equal(await clearPendingExpresswayEndPromptIfMatches({
    tripId, promptId: 'old-prompt', detectedAt: oldAt,
  }), false, 'stale Web action cannot clear a newer prompt');
  assert.equal((await getPendingExpresswayEndPrompt())?.promptId, 'new-prompt');
  await clearPendingExpresswayEndPromptIfMatches({
    tripId, promptId: 'new-prompt', detectedAt: '2026-08-23T01:08:00.000Z',
  });
});
db.close();
console.log('expresswayPromptFreshness repository: 10 assertions passed');
}
void run().catch(error => { globalThis.setTimeout(() => { throw error; }, 0); });
