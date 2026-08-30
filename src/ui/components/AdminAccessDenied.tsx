import { Capacitor } from '@capacitor/core';
import { Link, Navigate } from 'react-router-dom';
import { signOutAdmin } from '../../services/remoteAuth';

type Props = {
  authenticated: boolean;
  error?: string | null;
};

export default function AdminAccessDenied({ authenticated, error }: Props) {
  const usesDriverAccount = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  if (!authenticated) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="screen-shell">
      <div className="screen-card screen-card--narrow">
        <div className="screen-card__header">
          <div>
            <div className="screen-card__eyebrow">管理者確認</div>
            <h1 className="screen-card__title">管理者権限がありません</h1>
          </div>
        </div>
        <div className="settings-note">
          {usesDriverAccount
            ? 'この端末で使用中のアカウントは、管理者として有効化されていません。'
            : '管理者として登録されているメールアドレスでログインしてください。'}
        </div>
        {error && <div className="settings-toast">{error}</div>}
        {!usesDriverAccount && (
          <button
            className="trip-btn"
            type="button"
            onClick={async () => {
              await signOutAdmin();
              window.location.href = '/login';
            }}
          >
            ログアウトしてログインし直す
          </button>
        )}
        <Link to="/" className="trip-btn" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>
          {usesDriverAccount ? '運転者画面へ戻る' : 'ホームへ戻る'}
        </Link>
      </div>
    </div>
  );
}
