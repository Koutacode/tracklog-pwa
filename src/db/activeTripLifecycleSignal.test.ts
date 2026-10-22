import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { withRemoteSyncSignalsSuppressed } from '../app/remoteSyncSignal';
import { TRACKLOG_EVENTS_CHANGED_EVENT } from '../services/localEventsChanged';
import { db } from './db';
import { endTrip, getActiveTripId, startTrip } from './repositories';

async function main() {
  const priorWindow = globalThis.window;
  const eventTarget = new EventTarget();
  Object.assign(globalThis, { window: eventTarget });
  let notices = 0;
  eventTarget.addEventListener(TRACKLOG_EVENTS_CHANGED_EVENT, () => { notices += 1; });

  try {
    await withRemoteSyncSignalsSuppressed(async () => {
      await db.open();
      const { tripId } = await startTrip({
        odoKm: 100, occurredAt: '2026-10-22T01:00:00.000Z',
      });
      assert.equal(await getActiveTripId(), tripId);
      assert.equal(notices, 1, 'committed trip start refreshes mounted active-trip gates');

      await assert.rejects(startTrip({ odoKm: 101 }), /進行中/);
      assert.equal(notices, 1, 'rejected trip start emits no lifecycle change');

      await endTrip({ tripId, odoEndKm: 110, occurredAt: '2026-10-22T02:00:00.000Z' });
      assert.equal(await getActiveTripId(), null);
      assert.equal(notices, 2, 'committed trip end refreshes mounted active-trip gates');

      await assert.rejects(endTrip({ tripId, odoEndKm: 110 }), /進行中ではありません/);
      assert.equal(notices, 2, 'rejected trip end emits no lifecycle change');
    });
    console.log('activeTripLifecycleSignal: committed start/end notify once; rejected operations are silent');
  } finally {
    await db.delete();
    if (priorWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.assign(globalThis, { window: priorWindow });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
