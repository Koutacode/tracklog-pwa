import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { db } from '../db/db';
import {
  startTrip, endTrip, getActiveTripId, completeTripStartLocation, getLatestRoutePointForTrip,
} from '../db/repositories';
import { getGeo } from './geo';
import { cancelActiveTripLocationRequests } from './activeTripLocation';
import { selectRecordedTripEndGeo } from './tripEndLocation';

let fixCalls = 0;
let clearCalls = 0;
let onFix: ((position: GeolocationPosition) => void) | null = null;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { geolocation: { watchPosition: (success: (position: GeolocationPosition) => void) => {
    fixCalls += 1;
    onFix = success;
    return fixCalls;
  }, clearWatch: () => { clearCalls += 1; } } },
});
const syntheticGeo = { lat: 35, lng: 139, accuracy: 5 };
const position = { coords: { latitude: 35, longitude: 139, accuracy: 5 } } as GeolocationPosition;
async function waitForFix() {
  for (let i = 0; i < 100 && !onFix; i += 1) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(onFix, 'an active trip requests a fix');
}

async function main() {
await db.delete();
await db.open();
try {
  assert.equal(await getGeo(), undefined);
  assert.equal(fixCalls, 0, 'opening Home outside a trip cannot start GPS');
  const started = await startTrip({ odoKm: 100 });
  assert.equal(await getActiveTripId(), started.tripId);
  const pending = getGeo();
  await waitForFix();
  onFix!(position);
  assert.deepEqual(await pending, syntheticGeo);
  assert.equal(clearCalls, 1, 'one-shot acquisition releases its provider after the first fix');
  assert.equal(await completeTripStartLocation({
    tripId: started.tripId, eventId: started.event.id, expectedTimestamp: started.event.ts,
    geo: syntheticGeo,
  }), true);
  assert.deepEqual((await db.events.get(started.event.id))?.geo, syntheticGeo);
  assert.equal((await db.routePoints.get(`event-anchor-${started.event.id}`))?.source, 'event');
  assert.equal(await completeTripStartLocation({
    tripId: started.tripId, eventId: started.event.id, expectedTimestamp: started.event.ts,
    geo: { ...syntheticGeo, lat: 36 },
  }), false, 'late completion cannot overwrite an existing location');

  onFix = null;
  const beforeEnd = getGeo();
  await waitForFix();
  await endTrip({ tripId: started.tripId, odoEndKm: 101 });
  cancelActiveTripLocationRequests();
  assert.equal(clearCalls, 2, 'trip end cancels an outstanding provider subscription');
  onFix!(position);
  assert.equal(await beforeEnd, undefined, 'a fix arriving after trip end is discarded');
  const requestsAtEnd = fixCalls;
  assert.equal(await getGeo(), undefined);
  assert.equal(fixCalls, requestsAtEnd, 'no acquisition after trip end');
  assert.equal(await completeTripStartLocation({
    tripId: started.tripId, eventId: started.event.id, expectedTimestamp: started.event.ts,
    geo: syntheticGeo,
  }), false);

  const atMs = Date.parse('2026-09-18T00:00:00Z');
  const recorded = (tripId: string, ageMs: number, accuracy = 5) => ({
    tripId, ts: new Date(atMs - ageMs).toISOString(), ...syntheticGeo, accuracy,
  });
  assert.deepEqual(selectRecordedTripEndGeo('trip', atMs, [
    recorded('other-trip', 0), recorded('trip', 10_000), recorded('trip', 30_000, 10),
  ]), syntheticGeo);
  assert.equal(selectRecordedTripEndGeo('trip', atMs, [
    recorded('other-trip', 0), recorded('trip', 120_001), recorded('trip', -1), recorded('trip', 1000, 151),
    { ...recorded('trip', 0), source: 'event' },
  ]), undefined, 'stale, future, inaccurate and other-trip fixes are never reused');
  await db.routePoints.bulkPut([
    { ...recorded('trip', 50_000), id: 'valid-fix', source: 'background' },
    { ...recorded('trip', 0), id: 'new-event-old-geo', source: 'event' },
    { ...recorded('trip', -1), id: 'future-fix', source: 'background' },
    { ...recorded('trip', 1000, 151), id: 'inaccurate-fix', source: 'background' },
  ]);
  assert.equal((await getLatestRoutePointForTrip('trip', atMs))?.id, 'valid-fix',
    'a newer invalid fix or event anchor does not hide the latest real fix');
  console.log('Trip location privacy: idle, active, end race, start enrichment, cached end position passed');
} finally {
  await db.delete();
}
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
