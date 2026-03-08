import { useEffect, useMemo, useState } from 'react';
import { restoreSnapshotJson } from '../db/repositories';

type RecoveryModule = {
  recoveryPayloadId?: string;
  recoveryPayloadJson?: string;
};

const recoveryModules = import.meta.glob('./recoveryPayload.local.ts', {
  eager: true,
}) as Record<string, RecoveryModule>;

const recoveryModule = Object.values(recoveryModules)[0] ?? null;
const RECOVERY_MARKER_PREFIX = 'tracklog:local-recovery:';

function getRecoveryMarkerId(): string | null {
  if (!recoveryModule?.recoveryPayloadJson) return null;
  const explicitId =
    typeof recoveryModule.recoveryPayloadId === 'string' ? recoveryModule.recoveryPayloadId.trim() : '';
  if (explicitId) return explicitId;
  return `inline-${recoveryModule.recoveryPayloadJson.length}`;
}

export default function LocalRecoveryBootstrap() {
  const [message, setMessage] = useState<string | null>(null);
  const markerKey = useMemo(() => {
    const markerId = getRecoveryMarkerId();
    return markerId ? `${RECOVERY_MARKER_PREFIX}${markerId}` : null;
  }, []);

  useEffect(() => {
    const payloadJson = recoveryModule?.recoveryPayloadJson;
    if (!markerKey || !payloadJson) return;
    if (window.localStorage.getItem(markerKey) === 'done') return;

    let cancelled = false;
    void (async () => {
      try {
        const result = await restoreSnapshotJson(payloadJson);
        window.localStorage.setItem(markerKey, 'done');
        if (!cancelled) {
          setMessage(
            result.activeTripId
              ? `復元ペイロードを適用しました。${result.importedEvents}件を戻し、運行を再開状態にしました。`
              : `復元ペイロードを適用しました。${result.importedEvents}件を戻しました。`
          );
        }
      } catch (error: any) {
        if (!cancelled) {
          setMessage(error?.message ? `復元に失敗しました: ${error.message}` : '復元に失敗しました');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [markerKey]);

  if (!message) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 12,
        left: 12,
        right: 12,
        zIndex: 1000,
        padding: '10px 14px',
        borderRadius: 14,
        background: 'rgba(15, 23, 42, 0.92)',
        border: '1px solid rgba(148, 163, 184, 0.25)',
        color: '#f8fafc',
        boxShadow: '0 18px 40px rgba(15, 23, 42, 0.32)',
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      {message}
    </div>
  );
}
