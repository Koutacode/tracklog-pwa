import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  handleAdminWebAuthCallbackUrl,
  handleDriverWebAuthCallbackUrl,
} from '../services/remoteAuth';
import { hydrateRemoteSyncState, runRemoteSync } from '../services/remoteSync';
import {
  getDriverPostAuthPath,
  getWebAuthCallbackRole,
  type WebAuthCallbackRole,
} from './authCallbackRouting';

export type CallbackOutcome = {
  nextPath: string;
};

type WebAuthCallbackTaskRegistry = {
  get(
    role: WebAuthCallbackRole,
    callbackUrl: string,
    taskFactory: () => Promise<CallbackOutcome>,
  ): Promise<CallbackOutcome>;
};

function callbackFingerprint(role: WebAuthCallbackRole, callbackUrl: string) {
  let hash = 2166136261;
  const value = `${role}:${callbackUrl}`;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function createWebAuthCallbackTaskRegistry(maxCompleted = 32): WebAuthCallbackTaskRegistry {
  const tasks = new Map<string, Promise<CallbackOutcome>>();
  const completed = new Map<string, CallbackOutcome>();
  const completedLimit = Math.max(1, Math.floor(maxCompleted));

  return {
    get(role, callbackUrl, taskFactory) {
      const key = callbackFingerprint(role, callbackUrl);
      const completedResult = completed.get(key);
      if (completedResult) return Promise.resolve(completedResult);
      const existing = tasks.get(key);
      if (existing) return existing;

      const task = Promise.resolve().then(taskFactory);
      tasks.set(key, task);
      void task.then(
        result => {
          if (tasks.get(key) === task) tasks.delete(key);
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

const callbackTasks = createWebAuthCallbackTaskRegistry();

export function isRetryableWebAuthCallbackFailure(callbackUrl: string, error: unknown) {
  if (
    typeof error !== 'object' ||
    error == null ||
    (error as { webAuthCodeRetryable?: unknown }).webAuthCodeRetryable !== true
  ) {
    return false;
  }
  try {
    const parsed = new URL(callbackUrl);
    const query = parsed.searchParams;
    const hash = new URLSearchParams(parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash);
    const hasCode = !!(query.get('code') ?? hash.get('code'));
    const hasProviderError = !!(
      query.get('error') || query.get('error_code') || hash.get('error') || hash.get('error_code')
    );
    const hasBearerTokens = !!(
      query.get('access_token') ||
      query.get('refresh_token') ||
      hash.get('access_token') ||
      hash.get('refresh_token')
    );
    return hasCode && !hasProviderError && !hasBearerTokens;
  } catch {
    return false;
  }
}

function getCallbackTask(role: WebAuthCallbackRole, callbackUrl: string) {
  return callbackTasks.get(role, callbackUrl, async (): Promise<CallbackOutcome> => {
    const parsed = new URL(callbackUrl);
    if (getWebAuthCallbackRole(parsed.pathname) !== role) {
      throw new Error('認証URLの種類が一致しません。');
    }

    if (role === 'admin') {
      const result = await handleAdminWebAuthCallbackUrl(callbackUrl);
      if (!result.handled) throw new Error('管理者の認証URLを処理できませんでした。');
      return { nextPath: '/admin' };
    }

    const result = await handleDriverWebAuthCallbackUrl(callbackUrl);
    if (!result.handled || !result.identity) {
      throw new Error('運転者の認証URLを処理できませんでした。');
    }
    await hydrateRemoteSyncState().catch(error => {
      console.error('Driver auth state hydration failed', error);
    });
    await runRemoteSync('driver-web-auth').catch(error => {
      console.error('Driver auth sync failed', error);
    });
    return { nextPath: getDriverPostAuthPath(result.identity) };
  });
}

export default function AuthCallbackScreen({ role }: { role: WebAuthCallbackRole }) {
  const navigate = useNavigate();
  const [errorState, setErrorState] = useState<{ message: string; retryable: boolean } | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);

  useEffect(() => {
    let active = true;
    const callbackUrl = window.location.href;
    setErrorState(null);

    void getCallbackTask(role, callbackUrl)
      .then(({ nextPath }) => {
        if (!active) return;
        navigate(nextPath, { replace: true });
      })
      .catch(error => {
        if (!active) return;
        const retryable = isRetryableWebAuthCallbackFailure(callbackUrl, error);
        if (!retryable) {
          window.history.replaceState(window.history.state, '', window.location.pathname);
        }
        setErrorState({
          retryable,
          message: retryable
            ? '通信の問題でログインを完了できませんでした。接続を確認して、もう一度お試しください。'
            : error instanceof Error ? error.message : '認証処理に失敗しました。',
        });
      });

    return () => {
      active = false;
    };
  }, [navigate, retryGeneration, role]);

  useEffect(() => {
    if (!errorState?.retryable) return;
    const retryWhenOnline = () => {
      setRetryGeneration(value => value + 1);
    };
    window.addEventListener('online', retryWhenOnline, { once: true });
    return () => window.removeEventListener('online', retryWhenOnline);
  }, [errorState?.retryable]);

  if (errorState) {
    const retryPath = role === 'admin' ? '/login' : '/driver-login';
    return (
      <div className="screen-shell">
        <div className="screen-card screen-card--narrow">
          <div className="screen-card__header">
            <div>
              <div className="screen-card__eyebrow">認証エラー</div>
              <h1 className="screen-card__title">ログインを完了できませんでした</h1>
            </div>
          </div>
          <div className="settings-toast" role="alert" aria-live="assertive">
            {errorState.message}
          </div>
          {errorState.retryable && (
            <button
              type="button"
              className="trip-btn trip-btn--primary"
              onClick={() => setRetryGeneration(value => value + 1)}
            >
              もう一度試す
            </button>
          )}
          <Link className="trip-btn trip-btn--primary" to={retryPath}>
            ログイン画面へ戻る
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="screen-shell">
      <div className="screen-card screen-card--narrow" role="status" aria-live="polite">
        認証状態を確認しています…
      </div>
    </div>
  );
}
