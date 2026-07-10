import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { TracklogAdminMessage } from '../../domain/remoteTypes';
import {
  markAdminMessageRead,
  requestLocationFromAdminMessage,
  TRACKLOG_ADMIN_MESSAGE_EVENT,
} from '../../services/adminMessages';

type ToastItem = {
  id: string;
  body: string;
  requestLocation: boolean;
};

export default function AdminMessageToastHost() {
  const navigate = useNavigate();
  const [items, setItems] = useState<ToastItem[]>([]);
  const [requestingId, setRequestingId] = useState<string | null>(null);
  const timersRef = useRef(new Map<string, number>());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const onMessage = (event: Event) => {
      const detail = (event as CustomEvent<TracklogAdminMessage>).detail;
      if (!detail?.id || !detail.body) return;
      const item = { id: detail.id, body: detail.body, requestLocation: detail.request_location };
      setItems(current => [item, ...current.filter(existing => existing.id !== item.id)].slice(0, 3));
      const existingTimer = timersRef.current.get(item.id);
      if (existingTimer !== undefined) window.clearTimeout(existingTimer);
      const timerId = window.setTimeout(() => {
        timersRef.current.delete(item.id);
        setItems(current => current.filter(existing => existing.id !== item.id));
      }, 9000);
      timersRef.current.set(item.id, timerId);
    };
    window.addEventListener(TRACKLOG_ADMIN_MESSAGE_EVENT, onMessage);
    return () => {
      mountedRef.current = false;
      window.removeEventListener(TRACKLOG_ADMIN_MESSAGE_EVENT, onMessage);
      for (const timerId of timersRef.current.values()) window.clearTimeout(timerId);
      timersRef.current.clear();
    };
  }, []);

  if (items.length === 0) return null;

  const handleTap = async (item: ToastItem) => {
    const timerId = timersRef.current.get(item.id);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      timersRef.current.delete(item.id);
    }
    markAdminMessageRead(item.id);
    navigate(`/messages?messageId=${encodeURIComponent(item.id)}`);
    setItems(current => current.filter(existing => existing.id !== item.id));
    if (!item.requestLocation) {
      return;
    }
    const id = item.id;
    setRequestingId(id);
    try {
      await requestLocationFromAdminMessage(id);
    } finally {
      if (mountedRef.current) setRequestingId(null);
    }
  };

  return (
    <div aria-label="管理者メッセージ通知" aria-live="polite" className="admin-message-toast-host" role="region">
      {items.map(item => (
        <button
          className="admin-message-toast"
          disabled={requestingId === item.id}
          aria-label={`管理者メッセージ: ${item.body}。${item.requestLocation ? '開いて現在地を更新' : '開く'}`}
          key={item.id}
          onClick={() => void handleTap(item)}
          type="button"
        >
          <strong>TrackLog</strong>
          <span>{item.body}</span>
          <em>
            {item.requestLocation
              ? (requestingId === item.id ? '現在地を更新中' : 'タップで開いて現在地更新')
              : 'タップでメッセージを開く'}
          </em>
        </button>
      ))}
    </div>
  );
}
