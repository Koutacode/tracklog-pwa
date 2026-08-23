import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  classifyAuthExchangeFailure,
  handleAdminAuthCallbackUrl,
  handleDriverAuthCallbackUrl,
  parseAuthCallbackUrl,
} from '../services/remoteAuth';
import {
  clearNativeAuthAttempt,
  clearNativeAuthCallbackUrl,
  getNativeAuthAttempt,
  getNativeAuthCallbackIntentRecord,
  getNativeAuthCallbackUrl,
  isTracklogNativeAuthCallbackUrl,
  persistNativeAuthCallbackUrl,
  type NativeAuthAttempt,
  type NativeAuthCallbackIntent,
  type NativeAuthCallbackIntentRecord,
} from '../services/nativeAuthCallbackPersistence';

type NativeAuthCallbackResult = {
  handled: boolean;
  nextPath?: string;
  intent?: NativeAuthCallbackIntent;
  attemptId?: string | null;
};

export type NativeAuthCallbackRoute = {
  intent: NativeAuthCallbackIntent;
  nextPath: string;
  attemptId: string | null;
  forceIntent: boolean;
};

export type NativeAuthCallbackFailureKind = 'transient' | 'permanent';

const MAX_COMPLETED_NATIVE_AUTH_CALLBACKS = 32;
export const NATIVE_AUTH_CALLBACK_STATE_EVENT = 'tracklog:native-auth-callback-state';

type NativeAuthCallbackTaskRegistry = {
  get(
    url: string,
    taskFactory: () => Promise<NativeAuthCallbackResult>,
  ): Promise<NativeAuthCallbackResult>;
};

class NativeAuthCallbackPolicyError extends Error {
  readonly nativeAuthPermanent = true;

  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'NativeAuthCallbackPolicyError';
  }
}

function callbackKey(url: string) {
  let hash = 2166136261;
  for (let index = 0; index < url.length; index++) {
    hash ^= url.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function createNativeAuthCallbackTaskRegistry(
  maxCompleted = MAX_COMPLETED_NATIVE_AUTH_CALLBACKS,
): NativeAuthCallbackTaskRegistry {
  const tasks = new Map<string, Promise<NativeAuthCallbackResult>>();
  const completed = new Map<string, NativeAuthCallbackResult>();
  const completedLimit = Math.max(1, Math.floor(maxCompleted));

  return {
    get(url, taskFactory) {
      // The URL/code fingerprint is the only key. Intent may be consumed before
      // Android redelivers the same single-use callback.
      const key = callbackKey(url);
      const completedResult = completed.get(key);
      if (completedResult) return Promise.resolve(completedResult);
      const existing = tasks.get(key);
      if (existing) return existing;

      const task = Promise.resolve().then(taskFactory);
      tasks.set(key, task);
      void task.then(
        result => {
          if (tasks.get(key) === task) tasks.delete(key);
          if (!result.handled) return;
          if (completed.size >= completedLimit) {
            const oldestKey = completed.keys().next().value;
            if (typeof oldestKey === 'string') completed.delete(oldestKey);
          }
          completed.set(key, result);
        },
        () => {
          if (tasks.get(key) === task) tasks.delete(key);
        },
      );
      return task;
    },
  };
}

export function resolveNativeAuthCallbackRoute(
  url: string,
  attempt: NativeAuthAttempt | null = getNativeAuthAttempt(),
  intentRecord: NativeAuthCallbackIntentRecord | null = getNativeAuthCallbackIntentRecord(),
): NativeAuthCallbackRoute {
  if (!isTracklogNativeAuthCallbackUrl(url)) {
    throw new NativeAuthCallbackPolicyError('TrackLogの認証URLではありません。', 'invalid_callback_url');
  }
  const parsed = parseAuthCallbackUrl(url);
  if (parsed.nextProvided && !parsed.nextAllowed) {
    throw new NativeAuthCallbackPolicyError(
      '認証後の移動先が許可されていません。ログインを最初からやり直してください。',
      'invalid_callback_next',
    );
  }
  if (parsed.attemptProvided && !parsed.attemptId) {
    throw new NativeAuthCallbackPolicyError(
      '認証試行の識別情報が不正です。ログインを最初からやり直してください。',
      'invalid_callback_attempt',
    );
  }

  if (parsed.attemptId) {
    if (!attempt) {
      throw new NativeAuthCallbackPolicyError(
        '認証の有効時間が切れています。ログインを最初からやり直してください。',
        'missing_auth_attempt',
      );
    }
    if (parsed.attemptId !== attempt.id) {
      throw new NativeAuthCallbackPolicyError(
        '古い認証URLです。現在のログイン操作を続けてください。',
        'auth_attempt_mismatch',
      );
    }
  } else if (attempt) {
    // Every flow created by this build includes the attempt id. A callback
    // without it must never consume the verifier for a newer active flow.
    throw new NativeAuthCallbackPolicyError(
      '古い形式の認証URLです。ログインを最初からやり直してください。',
      'missing_callback_attempt',
    );
  }

  if (parsed.callbackRole) {
    if (attempt && parsed.callbackRole !== attempt.intent) {
      throw new NativeAuthCallbackPolicyError(
        '認証URLとログインの種類が一致しません。',
        'auth_role_mismatch',
      );
    }
    return {
      intent: parsed.callbackRole,
      nextPath: parsed.nextPath,
      attemptId: parsed.attemptId,
      forceIntent: false,
    };
  }

  if (
    !attempt ||
    !intentRecord ||
    intentRecord.attemptId !== attempt.id ||
    intentRecord.intent !== attempt.intent ||
    (parsed.attemptId != null && parsed.attemptId !== intentRecord.attemptId)
  ) {
    throw new NativeAuthCallbackPolicyError(
      '認証URLの種類を確認できません。ログインを最初からやり直してください。',
      'missing_callback_role',
    );
  }
  return {
    intent: intentRecord.intent,
    nextPath: intentRecord.intent === 'admin' ? '/admin' : '/settings',
    attemptId: intentRecord.attemptId,
    forceIntent: true,
  };
}

export function classifyNativeAuthCallbackFailure(error: unknown): NativeAuthCallbackFailureKind {
  if (
    typeof error === 'object' &&
    error != null &&
    (error as { nativeAuthPermanent?: unknown }).nativeAuthPermanent === true
  ) {
    return 'permanent';
  }
  return classifyAuthExchangeFailure(error);
}

const nativeAuthCallbackTaskRegistry = createNativeAuthCallbackTaskRegistry();
let nativeAuthCallbackConsumers = 0;

function beginNativeAuthCallbackProcessing() {
  nativeAuthCallbackConsumers += 1;
  window.dispatchEvent(new CustomEvent(NATIVE_AUTH_CALLBACK_STATE_EVENT, {
    detail: { processing: true },
  }));
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    nativeAuthCallbackConsumers = Math.max(0, nativeAuthCallbackConsumers - 1);
    window.dispatchEvent(new CustomEvent(NATIVE_AUTH_CALLBACK_STATE_EVENT, {
      detail: { processing: nativeAuthCallbackConsumers > 0 },
    }));
  };
}

async function classifyCallback(url: string): Promise<NativeAuthCallbackResult> {
  const route = resolveNativeAuthCallbackRoute(url);
  const result = route.intent === 'admin'
    ? await handleAdminAuthCallbackUrl(url, route.forceIntent)
    : await handleDriverAuthCallbackUrl(url, route.forceIntent);
  return {
    ...result,
    nextPath: result.nextPath ?? route.nextPath,
    intent: route.intent,
    attemptId: route.attemptId,
  };
}

function getNativeAuthCallbackTask(url: string) {
  return nativeAuthCallbackTaskRegistry.get(url, () => classifyCallback(url));
}

function clearMatchingAttempt(url: string, fallbackAttemptId?: string | null) {
  let callbackAttemptId = fallbackAttemptId ?? null;
  try {
    callbackAttemptId = parseAuthCallbackUrl(url).attemptId ?? callbackAttemptId;
  } catch {
    // Invalid URLs have no attempt state to clear.
  }
  if (callbackAttemptId) clearNativeAuthAttempt(callbackAttemptId);
}

export function settleNativeAuthCallbackFailure(url: string, error: unknown) {
  const failureKind = classifyNativeAuthCallbackFailure(error);
  if (failureKind === 'permanent') {
    clearNativeAuthCallbackUrl(url);
    clearMatchingAttempt(url);
  }
  return failureKind;
}

function getCallbackLoginPath(url: string): '/login' | '/driver-login' {
  try {
    const parsed = parseAuthCallbackUrl(url);
    if (parsed.callbackRole === 'admin') return '/login';
    if (parsed.callbackRole === 'driver') return '/driver-login';
  } catch {
    // Fall back to the short-lived, attempt-bound intent below.
  }
  return getNativeAuthCallbackIntentRecord()?.intent === 'admin' ? '/login' : '/driver-login';
}

export default function AdminAuthBridge() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let active = true;
    let urlListener: { remove(): void } | null = null;
    let appStateListener: { remove(): void } | null = null;
    let resumeListener: { remove(): void } | null = null;

    const handleUrl = async (url?: string | null) => {
      if (!url || !active || !isTracklogNativeAuthCallbackUrl(url)) return;
      // The bridge listener can win the race against main.tsx. Persist first so
      // process death or a transient exchange never loses the single-use code.
      persistNativeAuthCallbackUrl(url);
      const finishProcessing = beginNativeAuthCallbackProcessing();
      try {
        const result = await getNativeAuthCallbackTask(url);
        if (!result.handled) {
          throw new NativeAuthCallbackPolicyError(
            '認証情報を確認できませんでした。ログインを最初からやり直してください。',
            'unhandled_callback',
          );
        }
        clearNativeAuthCallbackUrl(url);
        clearMatchingAttempt(url, result.attemptId);
        if (active) {
          navigate(result.nextPath ?? (result.intent === 'driver' ? '/settings' : '/admin'), {
            replace: true,
          });
        }
      } catch (error) {
        console.error('Admin auth callback failed', error);
        const failureKind = settleNativeAuthCallbackFailure(url, error);
        if (active) {
          const rawMessage = `${(error as { message?: unknown })?.message ?? error}`.trim();
          const authError = failureKind === 'transient'
            ? '通信の問題で認証を完了できませんでした。接続が戻ると自動で再試行します。'
            : rawMessage || '認証に失敗しました';
          navigate(getCallbackLoginPath(url), {
            replace: true,
            state: { authError, authRetryPending: failureKind === 'transient' },
          });
        }
      } finally {
        finishProcessing();
      }
    };

    const processPending = async () => {
      if (!active) return;
      const pending = getNativeAuthCallbackUrl();
      if (!pending) return;
      await handleUrl(pending);
    };

    void CapacitorApp.getLaunchUrl()
      .then(result => {
        if (!active) return;
        if (result?.url && isTracklogNativeAuthCallbackUrl(result.url)) {
          void handleUrl(result.url);
          return;
        }
        void processPending();
      })
      .catch(error => {
        console.warn('Native auth launch URL could not be read', error);
        if (active) void processPending();
      });

    void CapacitorApp.addListener('appUrlOpen', ({ url }) => {
      void handleUrl(url);
    }).then(result => {
      if (active) urlListener = result;
      else void result.remove();
    }).catch(error => {
      console.warn('Native auth URL listener could not be registered', error);
    });

    void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) void processPending();
    }).then(result => {
      if (active) appStateListener = result;
      else void result.remove();
    }).catch(error => {
      console.warn('Native auth app-state listener could not be registered', error);
    });

    void CapacitorApp.addListener('resume', () => {
      void processPending();
    }).then(result => {
      if (active) resumeListener = result;
      else void result.remove();
    }).catch(error => {
      console.warn('Native auth resume listener could not be registered', error);
    });

    const handleOnline = () => {
      void processPending();
    };
    window.addEventListener('online', handleOnline);

    return () => {
      active = false;
      window.removeEventListener('online', handleOnline);
      void urlListener?.remove();
      void appStateListener?.remove();
      void resumeListener?.remove();
    };
  }, [navigate]);

  return null;
}
