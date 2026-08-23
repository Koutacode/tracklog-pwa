export type NativeAdminMessageNotificationAction = {
  messageId: string;
  body?: string;
  requestLocation: boolean;
  actionId: string;
};

type NativeNotificationActionEventLike = {
  actionId?: unknown;
  notification?: {
    extra?: unknown;
  };
};

function parseBoolean(value: unknown, fallback: boolean) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return fallback;
}

export function parseNativeAdminMessageNotificationAction(
  event: NativeNotificationActionEventLike,
  expectedKind: string,
): NativeAdminMessageNotificationAction | null {
  const extra = event.notification?.extra;
  if (!extra || typeof extra !== 'object') return null;
  const record = extra as Record<string, unknown>;
  if (record.kind !== expectedKind) return null;
  const messageId = typeof record.messageId === 'string' ? record.messageId.trim() : '';
  if (!messageId) return null;
  const body = typeof record.body === 'string' && record.body.trim()
    ? record.body.trim()
    : undefined;
  const actionId = typeof event.actionId === 'string' ? event.actionId : '';
  return {
    messageId,
    ...(body ? { body } : {}),
    requestLocation: parseBoolean(record.requestLocation, true),
    actionId,
  };
}

export type MessageActionSingleFlight = {
  run(messageId: string, action: () => Promise<boolean>): Promise<boolean>;
};

/**
 * Coalesces concurrent notification/push/UI actions for one message. A
 * successful action remains completed; a false result or rejection may retry
 * after authentication/network recovery.
 */
export function createMessageActionSingleFlight(options?: {
  isCompleted?: (messageId: string) => boolean;
  markCompleted?: (messageId: string) => void;
}): MessageActionSingleFlight {
  const completed = new Set<string>();
  const inFlight = new Map<string, Promise<boolean>>();

  return {
    run(messageId, action) {
      const id = messageId.trim();
      if (!id) return Promise.resolve(false);
      if (completed.has(id) || options?.isCompleted?.(id)) {
        completed.add(id);
        return Promise.resolve(true);
      }
      const existing = inFlight.get(id);
      if (existing) return existing;

      const next = Promise.resolve()
        .then(action)
        .then(success => {
          if (success) {
            completed.add(id);
            options?.markCompleted?.(id);
          }
          return success;
        })
        .finally(() => {
          if (inFlight.get(id) === next) inFlight.delete(id);
        });
      inFlight.set(id, next);
      return next;
    },
  };
}

export async function handleNativeAdminMessageNotificationAction(
  action: NativeAdminMessageNotificationAction,
  input: {
    remember(message: {
      id: string;
      body?: string;
      requestLocation: boolean;
    }): void;
    openInbox(messageId: string): void;
    requestLocation(messageId: string): Promise<boolean>;
    updateLocationActionId: string;
  },
): Promise<void> {
  if (action.body) {
    input.remember({
      id: action.messageId,
      body: action.body,
      requestLocation: action.requestLocation,
    });
  }
  input.openInbox(action.messageId);
  if (!action.requestLocation) return;
  if (
    action.actionId
    && action.actionId !== input.updateLocationActionId
    && action.actionId !== 'tap'
  ) {
    return;
  }
  await input.requestLocation(action.messageId);
}
