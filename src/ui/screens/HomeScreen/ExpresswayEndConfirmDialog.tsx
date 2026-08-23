import { useEffect, useId, useRef } from 'react';

type ExpresswayEndConfirmDialogProps = {
  open: boolean;
  busy: boolean;
  detectedAutomatically?: boolean;
  errorMessage: string | null;
  onContinue: () => void;
  onEnd: () => void;
};

export default function ExpresswayEndConfirmDialog(props: ExpresswayEndConfirmDialogProps) {
  const { open, busy, detectedAutomatically = false, errorMessage, onContinue, onEnd } = props;
  const titleId = useId();
  const descriptionId = useId();
  const continueRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [open]);

  useEffect(() => {
    if (open && !busy) window.setTimeout(() => continueRef.current?.focus(), 0);
  }, [busy, open]);

  if (!open) return null;

  return (
    <div className="home-confirm-overlay" role="presentation">
      <div
        ref={panelRef}
        className="home-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            if (!busy) onContinue();
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
      >
        <div className="home-confirm-dialog__eyebrow">高速道路の確認</div>
        <h2 id={titleId}>高速道路を降りましたか？</h2>
        <p id={descriptionId}>
          {detectedAutomatically
            ? '走行状態から高速道路を降りた可能性を検知しました。終了すると検知地点から出口ICを確認します。'
            : '終了すると現在地から出口ICを確認し、この高速区間を確定します。'}
        </p>
        {errorMessage && <div className="home-confirm-dialog__error" role="alert">{errorMessage}</div>}
        <div className="home-confirm-dialog__actions">
          <button ref={continueRef} type="button" disabled={busy} onClick={onContinue}>
            まだ高速中
          </button>
          <button type="button" className="home-confirm-dialog__end" disabled={busy} onClick={onEnd}>
            {busy ? '終了処理中…' : '終了してICを確定'}
          </button>
        </div>
      </div>
    </div>
  );
}
