import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Link } from 'react-router-dom';
import { getAdminRedirectUrl, getAdminSession, getDefaultAdminEmail, onAdminAuthStateChange, sendAdminMagicLink } from '../../services/remoteAuth';

export default function LoginScreen() {
  const [email, setEmail] = useState(getDefaultAdminEmail());
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'sending'>('idle');
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
            <h1 className="screen-card__title">メールリンクでサインイン</h1>
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
          初期管理者メールは <strong>{getDefaultAdminEmail()}</strong> を前提にしています。リンクを開くとそのまま管理画面へ入ります。
        </div>
        {Capacitor.isNativePlatform() && (
          <div className="settings-note">
            ネイティブアプリでは magic link の戻り先を <code>{getAdminRedirectUrl()}</code> にしています。
          </div>
        )}
        <label className="settings-field">
          <span>メールアドレス</span>
          <input value={email} onChange={e => setEmail(e.target.value)} placeholder="admin@example.com" />
        </label>
        <button
          className="trip-btn trip-btn--primary"
          disabled={status === 'sending'}
          onClick={async () => {
            setStatus('sending');
            setMessage(null);
            try {
              await sendAdminMagicLink(email);
              setMessage('ログインリンクを送信しました。メールから開いてください。');
            } catch (error: any) {
              setMessage(error?.message ?? 'リンク送信に失敗しました');
            } finally {
              setStatus('idle');
            }
          }}
        >
          {status === 'sending' ? '送信中…' : 'ログインリンクを送る'}
        </button>
        {message && <div className="settings-toast">{message}</div>}
      </div>
    </div>
  );
}
