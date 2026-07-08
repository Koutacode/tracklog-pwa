import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Link } from 'react-router-dom';
import {
  getAdminGoogleSignInUrl,
  getAdminSession,
  onAdminAuthStateChange,
  sendAdminMagicLink,
  verifyAdminEmailOtp,
} from '../../services/remoteAuth';
import { openExternalUrl } from '../../services/nativeShare';
import { normalizeEmailInput, toHalfWidthDigits } from '../../services/driverProfileValidation';

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
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'sending' | 'verifying' | 'google'>('idle');
  const [authenticated, setAuthenticated] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let active = true;
    void getAdminSession().then(session => {
      if (active) {
        setAuthenticated(session.authenticated);
        setIsAdmin(session.isAdmin);
      }
    });
    const unsubscribe = onAdminAuthStateChange(async () => {
      const session = await getAdminSession();
      if (active) {
        setAuthenticated(session.authenticated);
        setIsAdmin(session.isAdmin);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return (
    <div className="screen-shell">
      <div className="screen-card screen-card--narrow">
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
          <div className="settings-toast">
            このメールアドレスは管理者として登録されていません。
          </div>
        )}
        {Capacitor.isNativePlatform() && (
          <div className="settings-note">
            メール送信の上限に当たった時は、Googleログインか、既定ブラウザで <code>/admin</code> を開いて管理画面へ入れます。
          </div>
        )}
        <button
          className="trip-btn trip-btn--primary"
          disabled={status !== 'idle'}
          onClick={async () => {
            setStatus('google');
            setMessage(null);
            try {
              const url = await getAdminGoogleSignInUrl();
              if (Capacitor.isNativePlatform()) {
                await openExternalUrl(url);
                setMessage('Googleログインをブラウザで開きました。認証後にアプリへ戻ります。');
              } else {
                window.location.href = url;
              }
            } catch (error: any) {
              setMessage(formatLoginError(error));
              setStatus('idle');
            }
          }}
        >
          {status === 'google' ? 'Googleログインを開いています…' : 'Googleでログイン'}
        </button>
        <label className="settings-field">
          <span>メールアドレス</span>
          <input value={email} onChange={e => setEmail(e.target.value)} placeholder="admin@example.com" type="email" />
        </label>
        <button
          className="trip-btn"
          disabled={status !== 'idle' || !email.trim()}
          onClick={async () => {
            setStatus('sending');
            setMessage(null);
            const normalizedEmail = normalizeEmailInput(email);
            setEmail(normalizedEmail);
            try {
              await sendAdminMagicLink(normalizedEmail);
              setMessage('ログインコードを送信しました。メール本文の認証コードを入力してください。');
            } catch (error: any) {
              setMessage(formatLoginError(error));
            } finally {
              setStatus('idle');
            }
          }}
        >
          {status === 'sending' ? '送信中…' : 'ログインコードを送る'}
        </button>
        <label className="settings-field">
          <span>認証コード</span>
          <input
            value={token}
            onChange={event => setToken(toHalfWidthDigits(event.target.value).replace(/\D/g, '').slice(0, 10))}
            placeholder="40055812"
            inputMode="numeric"
            maxLength={10}
          />
        </label>
        <button
          className="trip-btn trip-btn--primary"
          disabled={status !== 'idle' || !email.trim() || token.length < 6 || token.length > 10}
          onClick={async () => {
            setStatus('verifying');
            setMessage(null);
            const normalizedEmail = normalizeEmailInput(email);
            const normalizedToken = toHalfWidthDigits(token).replace(/\D/g, '').slice(0, 10);
            setEmail(normalizedEmail);
            setToken(normalizedToken);
            try {
              const session = await verifyAdminEmailOtp(normalizedEmail, normalizedToken);
              setAuthenticated(session.authenticated);
              setIsAdmin(session.isAdmin);
              setMessage(session.isAdmin ? '認証しました。管理画面を開けます。' : '認証しましたが、このメールアドレスは管理者として登録されていません。');
            } catch (error: any) {
              setMessage(formatLoginError(error));
            } finally {
              setStatus('idle');
            }
          }}
        >
          {status === 'verifying' ? '確認中…' : '認証コードでログイン'}
        </button>
        {Capacitor.isNativePlatform() && (
          <Link
            to="/admin"
            className="trip-btn"
            style={{ textAlign: 'center', textDecoration: 'none', display: 'block' }}
          >
            アプリ内で管理画面を開く
          </Link>
        )}
        {Capacitor.isNativePlatform() && (
          <button
            className="trip-btn"
            onClick={async () => {
              setMessage(null);
              try {
                await openExternalUrl('https://mail.google.com/');
                setMessage('Gmail を開きました。最新の認証コードを使ってください。');
              } catch (error: any) {
                setMessage(error?.message ?? 'Gmail を開けませんでした');
              }
            }}
          >
            Gmail を開く
          </button>
        )}
        {message && <div className="settings-toast">{message}</div>}
      </div>
    </div>
  );
}
