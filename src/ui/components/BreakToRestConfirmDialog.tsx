import { useEffect, useId, useRef } from 'react';

interface BreakToRestConfirmDialogProps {
  open: boolean;
  busy?: boolean;
  errorMessage?: string | null;
  onApprove: () => void;
  onDecline: () => void;
}

export default function BreakToRestConfirmDialog(props: BreakToRestConfirmDialogProps) {
  const { open, busy = false, errorMessage, onApprove, onDecline } = props;
  const titleId = useId();
  const descriptionId = useId();
  const approveRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && !busy) window.setTimeout(() => approveRef.current?.focus(), 0);
  }, [busy, open]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 12000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        background: 'rgba(0,0,0,.72)',
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (event.key !== 'Tab') return;
          const focusable = Array.from(
            panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [],
          );
          if (focusable.length === 0) {
            event.preventDefault();
            return;
          }
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        style={{
          width: 'min(440px, 100%)',
          border: '1px solid rgba(96,165,250,.55)',
          borderRadius: 16,
          padding: 20,
          background: '#111827',
          color: '#fff',
          boxShadow: '0 24px 64px rgba(0,0,0,.55)',
        }}
      >
        <div id={titleId} style={{ fontSize: 20, fontWeight: 900 }}>
          休息に変更してよろしいですか？
        </div>
        <div id={descriptionId} style={{ marginTop: 10, lineHeight: 1.7, color: '#d1d5db' }}>
          「はい」を選ぶと、休憩の開始時刻から休息として記録し、次に現在のODOを入力します。
          「いいえ」を選ぶと、この休憩は休憩のまま継続し、再確認しません。
        </div>
        {errorMessage && (
          <div role="alert" style={{ marginTop: 12, color: '#fecaca' }}>
            {errorMessage}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 20 }}>
          <button
            ref={approveRef}
            type="button"
            disabled={busy}
            onClick={onApprove}
            style={{ minHeight: 52, borderRadius: 12, fontSize: 17, fontWeight: 900 }}
          >
            {busy ? '処理中…' : 'はい'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onDecline}
            style={{ minHeight: 52, borderRadius: 12, fontSize: 17, fontWeight: 900 }}
          >
            いいえ
          </button>
        </div>
      </div>
    </div>
  );
}
