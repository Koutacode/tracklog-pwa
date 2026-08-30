import assert from 'node:assert/strict';
import {
  buildNativeSetupReadiness,
  classifyNativeSetupStepReturn,
  completeNativeNotificationSetup,
  selectNativeNotificationSetupAction,
  shouldRequestBackgroundLocationDirectly,
  type NativeSetupSnapshot,
} from './nativeSetup';

function snapshot(overrides: Partial<NativeSetupSnapshot> = {}): NativeSetupSnapshot {
  return {
    androidSdkInt: 36,
    locationEnabled: true,
    fine: true,
    coarse: true,
    foreground: true,
    background: true,
    backgroundRelevant: true,
    backgroundPermissionOptionLabel: '常に許可',
    notifications: true,
    residentNotificationChannelExists: true,
    residentNotificationChannelEnabled: true,
    batteryOptimization: true,
    residentRunning: true,
    approved: true,
    setupComplete: true,
    authorizationConfigured: true,
    ...overrides,
  };
}

const ready = buildNativeSetupReadiness(snapshot());
assert.equal(ready.ready, true);
assert.equal(ready.permissionsReady, true);
assert.equal(ready.activeStep, null);
assert.equal(ready.remaining, 0);
assert.deepEqual(
  ready.steps.map(step => step.id),
  [
    'location-enabled',
    'location-precise',
    'location-background',
    'notification',
    'battery-opt',
    'resident-service',
  ],
  'setup order contains only settings required by current tracking behavior',
);

const locationOff = buildNativeSetupReadiness(snapshot({ locationEnabled: false }));
assert.equal(locationOff.activeStep?.id, 'location-enabled');
assert.equal(locationOff.permissionsReady, false);

const approximateOnly = buildNativeSetupReadiness(snapshot({ fine: false, coarse: true }));
assert.equal(approximateOnly.activeStep?.id, 'location-precise');
assert.match(approximateOnly.activeStep?.detail ?? '', /概算/);

const backgroundMissing = buildNativeSetupReadiness(snapshot({ background: false }));
assert.equal(backgroundMissing.activeStep?.id, 'location-background');
const localizedBackground = buildNativeSetupReadiness(snapshot({
  background: false,
  backgroundPermissionOptionLabel: 'Allow all the time',
}));
assert.match(
  localizedBackground.activeStep?.instruction ?? '',
  /Allow all the time/,
  'Android 11+ uses the device-localized background permission option label',
);

const servicePending = buildNativeSetupReadiness(snapshot({ residentRunning: false }));
assert.equal(servicePending.permissionsReady, true, 'physical settings may bootstrap the resident service');
assert.equal(servicePending.ready, false, 'home remains gated until the resident service is observed running');
assert.equal(servicePending.activeStep?.id, 'resident-service');

const missingResidentChannel = buildNativeSetupReadiness(snapshot({
  residentRunning: false,
  residentNotificationChannelExists: false,
  residentNotificationChannelEnabled: false,
}));
assert.equal(
  missingResidentChannel.permissionsReady,
  true,
  'a not-yet-created Android 8+ channel may bootstrap by starting the resident service',
);
assert.equal(missingResidentChannel.activeStep?.id, 'resident-service');
assert.equal(missingResidentChannel.ready, false, 'final readiness waits for the created channel');

const disabledResidentChannel = buildNativeSetupReadiness(snapshot({
  residentNotificationChannelExists: true,
  residentNotificationChannelEnabled: false,
}));
assert.equal(disabledResidentChannel.ready, false);
assert.equal(disabledResidentChannel.permissionsReady, false);
assert.equal(disabledResidentChannel.activeStep?.id, 'notification');
assert.match(
  disabledResidentChannel.activeStep?.detail ?? '',
  /位置記録中.*無効/,
  'a disabled foreground-service channel is never accepted as resident readiness',
);

const preAndroid8WithoutChannel = buildNativeSetupReadiness(snapshot({
  androidSdkInt: 25,
  residentNotificationChannelExists: false,
  residentNotificationChannelEnabled: false,
}));
assert.equal(preAndroid8WithoutChannel.ready, true, 'Android 7 and earlier have no channel requirement');

const preAndroid10 = buildNativeSetupReadiness(snapshot({
  androidSdkInt: 28,
  backgroundRelevant: false,
  background: false,
}));
assert.equal(preAndroid10.steps.find(step => step.id === 'location-background')?.level, 'ok');

assert.equal(shouldRequestBackgroundLocationDirectly(snapshot({
  androidSdkInt: 29,
  background: false,
})), true, 'Android 10 requests background location alone after precise foreground permission');
assert.equal(shouldRequestBackgroundLocationDirectly(snapshot({
  androidSdkInt: 30,
  background: false,
})), false, 'Android 11+ uses app settings for the background grant');
assert.equal(shouldRequestBackgroundLocationDirectly(snapshot({
  androidSdkInt: 29,
  fine: false,
  background: false,
})), false, 'background permission is never requested before precise foreground permission');

assert.equal(classifyNativeSetupStepReturn('notification', 'notification'), 'unchanged');
assert.equal(classifyNativeSetupStepReturn('notification', 'battery-opt'), 'advanced');
assert.equal(classifyNativeSetupStepReturn('resident-service', null), 'complete');

assert.equal(selectNativeNotificationSetupAction({
  permission: 'prompt',
  notificationsEnabled: false,
  requestAttempted: false,
}), 'request-permission', 'Android 13 initial prompt reaches the OS permission dialog');
assert.equal(selectNativeNotificationSetupAction({
  permission: 'denied',
  notificationsEnabled: false,
  requestAttempted: true,
}), 'open-settings', 'a refusal continues to the app notification settings');
assert.equal(selectNativeNotificationSetupAction({
  permission: 'granted',
  notificationsEnabled: true,
  requestAttempted: true,
}), 'complete');
assert.equal(selectNativeNotificationSetupAction({
  permission: 'granted',
  notificationsEnabled: false,
  requestAttempted: false,
}), 'open-settings', 'disabled app notifications override the granted runtime permission');

async function testNotificationPermissionFlow() {
  let notificationReads = 0;
  let notificationRequests = 0;
  let notificationSettingsOpens = 0;
  const refusedNotification = await completeNativeNotificationSetup({
    readState: async () => {
      notificationReads += 1;
      return notificationReads === 1
        ? { permission: 'prompt', notificationsEnabled: false }
        : { permission: 'denied', notificationsEnabled: false };
    },
    requestPermission: async () => {
      notificationRequests += 1;
    },
    openSettings: async () => {
      notificationSettingsOpens += 1;
      return { opened: true, destination: 'app-notifications', fallbackLevel: 0 };
    },
  });
  assert.equal(notificationRequests, 1, 'initial prompt invokes the OS permission request exactly once');
  assert.equal(notificationSettingsOpens, 1, 'refusal opens the app notification settings');
  assert.equal(refusedNotification.destination, 'app-notifications');
}

void testNotificationPermissionFlow().then(() => {
  console.log('nativeSetup: ordered staged readiness and resident-service handshake assertions passed');
}).catch(error => {
  globalThis.setTimeout(() => { throw error; }, 0);
});
