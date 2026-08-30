import assert from 'node:assert/strict';
import type { AppEvent } from '../../../domain/types';
import type { NativeResidentLocationStatus } from '../../../services/nativeResidentLocation';
import {
  findRecordingBlockingDiagnostic,
  buildPendingExpresswayKeepDecision,
  selectPendingExpresswayEndPrompt,
  summarizeDiagnostics,
  summarizeExpressway,
  summarizeLocation,
  summarizeRouteTracking,
} from './homeStatusModel';

const nativeStatus: NativeResidentLocationStatus = {
  approved: true,
  setupComplete: true,
  enabled: true,
  eligible: true,
  ready: true,
  running: true,
  startRequested: true,
  activeTripId: 'trip-1',
  routePauseAtMs: 0,
  queuedPointCount: 3,
  expresswayPendingEventCount: 0,
  expresswayStorageHealthy: true,
  expresswayOpen: false,
  expresswayPromptPending: false,
  expresswayProbePending: false,
  expresswayProbeAttemptCount: 0,
  expresswayProbeLastFailureCategory: '',
  expresswayProbeFailureUpdatedAt: 0,
  expresswayGeneration: 0,
  queuedStorageBytes: 4096,
  queueSegmentCount: 1,
  quarantinedStorageBytes: 0,
  quarantineSegmentCount: 0,
  queueStorageHealthy: true,
  authorizationConfigured: true,
  authorizationBlocked: false,
  lastUploadAt: Date.parse('2026-08-23T05:30:00.000Z'),
  lastAcceptedLocationAt: Date.parse('2026-08-23T05:31:00.000Z'),
  locationQualitySessionStartedAt: Date.parse('2026-08-23T05:00:00.000Z'),
  locationQualityUpdatedAt: Date.parse('2026-08-23T05:31:00.000Z'),
  locationRejectCounts: {
    poor_accuracy: 2,
    near_duplicate: 1,
  },
  lastQueueWriteAt: Date.parse('2026-08-23T05:31:30.000Z'),
  queueWriteFailureCount: 0,
  lastQueueWriteFailureAt: 0,
  settings: {
    foregroundLocation: true,
    backgroundLocation: true,
    notifications: true,
    batteryOptimization: true,
    locationEnabled: true,
  },
};

const route = summarizeRouteTracking({
  tripActive: true,
  isAndroidNative: true,
  nativeStatus,
  routeTrackingError: null,
});
assert.equal(route.value, '記録中');
assert.equal(route.recordingBlocked, false);
assert.equal(route.degraded, false);
assert.match(route.detail, /未送信: 3件/);
assert.match(route.detail, /最終位置:/);
assert.match(route.detail, /最終保存:/);
assert.match(route.detail, /今回の位置品質除外: 3件/);
assert.doesNotMatch(route.detail, /trip-1/);
assert.doesNotMatch(route.detail, /4096/);

const ongoingQueueFailure = summarizeRouteTracking({
  tripActive: true,
  isAndroidNative: true,
  nativeStatus: {
    ...nativeStatus,
    lastQueueWriteAt: Date.parse('2026-08-23T05:31:00.000Z'),
    queueWriteFailureCount: 2,
    lastQueueWriteFailureAt: Date.parse('2026-08-23T05:32:00.000Z'),
  },
  routeTrackingError: null,
});
assert.equal(ongoingQueueFailure.value, '記録保存を確認');
assert.equal(ongoingQueueFailure.tone, 'warning');
assert.equal(ongoingQueueFailure.recordingBlocked, true);
assert.match(ongoingQueueFailure.detail, /2件失敗/);
assert.doesNotMatch(ongoingQueueFailure.detail, /trip-1|4096/);

const recoveredQueueFailure = summarizeRouteTracking({
  tripActive: true,
  isAndroidNative: true,
  nativeStatus: {
    ...nativeStatus,
    lastQueueWriteAt: Date.parse('2026-08-23T05:34:00.000Z'),
    queueWriteFailureCount: 2,
    lastQueueWriteFailureAt: Date.parse('2026-08-23T05:32:00.000Z'),
  },
  routeTrackingError: null,
});
assert.equal(recoveredQueueFailure.value, '記録中');
assert.equal(recoveredQueueFailure.tone, 'success');
assert.equal(recoveredQueueFailure.recordingBlocked, false);
assert.doesNotMatch(recoveredQueueFailure.detail, /失敗|再診断/);

const unhealthyQueue = summarizeRouteTracking({
  tripActive: true,
  isAndroidNative: true,
  nativeStatus: {
    ...nativeStatus,
    queuedPointCount: 0,
    queueStorageHealthy: false,
  },
  routeTrackingError: null,
});
assert.equal(unhealthyQueue.value, '記録保存エラー');
assert.equal(unhealthyQueue.tone, 'error');
assert.equal(unhealthyQueue.recordingBlocked, true);
assert.match(unhealthyQueue.detail, /端末内に記録を保存できません/);

const belowHighWater = summarizeRouteTracking({
  tripActive: true,
  isAndroidNative: true,
  nativeStatus: {
    ...nativeStatus,
    queuedStorageBytes: 128 * 1024 * 1024 - 1,
    queueSegmentCount: 127,
  },
  routeTrackingError: null,
});
assert.equal(belowHighWater.value, '記録中');

const highWaterBytes = summarizeRouteTracking({
  tripActive: true,
  isAndroidNative: true,
  nativeStatus: {
    ...nativeStatus,
    queuedStorageBytes: 128 * 1024 * 1024,
  },
  routeTrackingError: null,
});
assert.equal(highWaterBytes.value, '未送信記録を確認');
assert.equal(highWaterBytes.tone, 'warning');
assert.equal(highWaterBytes.recordingBlocked, false, 'running high-water queue is degraded, not stopped');
assert.equal(highWaterBytes.degraded, true);
assert.match(highWaterBytes.detail, /未送信の記録が多くなっています/);
assert.doesNotMatch(highWaterBytes.detail, /134217728|128MiB|byte/i);

const highWaterSegments = summarizeRouteTracking({
  tripActive: true,
  isAndroidNative: true,
  nativeStatus: {
    ...nativeStatus,
    queueSegmentCount: 128,
  },
  routeTrackingError: null,
});
assert.equal(highWaterSegments.value, '未送信記録を確認');
assert.doesNotMatch(highWaterSegments.detail, /128/);

const quarantinedRecords = summarizeRouteTracking({
  tripActive: true,
  isAndroidNative: true,
  nativeStatus: {
    ...nativeStatus,
    quarantinedStorageBytes: 1,
    quarantineSegmentCount: 0,
  },
  routeTrackingError: null,
});
assert.equal(quarantinedRecords.value, '記録を確認');
assert.equal(quarantinedRecords.tone, 'warning');
assert.equal(quarantinedRecords.recordingBlocked, false, 'quarantined records do not stop the running queue');
assert.equal(quarantinedRecords.degraded, true);
assert.match(quarantinedRecords.detail, /一部の記録を安全に退避しました/);
assert.doesNotMatch(quarantinedRecords.detail, /1|byte/i);

const quarantinedSegment = summarizeRouteTracking({
  tripActive: true,
  isAndroidNative: true,
  nativeStatus: {
    ...nativeStatus,
    quarantinedStorageBytes: 0,
    quarantineSegmentCount: 1,
  },
  routeTrackingError: null,
});
assert.equal(quarantinedSegment.value, '記録を確認');
assert.match(quarantinedSegment.detail, /一部の記録を安全に退避しました/);

const unhealthyHighWaterQueue = summarizeRouteTracking({
  tripActive: true,
  isAndroidNative: true,
  nativeStatus: {
    ...nativeStatus,
    queuedStorageBytes: 128 * 1024 * 1024,
    queueStorageHealthy: false,
    queueWriteFailureCount: 0,
  },
  routeTrackingError: null,
});
assert.equal(unhealthyHighWaterQueue.value, '記録保存エラー');
assert.equal(unhealthyHighWaterQueue.tone, 'error');

const writeFailureBeforeHighWater = summarizeRouteTracking({
  tripActive: true,
  isAndroidNative: true,
  nativeStatus: {
    ...nativeStatus,
    queuedStorageBytes: 128 * 1024 * 1024,
    queueWriteFailureCount: 1,
    lastQueueWriteAt: Date.parse('2026-08-23T05:31:00.000Z'),
    lastQueueWriteFailureAt: Date.parse('2026-08-23T05:32:00.000Z'),
  },
  routeTrackingError: null,
});
assert.equal(writeFailureBeforeHighWater.value, '記録保存を確認');
assert.match(writeFailureBeforeHighWater.detail, /端末内保存/);

assert.equal(
  summarizeRouteTracking({
    tripActive: false,
    isAndroidNative: true,
    nativeStatus,
    routeTrackingError: null,
  }).value,
  '未開始',
);

assert.equal(
  summarizeRouteTracking({
    tripActive: true,
    isAndroidNative: true,
    nativeStatus: { ...nativeStatus, running: false, authorizationBlocked: true },
    routeTrackingError: null,
  }).value,
  '要ログイン',
);

assert.equal(summarizeLocation(null, null).value, '未取得');
assert.match(summarizeLocation(null, null).detail, /運行開始や記録操作/);
assert.equal(summarizeLocation(null, '位置情報を利用できません').tone, 'error');
assert.equal(summarizeLocation({ address: '東京都' }, null).detail, '東京都');

assert.equal(summarizeDiagnostics([], true).value, '確認中');
assert.equal(summarizeDiagnostics([
  { id: 'geo', label: '位置情報', detail: '要設定', level: 'error' },
], false).value, '要設定');
assert.equal(summarizeDiagnostics([
  { id: 'geo', label: '位置情報', detail: '許可済み', level: 'ok' },
], false).value, '準備完了');

assert.equal(findRecordingBlockingDiagnostic([
  { id: 'network', label: '通信状態', detail: 'オフライン', level: 'warn' },
]), null, 'offline-only warning must not claim local recording stopped');
assert.equal(findRecordingBlockingDiagnostic([
  { id: 'battery-opt', label: '電池最適化', detail: '要確認', level: 'warn' },
  { id: 'network', label: '通信状態', detail: 'オフライン', level: 'warn' },
]), null, 'non-blocking reliability warnings remain in details');
assert.equal(findRecordingBlockingDiagnostic([
  { id: 'geo', label: '位置情報', detail: '常時位置情報が拒否されています', level: 'error' },
])?.id, 'geo', 'confirmed location permission failure is critical');
assert.equal(findRecordingBlockingDiagnostic([
  { id: 'resident-service', label: '位置記録サービス', detail: '停止中', level: 'error' },
])?.id, 'resident-service', 'foreground service failure is critical');

const idleExpressway = summarizeExpressway([], null);
assert.equal(idleExpressway.value, '高速区間なし');
assert.match(idleExpressway.detail, /自動検知/);

const pendingOpenStart: AppEvent = {
  id: 'event-1',
  tripId: 'trip-1',
  type: 'expressway_start',
  ts: '2026-08-23T05:00:00.000Z',
  syncStatus: 'pending',
  extras: { icResolveStatus: 'pending' },
};
assert.equal(
  summarizeExpressway([pendingOpenStart], pendingOpenStart).value,
  '開始ICを確認中…',
);

const openStart: AppEvent = {
  ...pendingOpenStart,
  extras: { icResolveStatus: 'resolved', icName: '厚木IC' },
};
assert.equal(summarizeExpressway([openStart], openStart).value, '高速区間（厚木ICから）');

const retryingEnd: AppEvent = {
  ...openStart,
  id: 'event-2',
  type: 'expressway_end',
  ts: '2026-08-23T06:00:00.000Z',
  extras: {
    icResolveStatus: 'failed',
    icResolveNextRetryAt: '2026-08-23T06:10:00.000Z',
    icResolveError: 'internal detail that must not be rendered',
  },
};
const retryingSummary = summarizeExpressway([openStart, retryingEnd], null);
assert.equal(retryingSummary.value, '終了ICを再確認中');
assert.doesNotMatch(retryingSummary.detail, /internal detail/);

const terminalEnd: AppEvent = {
  ...retryingEnd,
  extras: { icResolveStatus: 'failed' },
};
assert.equal(summarizeExpressway([terminalEnd], null).value, '終了ICが特定できませんでした');

const pendingPrompt = {
  tripId: 'trip-1',
  speedKmh: 24,
  detectedAt: '2026-08-23T06:10:00.000Z',
  geo: { lat: 35, lng: 139, accuracy: 12 },
};
assert.equal(selectPendingExpresswayEndPrompt({
  activeTripId: 'trip-1',
  expresswayActive: true,
  prompt: pendingPrompt,
}), pendingPrompt);
assert.equal(selectPendingExpresswayEndPrompt({
  activeTripId: 'trip-2',
  expresswayActive: true,
  prompt: pendingPrompt,
}), null);
assert.equal(selectPendingExpresswayEndPrompt({
  activeTripId: 'trip-1',
  expresswayActive: false,
  prompt: pendingPrompt,
}), null);
const keepDecision = buildPendingExpresswayKeepDecision(pendingPrompt, '2026-08-23T06:11:00.000Z');
assert.deepEqual(keepDecision, {
  tripId: 'trip-1',
  action: 'keep',
  decidedAt: '2026-08-23T06:11:00.000Z',
  speedKmh: 24,
  geo: pendingPrompt.geo,
});

console.log('homeStatusModel tests passed');
