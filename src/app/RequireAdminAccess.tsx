import { App as CapacitorApp } from '@capacitor/app';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { AdminSession } from '../domain/remoteTypes';
import {
  classifyAdminValidationFailure,
  getAdminValidationFailureDisposition,
} from '../services/adminSessionPolicy';
import { getAdminSession, onAdminAuthStateChange } from '../services/remoteAuth';
import AdminAccessDenied from '../ui/components/AdminAccessDenied';

const ADMIN_REVALIDATE_MS = 60_000;

type AdminGateState =
  | { kind: 'checking' }
  | { kind: 'allowed'; session: AdminSession }
  | { kind: 'stale'; session: AdminSession }
  | { kind: 'denied'; session: AdminSession }
  | { kind: 'failed' };

const signedOutAdminSession: AdminSession = {
  configured: true,
  authenticated: false,
  isAdmin: false,
  email: null,
};

export default function RequireAdminAccess({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AdminGateState>({ kind: 'checking' });
  const [refreshing, setRefreshing] = useState(true);
  const validatedSessionRef = useRef<AdminSession | null>(null);
  const validationSequenceRef = useRef(0);
  const contentRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const sequence = ++validationSequenceRef.current;
    setRefreshing(true);
    try {
      const next = await getAdminSession();
      if (sequence !== validationSequenceRef.current) return;
      if (next.authenticated && next.isAdmin) {
        validatedSessionRef.current = next;
        setState({ kind: 'allowed', session: next });
      } else {
        validatedSessionRef.current = null;
        setState({ kind: 'denied', session: next });
      }
    } catch (cause) {
      if (sequence !== validationSequenceRef.current) return;
      const failure = classifyAdminValidationFailure(cause);
      const validatedSession = validatedSessionRef.current;
      const disposition = getAdminValidationFailureDisposition(
        failure,
        !!(validatedSession?.authenticated && validatedSession.isAdmin),
      );
      if (disposition === 'retain-read-only' && validatedSession) {
        setState({ kind: 'stale', session: validatedSession });
      } else if (disposition === 'revoke') {
        validatedSessionRef.current = null;
        setState({ kind: 'denied', session: signedOutAdminSession });
      } else {
        // The first validation never exposes cached admin data.
        setState({ kind: 'failed' });
      }
    } finally {
      if (sequence === validationSequenceRef.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    let appStateListener: { remove(): Promise<void> } | null = null;
    void refresh();

    const unsubscribe = onAdminAuthStateChange(() => {
      window.setTimeout(() => void refresh(), 0);
    });
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const onOnline = () => void refresh();
    const onOffline = () => {
      const validatedSession = validatedSessionRef.current;
      if (validatedSession?.authenticated && validatedSession.isAdmin) {
        setState({ kind: 'stale', session: validatedSession });
      }
    };
    const timer = window.setInterval(() => void refresh(), ADMIN_REVALIDATE_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (active && isActive) void refresh();
    }).then(listener => {
      if (active) appStateListener = listener;
      else void listener.remove();
    });

    return () => {
      active = false;
      validationSequenceRef.current += 1;
      unsubscribe();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      if (appStateListener) void appStateListener.remove();
    };
  }, [refresh]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    content.inert = state.kind === 'stale';
    return () => {
      content.inert = false;
    };
  }, [state.kind]);

  if (state.kind === 'checking') {
    return <div className="screen-shell"><div className="screen-card">管理者権限を確認中…</div></div>;
  }
  if (state.kind === 'failed') {
    return (
      <div className="screen-shell">
        <div className="screen-card screen-card--narrow">
          <div className="screen-card__eyebrow">管理者確認</div>
          <h1 className="screen-card__title">権限を確認できません</h1>
          <div className="settings-note">
            管理画面は表示していません。通信状態を確認して再試行してください。
          </div>
          <button className="trip-btn trip-btn--primary" type="button" disabled={refreshing} onClick={() => void refresh()}>
            {refreshing ? '再確認中…' : 'もう一度確認'}
          </button>
          <Link to="/" className="trip-btn" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>
            運転者画面へ戻る
          </Link>
        </div>
      </div>
    );
  }
  if (state.kind === 'denied') {
    return <AdminAccessDenied authenticated={state.session.authenticated} />;
  }

  const readOnly = state.kind === 'stale';
  return (
    <>
      {readOnly && (
        <div className="screen-shell" role="alert">
          <div className="screen-card screen-card--narrow">
            <div className="screen-card__eyebrow">読み取り専用</div>
            <h1 className="screen-card__title">管理者権限を再確認中</h1>
            <div className="settings-note">
              通信が戻るまで確認済みの画面を保持します。承認・送信・削除などの操作は一時停止しています。
            </div>
            <button className="trip-btn trip-btn--primary" type="button" disabled={refreshing} onClick={() => void refresh()}>
              {refreshing ? '再確認中…' : '今すぐ再確認'}
            </button>
            <Link to="/" className="trip-btn" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>
              運転者画面へ戻る
            </Link>
          </div>
        </div>
      )}
      <div
        ref={contentRef}
        aria-disabled={readOnly || undefined}
        style={readOnly ? { opacity: 0.72, pointerEvents: 'none', userSelect: 'none' } : undefined}
      >
        {children}
      </div>
    </>
  );
}
