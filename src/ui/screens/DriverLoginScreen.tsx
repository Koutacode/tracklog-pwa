import { Capacitor } from '@capacitor/core';
import { FormEvent, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { DriverIdentity } from '../../domain/remoteTypes';
import {
  initializeDriverIdentity,
  onDriverAuthStateChange,
  sendDriverLoginLink,
  verifyDriverEmailOtp,
} from '../../services/remoteAuth';
import {
  getNativeAuthAttempt,
  isNativeAuthFlowInProgressError,
} from '../../services/nativeAuthCallbackPersistence';
import { normalizeEmailInput, toHalfWidthDigits } from '../../services/driverProfileValidation';
import { hydrateRemoteSyncState, runRemoteSync } from '../../services/remoteSync';

function canUseHome(identity: DriverIdentity) {
  return identity.configured && identity.authInitialized && identity.profileComplete && identity.approvalStatus === 'approved';
}

function getNextPath(identity: DriverIdentity) {
  return canUseHome(identity) ? '/' : '/settings';
}

function formatDriverLoginError(error: any) {
  const raw = `${error?.message ?? error ?? ''}`.trim();
  if (!raw) return 'ログインに失敗しました';
  const normalized = raw.toLowerCase();
  if (isCloudSyncCheckError(error)) {
    return 'クラウド同期の確認に失敗しました。通信状態を確認して、もう一度ログインしてください。';
  }
  if (
    normalized.includes('rate limit') ||
    normalized.includes('email rate limit') ||
    normalized.includes('over_email_send_rate_limit')
  ) {
    return 'メール送信の上限に達しています。少し待ってから再度試してください。';
  }
  if (normalized.includes('otp') || normalized.includes('token')) {
    return '認証コードが無効です。最新のメールで再度試してください。';
  }
  return raw;
}

function isCloudSyncCheckError(error: any) {
  const raw = `${error?.message ?? error ?? ''}`.toLowerCase();
  return raw.includes('edge function returned a non-2xx status code');
}

export default function DriverLoginScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<'idle' | 'checking' | 'sending' | 'verifying'>('checking');
  const [message, setMessage] = useState<string | null>(null);
  const [messageIsError, setMessageIsError] = useState(false);
  const [nativeRestartRequired, setNativeRestartRequired] = useState(false);

  useEffect(() => {
    const authError = (location.state as { authError?: unknown } | null)?.authError;
    if (typeof authError !== 'string' || !authError.trim()) return;
    setStatus('idle');
    setMessageIsError(true);
    setMessage(formatDriverLoginError(authError));
    const retryPending = (location.state as { authRetryPending?: unknown } | null)?.authRetryPending === true;
    if (retryPending) setNativeRestartRequired(false);
    if (!retryPending && Capacitor.isNativePlatform() && getNativeAuthAttempt()?.intent === 'driver') {
      setNativeRestartRequired(true);
    }
  }, [location.key, location.state]);

  const finishLogin = async (reason: string) => {
    const identity = await initializeDriverIdentity();
    await hydrateRemoteSyncState();
    await runRemoteSync(reason).catch(error => {
      console.error(error);
    });
    navigate(getNextPath(identity), { replace: true });
  };

  useEffect(() => {
    let active = true;
    void initializeDriverIdentity()
      .then(identity => {
        if (!active) return;
        setEmail(identity.email ?? '');
        if (canUseHome(identity)) {
          navigate('/', { replace: true });
        } else {
          setStatus('idle');
        }
      })
      .catch(error => {
        if (!active) return;
        setStatus('idle');
        if (!isCloudSyncCheckError(error)) {
          setMessageIsError(true);
          setMessage(formatDriverLoginError(error));
        }
      });
    const unsubscribe = onDriverAuthStateChange(event => {
      if (event !== 'SIGNED_IN') return;
      void finishLogin('driver-login-auth').catch(error => {
        if (!active) return;
        setStatus('idle');
        setMessageIsError(true);
        setMessage(formatDriverLoginError(error));
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [navigate]);

  const handleSendLogin = async (event?: FormEvent, restartNativeAttempt = false) => {
    event?.preventDefault();
    setStatus('sending');
    setMessage(null);
    if (restartNativeAttempt) setNativeRestartRequired(false);
    const normalizedEmail = normalizeEmailInput(email);
    setEmail(normalizedEmail);
    try {
      await sendDriverLoginLink(normalizedEmail, undefined, { restartNativeAttempt });
      setMessageIsError(false);
      setMessage('ログインメールを送信しました。メール本文の認証コードをこの画面に入力してください。');
    } catch (error: any) {
      setMessageIsError(true);
      if (
        Capacitor.isNativePlatform() &&
        (isNativeAuthFlowInProgressError(error) || getNativeAuthAttempt()?.intent === 'driver')
      ) {
        setNativeRestartRequired(true);
      }
      setMessage(formatDriverLoginError(error));
    } finally {
      setStatus('idle');
    }
  };

  const handleVerifyCode = async () => {
    setStatus('verifying');
    setMessage(null);
    const normalizedEmail = normalizeEmailInput(email);
    const normalizedToken = toHalfWidthDigits(token).replace(/\D/g, '').slice(0, 10);
    setEmail(normalizedEmail);
    setToken(normalizedToken);
    try {
      await verifyDriverEmailOtp(normalizedEmail, normalizedToken);
      await finishLogin('driver-otp-login');
    } catch (error: any) {
      setMessageIsError(true);
      setMessage(formatDriverLoginError(error));
      setStatus('idle');
    }
  };

  const busy = status !== 'idle';

  return (
    <div className="screen-shell">
      <div className="screen-card screen-card--narrow" aria-busy={busy}>
        <div className="screen-card__header">
          <div>
            <div className="screen-card__eyebrow">登録済みアカウント</div>
            <h1 className="screen-card__title">運転者ログイン</h1>
          </div>
          <div className="screen-card__actions">
            <Link to="/" className="pill-link">
              ホーム
            </Link>
            <Link to="/settings" className="pill-link">
              初回登録
            </Link>
          </div>
        </div>

        <div className="settings-note">
          すでに登録・承認済みのメールアドレスを別のブラウザやPWAで使う場合は、ここからログインしてください。
          ログイン状態はブラウザごとに別ですが、運行履歴と承認状態はアカウント単位で同期されます。
        </div>

        <form className="driver-registration" onSubmit={event => void handleSendLogin(event)}>
          <label className="settings-field" htmlFor="driver-login-email">
            <span>メールアドレス</span>
            <input
              id="driver-login-email"
              value={email}
              onChange={event => setEmail(event.target.value)}
              placeholder="driver@example.com"
              type="email"
              autoComplete="email"
              spellCheck={false}
              required
            />
          </label>
          <button className="trip-btn trip-btn--primary" disabled={busy} type="submit">
            {status === 'sending' ? '送信中…' : 'ログインメールを送る'}
          </button>
        </form>

        {Capacitor.isNativePlatform() && nativeRestartRequired && (
          <>
            <div className="settings-note" id="driver-native-auth-restart-help">
              前のログインを破棄すると、その認証メールのリンクは使えなくなります。
            </div>
            <button
              className="trip-btn"
              disabled={busy || !email.trim()}
              type="button"
              aria-describedby="driver-native-auth-restart-help"
              onClick={() => void handleSendLogin(undefined, true)}
            >
              ログインを最初からやり直す
            </button>
          </>
        )}

        <div className="settings-note" style={{ marginTop: 16 }}>
          メール本文の認証コードを入力すると、このPWA内でログインできます。
        </div>
        <div className="driver-registration">
          <label className="settings-field" htmlFor="driver-login-token">
            <span>認証コード</span>
            <input
              id="driver-login-token"
              value={token}
              onChange={event => setToken(toHalfWidthDigits(event.target.value).replace(/\D/g, '').slice(0, 10))}
              placeholder="40055812"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={10}
            />
          </label>
          <button className="trip-btn" disabled={busy || !email.trim() || token.length < 6 || token.length > 10} type="button" onClick={handleVerifyCode}>
            {status === 'verifying' ? '確認中…' : '認証コードでログイン'}
          </button>
        </div>

        {message && (
          <div
            className="settings-toast"
            role={messageIsError ? 'alert' : 'status'}
            aria-live={messageIsError ? 'assertive' : 'polite'}
            aria-atomic="true"
          >
            {message}
          </div>
        )}
      </div>
    </div>
  );
}
