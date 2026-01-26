interface UpdateDialogProps {
  open: boolean;
  onClose: () => void;
  onUpdate: () => void;
  version?: string;
}

export default function UpdateDialog({ open, onClose, onUpdate, version }: UpdateDialogProps) {
  if (!open) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'grid', placeItems: 'center', zIndex: 9999 }}>
      <div style={{ width: 'min(420px, 92vw)', background: '#111', color: '#fff', borderRadius: 16, padding: 16 }}>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>更新があります</div>
        <div style={{ opacity: 0.9, marginBottom: 6 }}>
          更新するとすぐ反映されます。
        </div>
        {version && (
          <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 12, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <span style={{ padding: '4px 8px', borderRadius: 999, background: '#1f2937', border: '1px solid #374151' }}>現在: v{version}</span>
            <span style={{ opacity: 0.85 }}>再読み込みで反映</span>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '10px 14px', borderRadius: 12 }}>
            後で
          </button>
          <button onClick={onUpdate} style={{ padding: '10px 14px', borderRadius: 12, fontWeight: 700 }}>
            更新
          </button>
        </div>
      </div>
    </div>
  );
}
