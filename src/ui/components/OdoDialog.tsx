import { useEffect, useState } from 'react';

interface OdoDialogProps {
  open: boolean;
  title: string;
  description?: string;
  initialValue?: number;
  confirmText?: string;
  onCancel: () => void;
  onConfirm: (odoKm: number) => void;
}

export default function OdoDialog(props: OdoDialogProps) {
  const { open, title, description, initialValue, confirmText = '保存', onCancel, onConfirm } = props;
  const [value, setValue] = useState('');

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return;
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
  if (!open) return null;
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.6)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        padding: '16px 12px',
        overflowY: 'auto',
        zIndex: 9999,
      }}
    >
      <div
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
        <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>{title}</div>
        {description && <div style={{ opacity: 0.85, marginBottom: 12 }}>{description}</div>}
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              inputMode="none"
              readOnly
              onFocus={e => e.currentTarget.blur()}
              placeholder="オドメーター（km）"
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
                  type="button"
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
            <button type="button" onClick={onCancel} style={{ padding: '10px 14px', borderRadius: 12 }}>
              キャンセル
            </button>
            <button
              type="submit"
              style={{ padding: '10px 14px', borderRadius: 12, fontWeight: 800 }}
            >
              {confirmText}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
