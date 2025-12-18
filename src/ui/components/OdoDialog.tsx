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

  useEffect(() => {
    if (open) {
      setValue(initialValue != null ? String(initialValue) : '');
    }
  }, [open, initialValue]);
  if (!open) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'grid', placeItems: 'center', zIndex: 9999 }}>
      <div style={{ width: 'min(520px, 92vw)', background: '#111', color: '#fff', borderRadius: 16, padding: 16 }}>
        <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>{title}</div>
        {description && <div style={{ opacity: 0.85, marginBottom: 12 }}>{description}</div>}
        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="number"
              inputMode="decimal"
              enterKeyHint="done"
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  handleSubmit(e);
                }
              }}
              placeholder="オドメーター（km）"
              value={value}
              onChange={e => setValue(e.target.value.replace(/[^\d.]/g, ''))}
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
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
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
