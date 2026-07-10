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

type CallbackOutcome = {
  nextPath: string;
};

const callbackTasks = new Map<string, Promise<CallbackOutcome>>();

function getCallbackTask(role: WebAuthCallbackRole, callbackUrl: string) {
  const key = `${role}:${callbackUrl}`;
  const existing = callbackTasks.get(key);
  if (existing) return existing;

  const task = (async (): Promise<CallbackOutcome> => {
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
  })();

  callbackTasks.set(key, task);
  void task.catch(() => {
    callbackTasks.delete(key);
  });
  return task;
}

export default function AuthCallbackScreen({ role }: { role: WebAuthCallbackRole }) {
  const navigate = useNavigate();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const callbackUrl = window.location.href;

    void getCallbackTask(role, callbackUrl)
      .then(({ nextPath }) => {
        if (!active) return;
        navigate(nextPath, { replace: true });
      })
      .catch(error => {
        if (!active) return;
        window.history.replaceState(window.history.state, '', window.location.pathname);
        setErrorMessage(error instanceof Error ? error.message : '認証処理に失敗しました。');
      });

    return () => {
      active = false;
    };
  }, [navigate, role]);

  if (errorMessage) {
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
          <div className="settings-toast" role="alert">{errorMessage}</div>
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
