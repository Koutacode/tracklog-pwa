import assert from 'node:assert/strict';
import type { AppEvent, EventType } from '../../domain/types';
import {
  planEventTypeConversion,
  type EventTypeConversionPlan,
} from '../../domain/eventTypeConversion';
import {
  PERSISTED_BASIC_TOGGLE_DEFINITIONS,
  resolveTogglePairing,
} from '../../domain/togglePairing';
import { commitTripDetailOperationalMutation } from './tripDetailOperationalMutation';

function event(id: string, type: EventType, extras: Record<string, unknown>): AppEvent {
  return {
    id,
    tripId: 'active-trip',
    type,
    ts: '2026-08-30T01:00:00.000Z',
    syncStatus: 'synced',
    extras,
  } as AppEvent;
}

function applyPlan(events: AppEvent[], plan: EventTypeConversionPlan): AppEvent[] {
  const updates = new Map(plan.updates.map(update => [update.id, update]));
  return events.map(current => {
    const update = updates.get(current.id);
    return update
      ? { ...current, type: update.type, extras: update.extras } as AppEvent
      : current;
  });
}

async function run() {
// Active rest -> break: route capture wakes only after the corrected event is
// committed and TripDetail has reloaded its committed snapshot.
{
  const calls: string[] = [];
  let events = [event('active-rest', 'rest_start', {
    restSessionId: 'rest-session',
    odoKm: 1200,
    reportMinDurationMinutes: 15,
  })];
  const result = await commitTripDetailOperationalMutation({
    mutate: async () => {
      calls.push('commit:rest-to-break');
      events = applyPlan(events, planEventTypeConversion(
        events,
        'active-rest',
        'break_start',
        () => 'generated',
      ));
      return 'saved';
    },
    reload: async () => {
      calls.push('reload:break-open');
      const open = resolveTogglePairing(events, PERSISTED_BASIC_TOGGLE_DEFINITIONS).openStarts;
      assert.deepEqual(open.map(item => item.start.type), ['break_start']);
    },
    requestRouteTrackingSync: () => {
      calls.push('sync:resume-route');
    },
  });
  assert.equal(result, 'saved');
  assert.deepEqual(calls, [
    'commit:rest-to-break',
    'reload:break-open',
    'sync:resume-route',
  ]);
}

// An open basic-type conversion follows the same immediate reconciliation path.
{
  const calls: string[] = [];
  let events = [event('active-load', 'load_start', {
    loadSessionId: 'load-session',
    reportMinDurationMinutes: 15,
  })];
  await commitTripDetailOperationalMutation({
    mutate: async () => {
      calls.push('commit:load-to-unload');
      events = applyPlan(events, planEventTypeConversion(
        events,
        'active-load',
        'unload_start',
        () => 'generated',
      ));
    },
    reload: async () => {
      calls.push('reload:unload-open');
      const open = resolveTogglePairing(events, PERSISTED_BASIC_TOGGLE_DEFINITIONS).openStarts;
      assert.deepEqual(open.map(item => item.start.type), ['unload_start']);
    },
    requestRouteTrackingSync: () => {
      calls.push('sync:open-basic');
    },
  });
  assert.deepEqual(calls, [
    'commit:load-to-unload',
    'reload:unload-open',
    'sync:open-basic',
  ]);
}

// Failed persistence cannot have changed durable activity state, so it must not
// reload or issue a misleading tracking transition.
{
  const calls: string[] = [];
  await assert.rejects(
    commitTripDetailOperationalMutation({
      mutate: async () => {
        calls.push('commit:failed');
        throw new Error('save rejected');
      },
      reload: async () => {
        calls.push('reload');
      },
      requestRouteTrackingSync: () => {
        calls.push('sync');
      },
    }),
    /save rejected/,
  );
  assert.deepEqual(calls, ['commit:failed']);
}

// The mutation may already be committed when UI reload fails. Native
// reconciliation remains mandatory while the original error is propagated.
{
  const calls: string[] = [];
  await assert.rejects(
    commitTripDetailOperationalMutation({
      mutate: async () => {
        calls.push('commit');
      },
      reload: async () => {
        calls.push('reload:failed');
        throw new Error('reload failed');
      },
      requestRouteTrackingSync: () => {
        calls.push('sync:after-reload-attempt');
      },
    }),
    /reload failed/,
  );
  assert.deepEqual(calls, ['commit', 'reload:failed', 'sync:after-reload-attempt']);
}

  console.log('tripDetailOperationalMutation: commit/reload/immediate-sync assertions passed');
}

void run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
