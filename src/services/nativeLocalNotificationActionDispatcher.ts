import { createMessageActionSingleFlight } from './nativeAdminMessageActionPolicy';

export type NativeLocalNotificationActionEvent = {
  actionId?: unknown;
  notification?: {
    id?: unknown;
    extra?: unknown;
  };
};

export type NativeLocalNotificationActionHandler = (
  event: NativeLocalNotificationActionEvent,
) => boolean | Promise<boolean>;

function normalizedKeyPart(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function getNativeLocalNotificationActionKey(
  event: NativeLocalNotificationActionEvent,
): string | null {
  const extra = event.notification?.extra;
  if (!extra || typeof extra !== 'object') return null;
  const record = extra as Record<string, unknown>;
  const kind = normalizedKeyPart(record.kind);
  const ownerId = normalizedKeyPart(record.messageId)
    || normalizedKeyPart(record.promptId)
    || [normalizedKeyPart(record.tripId), normalizedKeyPart(record.detectedAt)].filter(Boolean).join('@')
    || (typeof event.notification?.id === 'number' ? String(event.notification.id) : '');
  if (!kind || !ownerId) return null;
  return `${kind}:${ownerId}:${normalizedKeyPart(event.actionId) || 'tap'}`;
}

export async function dispatchNativeLocalNotificationAction(
  event: NativeLocalNotificationActionEvent,
  handlers: readonly NativeLocalNotificationActionHandler[],
): Promise<boolean> {
  for (const handler of handlers) {
    if (await handler(event)) return true;
  }
  return false;
}

export function createNativeLocalNotificationActionDispatcher(input: {
  register(listener: (event: NativeLocalNotificationActionEvent) => void): Promise<unknown>;
  handlers: readonly NativeLocalNotificationActionHandler[];
  onError?: () => void;
}) {
  let initialized = false;
  let initInFlight: Promise<void> | null = null;
  const actionSingleFlight = createMessageActionSingleFlight();

  const runAction = (event: NativeLocalNotificationActionEvent) => {
    const key = getNativeLocalNotificationActionKey(event);
    const run = () => dispatchNativeLocalNotificationAction(event, input.handlers);
    const result = key ? actionSingleFlight.run(key, run) : run();
    void result.catch(() => input.onError?.());
  };

  return {
    initialize() {
      if (initialized) return Promise.resolve();
      if (initInFlight) return initInFlight;
      const setup = Promise.resolve()
        .then(() => input.register(runAction))
        .then(() => {
          initialized = true;
        })
        .finally(() => {
          if (initInFlight === setup) initInFlight = null;
        });
      initInFlight = setup;
      return setup;
    },
  };
}
