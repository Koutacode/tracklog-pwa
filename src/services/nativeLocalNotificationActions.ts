import { LocalNotifications, type ActionPerformed } from '@capacitor/local-notifications';
import {
  handleNativeAdminMessageNotificationActionEvent,
  NATIVE_ADMIN_MESSAGE_NOTIFICATION_ACTION_TYPE,
} from './adminMessages';
import {
  handleNativeExpresswayPromptNotificationAction,
  NATIVE_EXPRESSWAY_NOTIFICATION_ACTION_TYPE,
} from './nativeExpresswayPrompt';
import { createNativeLocalNotificationActionDispatcher } from './nativeLocalNotificationActionDispatcher';

const dispatcher = createNativeLocalNotificationActionDispatcher({
  register: listener => LocalNotifications
    .addListener('localNotificationActionPerformed', event => listener(event))
    .then(() => undefined),
  handlers: [
    event => handleNativeExpresswayPromptNotificationAction(event as ActionPerformed),
    event => handleNativeAdminMessageNotificationActionEvent(event as ActionPerformed),
  ],
  onError: () => {
    console.warn('[nativeNotifications] action handling failed');
  },
});

let actionTypesReady = false;
let actionTypesInFlight: Promise<void> | null = null;

async function initNativeLocalNotificationActionTypes() {
  if (actionTypesReady) return;
  if (actionTypesInFlight) return actionTypesInFlight;
  const setup = LocalNotifications.registerActionTypes({
    // Android persists the supplied map as one group; registering each feature
    // separately would overwrite the other feature's actions.
    types: [
      NATIVE_EXPRESSWAY_NOTIFICATION_ACTION_TYPE,
      NATIVE_ADMIN_MESSAGE_NOTIFICATION_ACTION_TYPE,
    ],
  }).then(() => {
    actionTypesReady = true;
  }).finally(() => {
    if (actionTypesInFlight === setup) actionTypesInFlight = null;
  });
  actionTypesInFlight = setup;
  return setup;
}

/** The only LocalNotifications action listener in the WebView process. */
export async function initNativeLocalNotificationActions() {
  // Register the dispatcher first so Capacitor cannot deliver retained data to
  // a feature-specific listener while action/channel configuration is pending.
  await dispatcher.initialize();
  await initNativeLocalNotificationActionTypes();
}
