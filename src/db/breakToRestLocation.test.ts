import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { projectAutomaticBreakAsRest } from '../domain/metrics';
import type { RoutePoint } from '../domain/types';
import { db } from './db';
import { confirmBreakToRest, getEventsByTripId, setBreakToRestPromptDecision } from './repositories';

const breakTs = '2026-06-01T00:00:00.000Z';
const threshold = '2026-06-01T03:00:00.000Z';
const lateConfirmation = '2026-06-01T07:00:00.000Z';
const recent = '2026-06-01T02:59:40.000Z';
const breakGeo = { lat: 1, lng: 2 };
const thresholdGeo = { lat: 3, lng: 4, accuracy: 12 };

async function verifyConfirmation(withFix: boolean) {
  const tripId = withFix ? 'test-with-fix' : 'test-without-fix';
  const breakStartId = tripId + '-break';
  await db.events.bulkPut([
    { id: tripId + '-start', tripId, type: 'trip_start', ts: '2026-05-31T23:00:00.000Z', syncStatus: 'synced', extras: { odoKm: 12 } },
    { id: breakStartId, tripId, type: 'break_start', ts: breakTs, syncStatus: 'synced', extras: { breakSessionId: breakStartId }, geo: breakGeo, address: '合成の休憩開始地点' },
  ]);
  const point = { tripId, lat: 5, lng: 6, source: 'foreground' as const };
  const points: RoutePoint[] = [
    { ...point, id: tripId + '-old', ts: '2026-06-01T02:57:59.999Z' },
    { ...point, id: tripId + '-event', ts: threshold, source: 'event' },
    { ...point, id: tripId + '-other-trip', ts: threshold, tripId: 'unrelated' },
    { ...point, id: tripId + '-inaccurate', ts: threshold, accuracy: 500 },
    { ...point, id: tripId + '-late', ts: lateConfirmation },
  ];
  if (withFix) points.push({ ...point, ...thresholdGeo, id: tripId + '-recent', ts: recent });
  await db.routePoints.bulkPut(points);

  const params = { tripId, breakStartId, evaluatedAt: lateConfirmation, odoKm: 12 };
  await setBreakToRestPromptDecision({ ...params, decision: 'approved' });
  const attempts = await Promise.all([confirmBreakToRest(params), confirmBreakToRest(params)]);
  assert.equal(attempts.filter(attempt => attempt.transitioned).length, 1);

  const events = await getEventsByTripId(tripId);
  const boundary = events.filter(event => event.type === 'break_end' || event.type === 'rest_start');
  assert.equal(boundary.length, 2);
  for (const event of boundary) {
    assert.equal(event.ts, threshold);
    assert.deepEqual(event.geo, withFix ? thresholdGeo : undefined);
    assert.equal(event.extras?.breakThresholdLocationTs, withFix ? recent : undefined);
    assert.equal(event.address, undefined, 'a previous or later address is not a measured threshold address');
  }
  assert.equal(await db.routePoints.where('tripId').equals(tripId).count(), points.length - 1,
    'confirming historical events does not duplicate route points');

  // Simulate address backfill for the measured boundary. Views which move the
  // rest back to breakTs must still use the original break location.
  if (withFix) {
    const named = events.map(event => event.type === 'rest_start' ? { ...event, address: '合成の切替地点' } : event);
    const projected = projectAutomaticBreakAsRest(named).find(event => event.type === 'rest_start');
    assert.equal(projected?.ts, breakTs);
    assert.equal(projected?.address, '合成の休憩開始地点');
    assert.deepEqual(projected?.geo, breakGeo);
    assert.equal(projected?.extras?.breakThresholdLocationTs, undefined);
  }
}

async function run() {
  try {
    await verifyConfirmation(true);
    await verifyConfirmation(false);
  } finally {
    await db.delete();
  }
}

void run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
