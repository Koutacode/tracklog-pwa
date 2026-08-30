import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { NATIVE_AUTH_CALLBACK_STATE_EVENT } from '../../app/AdminAuthBridge';
import { PWA_URL } from '../../app/releaseInfo';
import {
  getAdminGoogleSignInUrl,
  getAdminSession,
  onAdminAuthStateChange,
  sendAdminMagicLink,
  verifyAdminEmailOtp,
} from '../../services/remoteAuth';
import {
  getNativeAuthAttempt,
  isNativeAuthFlowInProgressError,
} from '../../services/nativeAuthCallbackPersistence';
import { openExternalUrl } from '../../services/nativeShare';
import { normalizeEmailInput, toHalfWidthDigits } from '../../services/driverProfileValidation';

type LoginNotice = {
  kind: 'error' | 'info' | 'success';
  text: string;
};

type NativeRestartAction = 'google' | 'email';

const NATIVE_AUTH_RESUME_CHECKPOINTS_MS = [800, 1_600, 3_000] as const;
const NATIVE_AUTH_CALLBACK_MAX_WAIT_MS = 8_000;
const EXTERNAL_ADMIN_URL = `${PWA_URL.replace(/\/$/, '')}/admin`;

function formatLoginError(error: any) {
  const raw = `${error?.message ?? error ?? ''}`.trim();
  if (!raw) return '認証に失敗しました';
  const normalized = raw.toLowerCase();
  if (
    normalized.includes('rate limit') ||
    normalized.includes('email rate limit') ||
    normalized.includes('over_email_send_rate_limit')
  ) {
    return 'メール送信の上限に達しています。少し待つか、下の「ブラウザで管理画面を開く」を使ってください。';
  }
  if (normalized.includes('unsupported provider') || normalized.includes('provider is not enabled')) {
    return 'Supabase の Google ログインがまだ有効化されていません。Google provider を有効化するまではメールコードで入ってください。';
  }
  if (normalized.includes('otp') || normalized.includes('token')) {
    return '認証コードが無効です。最新のメールで再度試してください。';
  }
  return raw;
}

export default function LoginScreen() {
  const location = useLocation();
  const usesDriverAccount = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [notice, setNotice] = useState<LoginNotice | null>(null);
  const [status, setStatus] = useState<'idle' | 'sending' | 'verifying' | 'google'>('idle');
  const [authenticated, setAuthenticated] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [nativeRestartAction, setNativeRestartAction] = useState<NativeRestartAction | null>(null);
  const nativeGoogleLoginPending = useRef(false);
  const nativeAuthCallbackProcessing = useRef(false);

  useEffect(() => {
    const authError = (location.state as { authError?: unknown } | null)?.authError;
    if (typeof authError !== 'string' || !authError.trim()) return;
    nativeGoogleLoginPending.current = false;
    setStatus('idle');
    setNotice({ kind: 'error', text: formatLoginError(authError) });
    const retryPending = (location.state as { authRetryPending?: unknown } | null)?.authRetryPending === true;
    if (retryPending) setNativeRestartAction(null);
    if (!retryPending && Capacitor.isNativePlatform() && getNativeAuthAttempt()?.intent === 'admin') {
      setNativeRestartAction('google');
    }
  }, [location.key, location.state]);

  useEffect(() => {
    let active = true;
    const refreshSession = async () => {
      try {
        const session = await getAdminSession();
        if (!active) return;
        setAuthenticated(session.authenticated);
        setIsAdmin(session.isAdmin);
        setNotice(current => current?.kind === 'error' ? null : current);
        if (session.authenticated) {
          nativeGoogleLoginPending.current = false;
          setNativeRestartAction(null);
          setStatus(current => current === 'google' ? 'idle' : current);
        }
      } catch (error) {
        if (active) {
          setNotice({ kind: 'error', text: formatLoginError(error) });
        }
      } finally {
        if (active) setSessionChecked(true);
      }
    };

    void refreshSession();
    const unsubscribe = onAdminAuthStateChange(() => {
      void refreshSession();
    });
    const onOnline = () => void refreshSession();
    window.addEventListener('online', onOnline);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener('online', onOnline);
    };
  }, []);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let active = true;
    let resumeTimer: number | null = null;
    let appStateListener: { remove(): void } | null = null;
    let resumeListener: { remove(): void } | null = null;
    let resumeSequenceActive = false;
    let resumeSequence = 0;
    let resumeStartedAt = 0;

    const clearResumeTimer = () => {
      if (resumeTimer == null) return;
      window.clearTimeout(resumeTimer);
      resumeTimer = null;
    };

    const finishResumeCheck = () => {
      clearResumeTimer();
      resumeSequenceActive = false;
      nativeGoogleLoginPending.current = false;
      setStatus(current => current === 'google' ? 'idle' : current);
    };

    const showSessionResult = (session: Awaited<ReturnType<typeof getAdminSession>>) => {
      setAuthenticated(session.authenticated);
      setIsAdmin(session.isAdmin);
      setNotice(session.authenticated
        ? {
            kind: session.isAdmin ? 'success' : 'error',
            text: session.isAdmin
              ? 'ログインを確認しました。管理画面を開けます。'
              : 'このメールアドレスは管理者として登録されていません。',
          }
        : {
            kind: 'info',
            text: 'Googleログインは完了していません。必要な場合はもう一度お試しください。',
          });
      if (session.authenticated) {
        setNativeRestartAction(null);
      } else if (getNativeAuthAttempt()?.intent === 'admin') {
        setNativeRestartAction('google');
      }
    };

    const scheduleResumeCheck = (
      checkpointIndex: number,
      sequence: number,
      delayOverride?: number,
    ) => {
      clearResumeTimer();
      const elapsed = Date.now() - resumeStartedAt;
      const checkpoint = NATIVE_AUTH_RESUME_CHECKPOINTS_MS[
        Math.min(checkpointIndex, NATIVE_AUTH_RESUME_CHECKPOINTS_MS.length - 1)
      ];
      const delay = delayOverride ?? Math.max(0, checkpoint - elapsed);
      resumeTimer = window.setTimeout(() => {
        resumeTimer = null;
        if (!active || sequence !== resumeSequence || !nativeGoogleLoginPending.current) {
          resumeSequenceActive = false;
          return;
        }
        void (async () => {
          try {
            const session = await getAdminSession();
            if (!active || sequence !== resumeSequence || !nativeGoogleLoginPending.current) return;
            if (session.authenticated) {
              showSessionResult(session);
              finishResumeCheck();
              return;
            }

            const lastCheckpoint = checkpointIndex >= NATIVE_AUTH_RESUME_CHECKPOINTS_MS.length - 1;
            if (!lastCheckpoint) {
              scheduleResumeCheck(checkpointIndex + 1, sequence);
              return;
            }
            if (nativeAuthCallbackProcessing.current && elapsed < NATIVE_AUTH_CALLBACK_MAX_WAIT_MS) {
              scheduleResumeCheck(
                checkpointIndex,
                sequence,
                Math.max(0, NATIVE_AUTH_CALLBACK_MAX_WAIT_MS - (Date.now() - resumeStartedAt)),
              );
              return;
            }
            showSessionResult(session);
            finishResumeCheck();
          } catch (error) {
            if (active && sequence === resumeSequence) {
              setNotice({ kind: 'error', text: formatLoginError(error) });
              finishResumeCheck();
            }
          }
        })();
      }, delay);
    };

    const beginSessionCheckAfterResume = () => {
      if (!active || !nativeGoogleLoginPending.current) return;
      if (resumeSequenceActive) return;
      resumeSequenceActive = true;
      resumeSequence += 1;
      resumeStartedAt = Date.now();
      scheduleResumeCheck(0, resumeSequence);
    };

    const handleNativeAuthCallbackState = (event: Event) => {
      const processing = (event as CustomEvent<{ processing?: unknown }>).detail?.processing === true;
      nativeAuthCallbackProcessing.current = processing;
      if (!nativeGoogleLoginPending.current) return;
      if (processing) {
        setStatus(current => current === 'idle' ? 'google' : current);
        beginSessionCheckAfterResume();
        return;
      }
      if (!resumeSequenceActive) return;
      resumeSequence += 1;
      scheduleResumeCheck(
        NATIVE_AUTH_RESUME_CHECKPOINTS_MS.length - 1,
        resumeSequence,
        100,
      );
    };

    window.addEventListener(NATIVE_AUTH_CALLBACK_STATE_EVENT, handleNativeAuthCallbackState);

    void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) beginSessionCheckAfterResume();
    }).then(listener => {
      if (active) appStateListener = listener;
      else void listener.remove();
    }).catch(error => {
      console.warn('Admin auth app-state listener could not be registered', error);
    });

    void CapacitorApp.addListener('resume', beginSessionCheckAfterResume).then(listener => {
      if (active) resumeListener = listener;
      else void listener.remove();
    }).catch(error => {
      console.warn('Admin auth resume listener could not be registered', error);
    });

    return () => {
      active = false;
      clearResumeTimer();
      window.removeEventListener(NATIVE_AUTH_CALLBACK_STATE_EVENT, handleNativeAuthCallbackState);
      void appStateListener?.remove();
      void resumeListener?.remove();
    };
  }, []);

  const startAdminGoogleLogin = async (restartNativeAttempt = false) => {
    setStatus('google');
    setNotice(null);
    if (restartNativeAttempt) setNativeRestartAction(null);
    let nativeFlowCreated = false;
    try {
      const url = await getAdminGoogleSignInUrl(undefined, { restartNativeAttempt });
      if (Capacitor.isNativePlatform()) {
        nativeFlowCreated = true;
        nativeGoogleLoginPending.current = true;
        const opened = await openExternalUrl(url);
        if (!opened) throw new Error('Googleログイン画面を開けませんでした。');
        setNotice({
          kind: 'info',
          text: 'Googleログインをブラウザで開きました。認証後にアプリへ戻ります。',
        });
      } else {
        window.location.href = url;
      }
    } catch (error: any) {
      nativeGoogleLoginPending.current = false;
      if (
        Capacitor.isNativePlatform() &&
        (nativeFlowCreated || isNativeAuthFlowInProgressError(error) || getNativeAuthAttempt()?.intent === 'admin')
      ) {
        setNativeRestartAction('google');
      }
      setNotice({ kind: 'error', text: formatLoginError(error) });
      setStatus('idle');
    }
  };

  const sendAdminLoginEmail = async (restartNativeAttempt = false) => {
    setStatus('sending');
    setNotice(null);
    if (restartNativeAttempt) setNativeRestartAction(null);
    const normalizedEmail = normalizeEmailInput(email);
    setEmail(normalizedEmail);
    try {
      await sendAdminMagicLink(normalizedEmail, undefined, { restartNativeAttempt });
      setNotice({
        kind: 'success',
        text: 'ログインコードを送信しました。メール本文の認証コードを入力してください。',
      });
    } catch (error: any) {
      if (
        Capacitor.isNativePlatform() &&
        (isNativeAuthFlowInProgressError(error) || getNativeAuthAttempt()?.intent === 'admin')
      ) {
        setNativeRestartAction('email');
      }
      setNotice({ kind: 'error', text: formatLoginError(error) });
    } finally {
      setStatus('idle');
    }
  };

  if (usesDriverAccount && sessionChecked && isAdmin) {
    return <Navigate to="/admin" replace />;
  }

  if (usesDriverAccount) {
    return (
      <div className="screen-shell">
        <div className="screen-card screen-card--narrow">
          <div className="screen-card__header">
            <div>
              <div className="screen-card__eyebrow">管理者確認</div>
              <h1 className="screen-card__title">現在のアカウントを確認</h1>
            </div>
          </div>
          {!sessionChecked ? (
            <div className="settings-note">管理者権限を確認しています…</div>
          ) : (
            <>
              <div className="settings-note">
                Androidアプリは、この端末で運行記録に使用中のアカウントで管理者権限を確認します。
              </div>
              {authenticated ? (
                <div className="settings-toast" role="alert">
                  このアカウントは管理者として有効化されていません。
                </div>
              ) : (
                <div className="settings-toast" role="alert">
                  運転者アカウントのログインが必要です。
                </div>
              )}
              {notice && (
                <div
                  className={`settings-toast${notice.kind === 'success' ? ' settings-toast--success' : ''}`}
                  role={notice.kind === 'error' ? 'alert' : 'status'}
                >
                  {notice.text}
                </div>
              )}
              {!authenticated && (
                <Link
                  to="/driver-login"
                  className="trip-btn trip-btn--primary"
                  style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}
                >
                  運転者アカウントでログイン
                </Link>
              )}
              <Link
                to="/"
                className="trip-btn"
                style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}
              >
                運転者画面へ戻る
              </Link>
              <div className="settings-note" id="external-admin-session-note">
                ブラウザの管理者ログインはアプリとは別に管理されます。
              </div>
              <button
                type="button"
                className="trip-btn"
                aria-describedby="external-admin-session-note"
                onClick={async () => {
                  setNotice(null);
                  try {
                    const opened = await openExternalUrl(EXTERNAL_ADMIN_URL);
                    if (!opened) throw new Error('ブラウザで管理画面を開けませんでした。');
                    setNotice({ kind: 'info', text: 'ブラウザで管理画面を開きました。' });
                  } catch (error: any) {
                    setNotice({ kind: 'error', text: formatLoginError(error) });
                  }
                }}
              >
                ブラウザで管理画面を開く
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="screen-shell">
      <div className="screen-card screen-card--narrow" aria-busy={status !== 'idle'}>
        <div className="screen-card__header">
          <div>
            <div className="screen-card__eyebrow">管理者ログイン</div>
            <h1 className="screen-card__title">Google またはメールでサインイン</h1>
          </div>
          <div className="screen-card__actions">
            <Link to="/" className="pill-link">
              ホーム
            </Link>
            {isAdmin && (
              <Link to="/admin" className="pill-link">
                管理画面へ
              </Link>
            )}
          </div>
        </div>
        <div className="settings-note">
          管理者として登録されているメールアドレスでログインしてください。
        </div>
        {authenticated && !isAdmin && (
          <div className="settings-toast" role="alert">
            このメールアドレスは管理者として登録されていません。
          </div>
        )}
        {Capacitor.isNativePlatform() && (
          <div className="settings-note" id="native-google-login-help">
            Googleログインは既定ブラウザで開きます。認証後は自動でアプリに戻ります。
          </div>
        )}
        <button
          type="button"
          className="trip-btn trip-btn--primary"
          disabled={status !== 'idle'}
          aria-describedby={Capacitor.isNativePlatform() ? 'native-google-login-help' : undefined}
          onClick={() => void startAdminGoogleLogin()}
        >
          {status === 'google' ? 'Googleログインを開いています…' : 'Googleでログイン'}
        </button>
        <label className="settings-field" htmlFor="admin-login-email">
          <span>メールアドレス</span>
          <input
            id="admin-login-email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="admin@example.com"
            type="email"
            autoComplete="email"
            spellCheck={false}
          />
        </label>
        <button
          type="button"
          className="trip-btn"
          disabled={status !== 'idle' || !email.trim()}
          onClick={() => void sendAdminLoginEmail()}
        >
          {status === 'sending' ? '送信中…' : 'ログインコードを送る'}
        </button>
        {Capacitor.isNativePlatform() && nativeRestartAction && (
          <>
            <div className="settings-note" id="native-auth-restart-help">
              前のログインを破棄すると、その認証画面や古いメールのリンクは使えなくなります。
            </div>
            <button
              type="button"
              className="trip-btn"
              disabled={status !== 'idle' || (nativeRestartAction === 'email' && !email.trim())}
              aria-describedby="native-auth-restart-help"
              onClick={() => {
                if (nativeRestartAction === 'email') {
                  void sendAdminLoginEmail(true);
                } else {
                  void startAdminGoogleLogin(true);
                }
              }}
            >
              ログインを最初からやり直す
            </button>
          </>
        )}
        <label className="settings-field" htmlFor="admin-login-token">
          <span>認証コード</span>
          <input
            id="admin-login-token"
            value={token}
            onChange={event => setToken(toHalfWidthDigits(event.target.value).replace(/\D/g, '').slice(0, 10))}
            placeholder="40055812"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={10}
          />
        </label>
        <button
          type="button"
          className="trip-btn trip-btn--primary"
          disabled={status !== 'idle' || !email.trim() || token.length < 6 || token.length > 10}
          onClick={async () => {
            setStatus('verifying');
            setNotice(null);
            const normalizedEmail = normalizeEmailInput(email);
            const normalizedToken = toHalfWidthDigits(token).replace(/\D/g, '').slice(0, 10);
            setEmail(normalizedEmail);
            setToken(normalizedToken);
            try {
              const session = await verifyAdminEmailOtp(normalizedEmail, normalizedToken);
              setAuthenticated(session.authenticated);
              setIsAdmin(session.isAdmin);
              setNativeRestartAction(null);
              setNotice({
                kind: session.isAdmin ? 'success' : 'error',
                text: session.isAdmin
                  ? '認証しました。管理画面を開けます。'
                  : '認証しましたが、このメールアドレスは管理者として登録されていません。',
              });
            } catch (error: any) {
              setNotice({ kind: 'error', text: formatLoginError(error) });
            } finally {
              setStatus('idle');
            }
          }}
        >
          {status === 'verifying' ? '確認中…' : '認証コードでログイン'}
        </button>
        {Capacitor.isNativePlatform() && (
          <>
            <div className="settings-note" id="external-admin-session-note">
              ブラウザのログイン状態はアプリと共有されません。必要な場合はブラウザ側でもログインしてください。
            </div>
            <button
              type="button"
              className="trip-btn"
              disabled={status !== 'idle'}
              aria-describedby="external-admin-session-note"
              onClick={async () => {
                setNotice(null);
                try {
                  const opened = await openExternalUrl(EXTERNAL_ADMIN_URL);
                  if (!opened) throw new Error('ブラウザで管理画面を開けませんでした。');
                  setNotice({ kind: 'info', text: 'ブラウザで管理画面を開きました。' });
                } catch (error: any) {
                  setNotice({ kind: 'error', text: formatLoginError(error) });
                }
              }}
            >
              ブラウザで管理画面を開く
            </button>
          </>
        )}
        {Capacitor.isNativePlatform() && (
          <button
            type="button"
            className="trip-btn"
            disabled={status !== 'idle'}
            onClick={async () => {
              setNotice(null);
              try {
                const opened = await openExternalUrl('https://mail.google.com/');
                if (!opened) throw new Error('Gmail を開けませんでした。');
                setNotice({ kind: 'info', text: 'Gmail を開きました。最新の認証コードを使ってください。' });
              } catch (error: any) {
                setNotice({ kind: 'error', text: formatLoginError(error) });
              }
            }}
          >
            Gmail を開く
          </button>
        )}
        {notice && (
          <div
            className={`settings-toast${notice.kind === 'success' ? ' settings-toast--success' : ''}`}
            role={notice.kind === 'error' ? 'alert' : 'status'}
            aria-live={notice.kind === 'error' ? 'assertive' : 'polite'}
            aria-atomic="true"
          >
            {notice.text}
          </div>
        )}
      </div>
    </div>
  );
}
