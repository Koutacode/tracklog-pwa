import assert from 'node:assert/strict';
import {
  createNativeLocalNotificationActionDispatcher,
  type NativeLocalNotificationActionEvent,
} from './nativeLocalNotificationActionDispatcher';

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

async function main() {
  let registerCalls = 0;
  let listener: ((event: NativeLocalNotificationActionEvent) => void) | null = null;
  const handled: string[] = [];
  const dispatcher = createNativeLocalNotificationActionDispatcher({
    register: async next => {
      registerCalls += 1;
      listener = next;
    },
    handlers: [
      async event => {
        const extra = event.notification?.extra as Record<string, unknown> | undefined;
        if (extra?.kind !== 'expressway_end_prompt_v1') return false;
        handled.push(`expressway:${String(extra.tripId)}`);
        return true;
      },
      async event => {
        const extra = event.notification?.extra as Record<string, unknown> | undefined;
        if (extra?.kind !== 'tracklog_admin_message_v1') return false;
        handled.push(`admin:${String(extra.messageId)}`);
        return true;
      },
    ],
  });

  await Promise.all([dispatcher.initialize(), dispatcher.initialize(), dispatcher.initialize()]);
  assert.equal(registerCalls, 1, 'concurrent cold-start initialization registers one native listener');
  const deliver = (event: NativeLocalNotificationActionEvent) => {
    const current = listener;
    assert.ok(current, 'the shared notification listener is ready');
    current(event);
  };

  const adminTap = {
    actionId: 'tap',
    notification: {
      id: 740001,
      extra: { kind: 'tracklog_admin_message_v1', messageId: 'admin-1' },
    },
  };
  deliver(adminTap);
  deliver(adminTap);
  await flush();
  assert.deepEqual(handled, ['admin:admin-1'], 'a duplicate retained admin action is handled once');

  deliver({
    actionId: 'end_expressway',
    notification: {
      id: 610001,
      extra: {
        kind: 'expressway_end_prompt_v1',
        tripId: 'trip-1',
        detectedAt: '2026-08-23T10:00:00.000Z',
      },
    },
  });
  await flush();
  assert.deepEqual(
    handled,
    ['admin:admin-1', 'expressway:trip-1'],
    'the same first listener dispatches a retained expressway action after an admin action',
  );

  deliver({
    actionId: 'tap',
    notification: { id: 1, extra: { kind: 'unknown', messageId: 'unknown-1' } },
  });
  await flush();
  assert.equal(handled.length, 2, 'unknown notification kinds are ignored without reaching another handler');
  await dispatcher.initialize();
  assert.equal(registerCalls, 1, 'resume initialization remains idempotent');

  let retryRegistrations = 0;
  const retryDispatcher = createNativeLocalNotificationActionDispatcher({
    register: async () => {
      retryRegistrations += 1;
      if (retryRegistrations === 1) throw new Error('simulated bridge startup race');
    },
    handlers: [],
  });
  await assert.rejects(retryDispatcher.initialize());
  await retryDispatcher.initialize();
  assert.equal(retryRegistrations, 2, 'a failed cold-start registration retries on resume');

  console.log('nativeLocalNotificationActionDispatcher: shared cold-start and exactly-once assertions passed');
}

void main();
