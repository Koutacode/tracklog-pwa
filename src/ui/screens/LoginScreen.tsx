import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Link } from 'react-router-dom';
import {
  getAdminGoogleSignInUrl,
  getAdminRedirectUrl,
  getAdminSession,
  getDefaultAdminEmail,
  onAdminAuthStateChange,
  sendAdminMagicLink,
} from '../../services/remoteAuth';
import { openExternalUrl } from '../../services/nativeShare';

function formatLoginError(error: any) {
  const raw = `${error?.message ?? error ?? ''}`.trim();
  if (!raw) return 'リンク送信に失敗しました';
  const normalized = raw.toLowerCase();
  if (
    normalized.includes('rate limit') ||
    normalized.includes('email rate limit') ||
    normalized.includes('over_email_send_rate_limit')
  ) {
    return 'メール送信の上限に達しています。少し待つか、下の「ブラウザで管理画面を開く」を使ってください。';
  }
  if (normalized.includes('unsupported provider') || normalized.includes('provider is not enabled')) {
    return 'Supabase の Google ログインがまだ有効化されていません。Google provider を有効化するまではメールリンクで入ってください。';
  }
  return raw;
}

export default function LoginScreen() {
  const [email, setEmail] = useState(getDefaultAdminEmail());
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'sending' | 'google'>('idle');
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    let active = true;
    void getAdminSession().then(session => {
      if (active) setAuthenticated(session.authenticated);
    });
    const unsubscribe = onAdminAuthStateChange(async () => {
      const session = await getAdminSession();
      if (active) setAuthenticated(session.authenticated);
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
            {authenticated && (
              <Link to="/admin" className="pill-link">
                管理画面へ
              </Link>
            )}
          </div>
        </div>
        <div className="settings-note">
          管理者メールは <strong>{getDefaultAdminEmail()}</strong> を前提にしています。Googleログインまたはメールリンクで管理画面へ入れます。
        </div>
        {Capacitor.isNativePlatform() && (
          <div className="settings-note">
            ネイティブアプリでは magic link の戻り先を <code>{getAdminRedirectUrl()}</code> にしています。
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
          <input value={email} onChange={e => setEmail(e.target.value)} placeholder="admin@example.com" />
        </label>
        <button
          className="trip-btn"
          disabled={status !== 'idle'}
          onClick={async () => {
            setStatus('sending');
            setMessage(null);
            try {
              await sendAdminMagicLink(email);
              setMessage('ログインリンクを送信しました。メールから開いてください。');
            } catch (error: any) {
              setMessage(formatLoginError(error));
            } finally {
              setStatus('idle');
            }
          }}
        >
          {status === 'sending' ? '送信中…' : 'ログインリンクを送る'}
        </button>
        {Capacitor.isNativePlatform() && (
          <button
            className="trip-btn"
            onClick={async () => {
              setMessage(null);
              try {
                await openExternalUrl(`${window.location.origin}/admin`);
                setMessage('既定ブラウザで管理画面を開きました。ブラウザ側でログイン済みならそのまま入れます。');
              } catch (error: any) {
                setMessage(error?.message ?? 'ブラウザを開けませんでした');
              }
            }}
          >
            ブラウザで管理画面を開く
          </button>
        )}
        {Capacitor.isNativePlatform() && (
          <button
            className="trip-btn"
            onClick={async () => {
              setMessage(null);
              try {
                await openExternalUrl('https://mail.google.com/');
                setMessage('Gmail を開きました。最新の magic link を使ってください。');
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
