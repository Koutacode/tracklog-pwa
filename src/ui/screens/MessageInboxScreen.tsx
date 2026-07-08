import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  getStoredAdminMessages,
  markAdminMessageRead,
  markAllAdminMessagesRead,
  pollTracklogAdminMessages,
  TRACKLOG_ADMIN_MESSAGE_STORE_EVENT,
  type StoredAdminMessage,
} from '../../services/adminMessages';

function formatDateTime(ts: string) {
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) return '-';
  return new Intl.DateTimeFormat('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function loadMessages() {
  return getStoredAdminMessages();
}

export default function MessageInboxScreen() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [messages, setMessages] = useState<StoredAdminMessage[]>(() => loadMessages());
  const [refreshing, setRefreshing] = useState(false);
  const selectedId = searchParams.get('messageId')?.trim() || null;

  const selectedMessage = useMemo(
    () => messages.find(message => message.id === selectedId) ?? messages[0] ?? null,
    [messages, selectedId],
  );
  const unreadCount = messages.filter(message => !message.readAt).length;

  const refreshLocal = () => {
    setMessages(loadMessages());
  };

  useEffect(() => {
    const onStoreChange = () => refreshLocal();
    window.addEventListener(TRACKLOG_ADMIN_MESSAGE_STORE_EVENT, onStoreChange);
    return () => {
      window.removeEventListener(TRACKLOG_ADMIN_MESSAGE_STORE_EVENT, onStoreChange);
    };
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    markAdminMessageRead(selectedId);
    refreshLocal();
  }, [selectedId]);

  const refreshRemote = async () => {
    setRefreshing(true);
    try {
      await pollTracklogAdminMessages({ force: true });
      refreshLocal();
    } finally {
      setRefreshing(false);
    }
  };

  const selectMessage = (message: StoredAdminMessage) => {
    setSearchParams({ messageId: message.id });
  };

  return (
    <div className="screen-shell">
      <div className="screen-card">
        <div className="screen-card__header">
          <div>
            <div className="screen-card__eyebrow">管理者メッセージ</div>
            <h1 className="screen-card__title">受信メッセージ</h1>
          </div>
          <div className="screen-card__actions">
            <Link to="/" className="pill-link">ホーム</Link>
            <Link to="/settings" className="pill-link">設定</Link>
          </div>
        </div>

        <section className="message-inbox">
          <div className="message-inbox__summary card">
            <div>
              <span>未読</span>
              <strong>{unreadCount}件</strong>
            </div>
            <div>
              <span>保存件数</span>
              <strong>{messages.length}件</strong>
            </div>
            <button className="trip-btn" disabled={refreshing} onClick={refreshRemote} type="button">
              {refreshing ? '再取得中…' : '再取得'}
            </button>
            <button
              className="trip-btn trip-btn--ghost"
              disabled={messages.length === 0 || unreadCount === 0}
              onClick={() => {
                markAllAdminMessagesRead();
                refreshLocal();
              }}
              type="button"
            >
              すべて既読
            </button>
          </div>

          {selectedMessage && (
            <article className="message-inbox__detail card">
              <div className="message-inbox__detail-head">
                <strong>TrackLog</strong>
                <span>{formatDateTime(selectedMessage.sentAt)}</span>
              </div>
              <p>{selectedMessage.body}</p>
              <div className="message-inbox__meta">
                {selectedMessage.requestLocation ? '通知タップ時に現在地更新あり' : '現在地更新なし'}
              </div>
            </article>
          )}

          <div className="message-inbox__list">
            {messages.length === 0 ? (
              <div className="card message-inbox__empty">
                受信した管理者メッセージはまだありません。
              </div>
            ) : (
              messages.map(message => (
                <button
                  className={`message-inbox__item${message.id === selectedMessage?.id ? ' message-inbox__item--selected' : ''}${message.readAt ? '' : ' message-inbox__item--unread'}`}
                  key={message.id}
                  onClick={() => selectMessage(message)}
                  type="button"
                >
                  <span>{formatDateTime(message.sentAt)}</span>
                  <strong>{message.body}</strong>
                  <em>{message.readAt ? '既読' : '未読'}</em>
                </button>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
