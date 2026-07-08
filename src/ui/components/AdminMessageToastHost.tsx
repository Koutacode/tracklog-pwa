import { useEffect, useState } from 'react';
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

  useEffect(() => {
    const onMessage = (event: Event) => {
      const detail = (event as CustomEvent<TracklogAdminMessage>).detail;
      if (!detail?.id || !detail.body) return;
      const item = { id: detail.id, body: detail.body, requestLocation: detail.request_location };
      setItems(current => [item, ...current.filter(existing => existing.id !== item.id)].slice(0, 3));
      window.setTimeout(() => {
        setItems(current => current.filter(existing => existing.id !== item.id));
      }, 9000);
    };
    window.addEventListener(TRACKLOG_ADMIN_MESSAGE_EVENT, onMessage);
    return () => {
      window.removeEventListener(TRACKLOG_ADMIN_MESSAGE_EVENT, onMessage);
    };
  }, []);

  if (items.length === 0) return null;

  const handleTap = async (item: ToastItem) => {
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
      setRequestingId(null);
    }
  };

  return (
    <div className="admin-message-toast-host" aria-live="polite">
      {items.map(item => (
        <button
          className="admin-message-toast"
          disabled={requestingId === item.id}
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
