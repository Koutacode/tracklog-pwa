import type { AppEvent } from '../../../domain/types';
import type {
  PendingExpresswayEndDecision,
  PendingExpresswayEndPrompt,
} from '../../../db/repositories';
import type { NativeResidentLocationStatus } from '../../../services/nativeResidentLocation';
import type { StartupDiagnosticItem } from '../../../services/startupDiagnostics';

export type HomeStatusTone = 'success' | 'warning' | 'error' | 'neutral';

export type HomeStatusSummary = {
  label: string;
  value: string;
  detail: string;
  tone: HomeStatusTone;
  icon: string;
};

export function selectPendingExpresswayEndPrompt(params: {
  activeTripId: string | null;
  expresswayActive: boolean;
  prompt: PendingExpresswayEndPrompt | null;
}): PendingExpresswayEndPrompt | null {
  const { activeTripId, expresswayActive, prompt } = params;
  if (!activeTripId || !expresswayActive || prompt?.tripId !== activeTripId) return null;
  return prompt;
}

export function buildPendingExpresswayKeepDecision(
  prompt: PendingExpresswayEndPrompt,
  decidedAt: string,
): PendingExpresswayEndDecision {
  return {
    tripId: prompt.tripId,
    action: 'keep',
    decidedAt,
    speedKmh: prompt.speedKmh,
    geo: prompt.geo,
  };
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function formatClock(timestampMs: number): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return 'まだ送信なし';
  return new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestampMs));
}

function sumLocationRejectCounts(counts: Record<string, number>): number {
  let total = 0;
  for (const value of Object.values(counts)) {
    if (!Number.isFinite(value) || value <= 0) continue;
    total = Math.min(Number.MAX_SAFE_INTEGER, total + Math.trunc(value));
  }
  return total;
}

function formatNativeRecordingDetail(status: NativeResidentLocationStatus): string {
  const queued = Math.max(0, Math.trunc(status.queuedPointCount || 0));
  const parts = [
    `未送信: ${queued}件（最終送信: ${formatClock(status.lastUploadAt)}）`,
    `最終位置: ${status.lastAcceptedLocationAt > 0 ? formatClock(status.lastAcceptedLocationAt) : '取得待ち'}`,
  ];
  if (status.lastQueueWriteAt > 0) {
    parts.push(`最終保存: ${formatClock(status.lastQueueWriteAt)}`);
  }
  const hasCurrentQualitySession = status.locationQualitySessionStartedAt > 0
    && status.locationQualityUpdatedAt > 0;
  const rejected = hasCurrentQualitySession
    ? sumLocationRejectCounts(status.locationRejectCounts)
    : 0;
  if (rejected > 0) parts.push(`今回の位置品質除外: ${rejected}件`);
  return parts.join(' / ');
}

function summarizeQueueStorageProblem(status: NativeResidentLocationStatus): HomeStatusSummary | null {
  const failureCount = Math.max(0, Math.trunc(status.queueWriteFailureCount || 0));
  const storageUnhealthy = status.queueStorageHealthy === false;
  const failureTime = status.lastQueueWriteFailureAt > 0
    ? `（最終失敗: ${formatClock(status.lastQueueWriteFailureAt)}）`
    : '';
  if (storageUnhealthy) {
    return {
      label: '位置記録',
      value: '記録保存エラー',
      detail: `端末内に記録を保存できません${failureTime}。再診断して端末の状態を確認してください`,
      tone: 'error',
      icon: '!',
    };
  }

  const writeRecovered = failureCount > 0
    && status.lastQueueWriteFailureAt > 0
    && status.lastQueueWriteAt > status.lastQueueWriteFailureAt;
  if (failureCount > 0 && !writeRecovered) {
    return {
      label: '位置記録',
      value: '記録保存を確認',
      detail: `今回の記録で端末内保存に${failureCount}件失敗しました${failureTime}。再診断してください`,
      tone: 'warning',
      icon: '!',
    };
  }

  const queueAtHighWater = status.queuedStorageBytes >= 128 * 1024 * 1024
    || status.queueSegmentCount >= 128;
  const hasQuarantinedRecords = status.quarantinedStorageBytes > 0
    || status.quarantineSegmentCount > 0;
  if (queueAtHighWater) {
    return {
      label: '位置記録',
      value: '未送信記録を確認',
      detail: `未送信の記録が多くなっています。通信とログインを確認してください${hasQuarantinedRecords ? '。一部の記録を安全に退避しました' : ''}`,
      tone: 'warning',
      icon: '!',
    };
  }
  if (hasQuarantinedRecords) {
    return {
      label: '位置記録',
      value: '記録を確認',
      detail: '一部の記録を安全に退避しました。記録を保ったまま再診断できます',
      tone: 'warning',
      icon: '!',
    };
  }
  return null;
}

export function summarizeDiagnostics(
  items: StartupDiagnosticItem[],
  loading: boolean,
): HomeStatusSummary {
  if (loading) {
    return {
      label: '端末の準備',
      value: '確認中',
      detail: '位置情報・通知・通信を確認しています',
      tone: 'neutral',
      icon: '…',
    };
  }
  if (items.length === 0) {
    return {
      label: '端末の準備',
      value: '未確認',
      detail: '出発前に状態を確認してください',
      tone: 'neutral',
      icon: '○',
    };
  }
  const errors = items.filter(item => item.level === 'error');
  if (errors.length > 0) {
    return {
      label: '端末の準備',
      value: '要設定',
      detail: errors[0].detail,
      tone: 'error',
      icon: '!',
    };
  }
  const warnings = items.filter(item => item.level === 'warn');
  if (warnings.length > 0) {
    return {
      label: '端末の準備',
      value: '確認あり',
      detail: warnings[0].detail,
      tone: 'warning',
      icon: '!',
    };
  }
  return {
    label: '端末の準備',
    value: '準備完了',
    detail: '位置情報・通知・通信を確認済みです',
    tone: 'success',
    icon: '✓',
  };
}

export function summarizeLocation(
  geoStatus: { address?: string } | null,
  geoError: string | null,
): HomeStatusSummary {
  if (geoError) {
    return {
      label: '現在地',
      value: '取得失敗',
      detail: geoError,
      tone: 'error',
      icon: '!',
    };
  }
  if (geoStatus) {
    return {
      label: '現在地',
      value: '取得済み',
      detail: hasText(geoStatus.address) ? geoStatus.address.trim() : '位置情報を記録できます',
      tone: 'success',
      icon: '✓',
    };
  }
  return {
    label: '現在地',
    value: '未取得',
    detail: '運行開始や記録操作のときに確認します',
    tone: 'neutral',
    icon: '○',
  };
}

export function summarizeRouteTracking(params: {
  tripActive: boolean;
  isAndroidNative: boolean;
  nativeStatus: NativeResidentLocationStatus | null;
  routeTrackingError: string | null;
}): HomeStatusSummary {
  const { tripActive, isAndroidNative, nativeStatus, routeTrackingError } = params;
  if (routeTrackingError) {
    return {
      label: '位置記録',
      value: '確認が必要',
      detail: routeTrackingError,
      tone: 'error',
      icon: '!',
    };
  }
  if (!tripActive) {
    return {
      label: '位置記録',
      value: '未開始',
      detail: '運行開始後にルートを記録します',
      tone: 'neutral',
      icon: '○',
    };
  }
  if (!isAndroidNative) {
    return {
      label: '位置記録',
      value: '運行中（PWA）',
      detail: 'PWAを閉じずに位置情報を許可してください',
      tone: 'neutral',
      icon: '○',
    };
  }
  if (!nativeStatus) {
    return {
      label: '位置記録',
      value: '確認中',
      detail: 'バックグラウンド記録の状態を確認しています',
      tone: 'neutral',
      icon: '…',
    };
  }
  if (nativeStatus.authorizationBlocked) {
    return {
      label: '位置記録',
      value: '要ログイン',
      detail: '同期を再開するためログイン状態を確認してください',
      tone: 'error',
      icon: '!',
    };
  }
  const queueStorageProblem = summarizeQueueStorageProblem(nativeStatus);
  if (queueStorageProblem) return queueStorageProblem;
  if (nativeStatus.running) {
    return {
      label: '位置記録',
      value: '記録中',
      detail: formatNativeRecordingDetail(nativeStatus),
      tone: 'success',
      icon: '●',
    };
  }
  if (!nativeStatus.approved || !nativeStatus.setupComplete) {
    return {
      label: '位置記録',
      value: '利用準備中',
      detail: 'ログインと利用登録の状態を確認してください',
      tone: 'warning',
      icon: '!',
    };
  }
  if (!nativeStatus.ready || !nativeStatus.eligible) {
    return {
      label: '位置記録',
      value: '要設定',
      detail: '位置情報と通知の端末設定を確認してください',
      tone: 'warning',
      icon: '!',
    };
  }
  if (nativeStatus.startRequested) {
    return {
      label: '位置記録',
      value: '開始待ち',
      detail: '端末の位置情報が有効になると自動で開始します',
      tone: 'warning',
      icon: '!',
    };
  }
  return {
    label: '位置記録',
    value: '停止中',
    detail: nativeStatus.lastAcceptedLocationAt > 0
      ? `最終位置: ${formatClock(nativeStatus.lastAcceptedLocationAt)}。再診断して端末設定を確認してください`
      : '再診断して端末設定を確認してください',
    tone: 'warning',
    icon: '■',
  };
}

function getExtras(event: AppEvent | null | undefined): Record<string, unknown> {
  return event?.extras ?? {};
}

function summarizeIcEvent(event: AppEvent, phase: '開始' | '終了'): HomeStatusSummary {
  const extras = getExtras(event);
  const status = extras.icResolveStatus;
  const icName = hasText(extras.icName) ? extras.icName.trim() : '';
  const hasRetry = hasText(extras.icResolveNextRetryAt);
  if (status === 'resolved' && icName) {
    return {
      label: '高速区間',
      value: phase === '開始' ? `高速区間（${icName}から）` : `直近の終了IC: ${icName}`,
      detail: `${phase}ICを記録済みです`,
      tone: 'success',
      icon: '✓',
    };
  }
  if (status === 'failed') {
    return {
      label: '高速区間',
      value: hasRetry ? `${phase}ICを再確認中` : `${phase}ICが特定できませんでした`,
      detail: hasRetry ? '通信できるときに自動で再確認します' : '運行履歴からIC名を修正できます',
      tone: hasRetry ? 'warning' : 'error',
      icon: '!',
    };
  }
  return {
    label: '高速区間',
    value: `${phase}ICを確認中…`,
    detail: '位置情報から最寄りのICを確認しています',
    tone: 'neutral',
    icon: '…',
  };
}

export function summarizeExpressway(
  events: AppEvent[],
  openStart: AppEvent | null,
): HomeStatusSummary {
  if (openStart) return summarizeIcEvent(openStart, '開始');

  const latestEnd = [...events]
    .filter(event => event.type === 'expressway_end')
    .sort((a, b) => b.ts.localeCompare(a.ts))[0];
  if (latestEnd) return summarizeIcEvent(latestEnd, '終了');

  return {
    label: '高速区間',
    value: '高速区間なし',
    detail: '高速道路への進入を自動検知します。必要な場合は手動開始もできます',
    tone: 'neutral',
    icon: '○',
  };
}
