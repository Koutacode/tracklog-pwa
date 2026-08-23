import assert from 'node:assert/strict';
import {
  createMessageActionSingleFlight,
  handleNativeAdminMessageNotificationAction,
  parseNativeAdminMessageNotificationAction,
} from './nativeAdminMessageActionPolicy';

async function main() {
  const parsed = parseNativeAdminMessageNotificationAction({
    actionId: 'tap',
    notification: {
      extra: {
        kind: 'tracklog-admin',
        messageId: ' message-1 ',
        body: ' 配車変更があります ',
        requestLocation: true,
      },
    },
  }, 'tracklog-admin');
  assert.deepEqual(parsed, {
    messageId: 'message-1',
    body: '配車変更があります',
    requestLocation: true,
    actionId: 'tap',
  });
  assert.equal(
    parseNativeAdminMessageNotificationAction({
      actionId: 'tap',
      notification: {
        extra: {
          kind: 'tracklog-admin',
          messageId: 'message-no-location',
          requestLocation: 'false',
        },
      },
    }, 'tracklog-admin')?.requestLocation,
    false,
    'native bridge string booleans preserve an explicit no-location action',
  );

  const opened: string[] = [];
  const remembered: string[] = [];
  let locationCalls = 0;
  const gate = createMessageActionSingleFlight();
  const handle = () => handleNativeAdminMessageNotificationAction(parsed!, {
    remember: message => remembered.push(message.id),
    openInbox: messageId => opened.push(messageId),
    requestLocation: messageId => gate.run(messageId, async () => {
      locationCalls += 1;
      await Promise.resolve();
      return true;
    }),
    updateLocationActionId: 'update_location',
  });

  await Promise.all([handle(), handle()]);
  assert.deepEqual(remembered, ['message-1', 'message-1'], 'cold-start payload restores the inbox record');
  assert.deepEqual(opened, ['message-1', 'message-1'], 'cold-start tap opens the requested inbox item');
  assert.equal(locationCalls, 1, 'duplicate retained/action delivery requests location only once');
  await handle();
  assert.equal(locationCalls, 1, 'a completed location request remains idempotent');

  let retryCalls = 0;
  const retryGate = createMessageActionSingleFlight();
  assert.equal(await retryGate.run('message-2', async () => {
    retryCalls += 1;
    return false;
  }), false);
  assert.equal(await retryGate.run('message-2', async () => {
    retryCalls += 1;
    return true;
  }), true);
  assert.equal(retryCalls, 2, 'an auth-deferred request can retry once the driver session is ready');

  const durableCompleted = new Set<string>();
  let durableCalls = 0;
  const newProcessGate = () => createMessageActionSingleFlight({
    isCompleted: id => durableCompleted.has(id),
    markCompleted: id => durableCompleted.add(id),
  });
  assert.equal(await newProcessGate().run('message-durable', async () => {
    durableCalls += 1;
    return true;
  }), true);
  assert.equal(await newProcessGate().run('message-durable', async () => {
    durableCalls += 1;
    return true;
  }), true);
  assert.equal(durableCalls, 1, 'a persisted completion suppresses duplicate work after process restart');

  assert.equal(
    parseNativeAdminMessageNotificationAction({
      actionId: 'tap',
      notification: { extra: { kind: 'other', messageId: 'message-3' } },
    }, 'tracklog-admin'),
    null,
    'another feature notification is ignored',
  );

  console.log('nativeAdminMessageActionPolicy: cold-start routing and retryable exactly-once assertions passed');
}

void main();
