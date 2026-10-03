import { useEffect, useId, useRef, useState } from 'react';

interface FuelDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: (liters: number) => void;
}

export default function FuelDialog({ open, onCancel, onConfirm }: FuelDialogProps) {
  const [value, setValue] = useState('');
  const titleId = useId();
  const descriptionId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const liters = Number(value);
  const canConfirm = value.trim() !== '' && Number.isFinite(liters) && liters > 0;
  useEffect(() => {
    if (!open) return;
    setValue('');
    const previousFocus = document.activeElement;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'grid', placeItems: 'center', padding: 12, overflowY: 'auto', zIndex: 9999 }}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
            return;
          }
          if (event.key !== 'Tab') return;
          const controls = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('input, button:not([disabled])') ?? []);
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
        style={{ width: 'min(520px, 100%)', maxHeight: 'calc(100dvh - 24px)', overflowY: 'auto', background: '#111', color: '#fff', borderRadius: 16, padding: 16 }}
      >
        <div id={titleId} style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>給油記録</div>
        <div id={descriptionId} style={{ opacity: 0.85, marginBottom: 12 }}>給油量を入力してください</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            ref={inputRef}
            aria-label="給油量（L）"
            inputMode="decimal"
            placeholder="給油量（L）"
            value={value}
            onChange={e => setValue(e.target.value.replace(/[^\d.]/g, ''))}
            style={{
              flex: 1,
              minWidth: 0,
              height: 48,
              borderRadius: 12,
              border: '1px solid #374151',
              background: '#0b0b0b',
              color: '#fff',
              padding: '0 12px',
              fontSize: 18,
              fontWeight: 700,
            }}
          />
          <span style={{ opacity: 0.85 }}>L</span>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" onClick={onCancel} style={{ minHeight: 48, padding: '10px 14px', borderRadius: 12 }}>
            戻る
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={() => {
              const n = Number(value);
              if (!Number.isFinite(n) || n <= 0) return;
              onConfirm(n);
            }}
            style={{ minHeight: 48, padding: '10px 14px', borderRadius: 12, fontWeight: 800 }}
          >
            記録
          </button>
        </div>
      </div>
    </div>
  );
}
