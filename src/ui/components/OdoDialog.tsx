import { useEffect, useId, useRef, useState } from 'react';

interface OdoDialogProps {
  open: boolean;
  title: string;
  description?: string;
  initialValue?: number;
  confirmText?: string;
  allowZero?: boolean;
  cancelable?: boolean;
  busy?: boolean;
  errorMessage?: string | null;
  zIndex?: number;
  onCancel: () => void;
  onConfirm: (odoKm: number) => void;
}

export default function OdoDialog(props: OdoDialogProps) {
  const {
    open,
    title,
    description,
    initialValue,
    confirmText = '確定',
    allowZero = false,
    cancelable = true,
    busy = false,
    errorMessage,
    zIndex = 9999,
    onCancel,
    onConfirm,
  } = props;
  const [value, setValue] = useState('');
  const titleId = useId();
  const descriptionId = useId();
  const firstDigitRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0) || busy) return;
    onConfirm(n);
  };

  const handleDigit = (d: string) => {
    setValue(prev => {
      if (!prev || prev === '0') return d;
      return (prev + d).replace(/^0+/, '') || '0';
    });
  };

  const handleBackspace = () => {
    setValue(prev => (prev.length > 1 ? prev.slice(0, -1) : ''));
  };

  const handleClear = () => setValue('');

  useEffect(() => {
    if (open) {
      setValue(initialValue != null ? String(initialValue) : '');
    }
  }, [open, initialValue]);
  useEffect(() => {
    if (open && !busy) window.setTimeout(() => firstDigitRef.current?.focus(), 0);
  }, [busy, open]);
  if (!open) return null;
  const parsedValue = Number(value);
  const canConfirm = value !== ''
    && Number.isFinite(parsedValue)
    && parsedValue >= 0
    && (allowZero || parsedValue > 0)
    && !busy;
  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.6)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-end',
        padding: '16px 12px 24px',
        overflowY: 'auto',
        zIndex,
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        aria-busy={busy}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (cancelable && !busy) onCancel();
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
          width: 'min(520px, 100%)',
          background: '#111',
          color: '#fff',
          borderRadius: 16,
          padding: 16,
          marginTop: 24,
          maxHeight: '90vh',
          boxSizing: 'border-box',
        }}
      >
        <div id={titleId} style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>{title}</div>
        {description && <div id={descriptionId} style={{ opacity: 0.85, marginBottom: 12 }}>{description}</div>}
        {allowZero && (
          <div style={{ color: '#bfdbfe', fontSize: 13, marginBottom: 12 }}>
            0 kmで確定した場合、休息は開始しますが距離は記録しません。
          </div>
        )}
        {errorMessage && (
          <div role="alert" style={{ color: '#fecaca', marginBottom: 12 }}>
            {errorMessage}
          </div>
        )}
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              inputMode="none"
              readOnly
              aria-label="オドメーター"
              onFocus={e => e.currentTarget.blur()}
              placeholder="ODO（km）"
              value={value}
              style={{
                flex: 1,
                height: 52,
                borderRadius: 12,
                border: '1px solid #374151',
                background: '#0b0b0b',
                color: '#fff',
                padding: '0 12px',
                fontSize: 18,
                fontWeight: 700,
              }}
            />
            <span style={{ opacity: 0.85 }}>km</span>
          </div>
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
              {[1,2,3,4,5,6,7,8,9].map(n => (
                <button
                  key={n}
                  ref={n === 1 ? firstDigitRef : undefined}
                  type="button"
                  aria-label={`${n}を入力`}
                  disabled={busy}
                  onClick={() => handleDigit(String(n))}
                  style={{
                    height: 64,
                    borderRadius: 14,
                    border: '1px solid #374151',
                    background: '#1f2937',
                    color: '#fff',
                    fontSize: 20,
                    fontWeight: 800,
                    padding: '10px 0',
                  }}
                >
                  {n}
                </button>
              ))}
              <button
                type="button"
                aria-label="入力をすべて消去"
                disabled={busy}
                onClick={handleClear}
                style={{
                  height: 64,
                  borderRadius: 14,
                  border: '1px solid #374151',
                  background: '#0f172a',
                  color: '#e5e7eb',
                  fontSize: 18,
                  fontWeight: 700,
                  padding: '10px 0',
                }}
              >
                C
              </button>
              <button
                type="button"
                aria-label="0を入力"
                disabled={busy}
                onClick={() => handleDigit('0')}
                style={{
                  height: 64,
                  borderRadius: 14,
                  border: '1px solid #374151',
                  background: '#1f2937',
                  color: '#fff',
                  fontSize: 20,
                  fontWeight: 800,
                  padding: '10px 0',
                }}
              >
                0
              </button>
              <button
                type="button"
                aria-label="1桁消去"
                disabled={busy}
                onClick={handleBackspace}
                style={{
                  height: 64,
                  borderRadius: 14,
                  border: '1px solid #374151',
                  background: '#0f172a',
                  color: '#e5e7eb',
                  fontSize: 18,
                  fontWeight: 700,
                  padding: '10px 0',
                }}
              >
                ⌫
              </button>
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              gap: 8,
              justifyContent: 'flex-end',
              marginTop: 16,
              position: 'sticky',
              bottom: 0,
              paddingTop: 8,
              paddingBottom: 'env(safe-area-inset-bottom, 6px)',
              background: '#111',
            }}
          >
            {cancelable && (
              <button
                type="button"
                disabled={busy}
                onClick={onCancel}
                style={{ padding: '10px 14px', borderRadius: 12 }}
              >
                戻る
              </button>
            )}
            <button
              type="submit"
              disabled={!canConfirm}
              style={{ padding: '10px 14px', borderRadius: 12, fontWeight: 800 }}
            >
              {busy ? '処理中…' : confirmText}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
