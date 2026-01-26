import { useEffect, useState } from 'react';

interface FuelDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: (liters: number) => void;
}

export default function FuelDialog({ open, onCancel, onConfirm }: FuelDialogProps) {
  const [value, setValue] = useState('');
  useEffect(() => {
    if (open) setValue('');
  }, [open]);
  if (!open) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'grid', placeItems: 'center', zIndex: 9999 }}>
      <div style={{ width: 'min(520px, 92vw)', background: '#111', color: '#fff', borderRadius: 16, padding: 16 }}>
        <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>給油記録</div>
        <div style={{ opacity: 0.85, marginBottom: 12 }}>給油量を入力してください</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            inputMode="decimal"
            placeholder="給油量（L）"
            value={value}
            onChange={e => setValue(e.target.value.replace(/[^\d.]/g, ''))}
            style={{
              flex: 1,
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
          <button onClick={onCancel} style={{ padding: '10px 14px', borderRadius: 12 }}>
            戻る
          </button>
          <button
            onClick={() => {
              const n = Number(value);
              if (!Number.isFinite(n) || n <= 0) return;
              onConfirm(n);
            }}
            style={{ padding: '10px 14px', borderRadius: 12, fontWeight: 800 }}
          >
            記録
          </button>
        </div>
      </div>
    </div>
  );
}
