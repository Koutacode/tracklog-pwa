import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import BigButton from '../components/BigButton';
import OdoDialog from '../components/OdoDialog';
import FuelDialog from '../components/FuelDialog';
import { useTripManager } from '../../hooks/useTripManager';
import { useComplianceMetrics } from '../../hooks/useComplianceMetrics';
import ProgressGauge from '../components/ProgressGauge';
import DrivingView from './HomeScreen/DrivingView';
import StoppedView from './HomeScreen/StoppedView';

import {
  getRouteTrackingMode,
  setRouteTrackingMode,
  DEFAULT_ROUTE_TRACKING_MODE,
} from '../../db/repositories';
import type { RouteTrackingMode } from '../../db/repositories';
import { openNativeSettings } from '../../services/routeTracking';
import { cancelNativeExpresswayEndPrompt } from '../../services/nativeExpresswayPrompt';
import { runStartupDiagnostics, type StartupDiagnosticItem } from '../../services/startupDiagnostics';
import {
  openAppPermissionSettings,
  openSystemLocationSettings,
  runNativeQuickSetup as runNativeSetupWizard,
} from '../../services/nativeSetup';
import { DEFAULT_APK_DOWNLOAD_URL, RELEASE_PAGE_URL } from '../../app/releaseInfo';
import { requestRouteTrackingSync } from '../../app/routeTrackingSignal';
import {
  checkVoiceRecognitionAvailable,
  findVoiceCommand,
  listenVoiceCommandJa,
} from '../../services/voiceControl';

function fmtDuration(ms: number) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function fmtDateTime(ts?: string) {
  if (!ts) return '-';
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts));
}

function fmtMinutesShort(minutes: number) {
  const safe = Math.max(0, Math.round(minutes));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  if (h === 0) return `${m}分`;
  if (m === 0) return `${h}時間`;
  return `${h}時間${m}分`;
}

const LATEST_APK_URL = DEFAULT_APK_DOWNLOAD_URL;

function getOpenToggle(events: any[], startType: string, endType: string, key: string): string | null {
  const starts = events.filter(e => e.type === startType).sort((a, b) => a.ts.localeCompare(b.ts));
  const ends = events.filter(e => e.type === endType);
  for (let i = starts.length - 1; i >= 0; i--) {
    const sid = (starts[i] as any).extras?.[key] as string | undefined;
    if (!sid) continue;
    const hasEnd = ends.some(en => (en as any).extras?.[key] === sid);
    if (!hasEnd) return sid;
  }
  const lastStart = starts[starts.length - 1];
  if (lastStart) {
    const hasEndAfter = ends.some(en => en.ts > lastStart.ts);
    if (!hasEndAfter) return '__legacy__';
  }
  return null;
}

function getOpenToggleStartTs(events: any[], startType: string, endType: string, key: string): string | null {
  const starts = events.filter(e => e.type === startType).sort((a, b) => a.ts.localeCompare(b.ts));
  const ends = events.filter(e => e.type === endType);
  for (let i = starts.length - 1; i >= 0; i--) {
    const sid = (starts[i] as any).extras?.[key] as string | undefined;
    if (!sid) continue;
    const hasEnd = ends.some(en => (en as any).extras?.[key] === sid);
    if (!hasEnd) return starts[i].ts;
  }
  const lastStart = starts[starts.length - 1];
  if (lastStart) {
    const hasEndAfter = ends.some(en => en.ts > lastStart.ts);
    if (!hasEndAfter) return lastStart.ts;
  }
  return null;
}

function OperationErrorNotice(props: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '10px 12px',
        border: '1px solid rgba(248,113,113,0.55)',
        background: 'rgba(127,29,29,0.3)',
        color: '#fecaca',
        fontSize: 13,
      }}
    >
      <span>{props.message}</span>
      <button
        type="button"
        aria-label="エラーを閉じる"
        title="閉じる"
        onClick={props.onDismiss}
        style={{ border: 0, background: 'transparent', color: 'inherit', fontSize: 22, lineHeight: 1 }}
      >
        ×
      </button>
    </div>
  );
}

export default function HomeScreen() {
  const {
    tripId,
    events,
    loading,
    geoStatus,
    geoError,
    activeOperation,
    operationInProgress,
    operationError,
    clearOperationError,
    refresh,
    captureGeoOnce,
    handleStartTrip,
    handleEndTrip,
    handleStartRest,
    handleEndRest,
    handleToggleEvent,
    handleAddRefuel,
    handleAddFerry,
    handleAddPointMark,
  } = useTripManager();

  const {
    now,
    liveVm,
    activeDayMetrics,
    liveDrive,
  } = useComplianceMetrics(tripId, events);

  const [odoDialog, setOdoDialog] = useState<null | { kind: 'trip_start' | 'rest_start' | 'trip_end' }>(null);
  const [fuelOpen, setFuelOpen] = useState(false);
  const [wakeLockOn, setWakeLockOn] = useState(false);
  const [routeTrackingMode, setRouteTrackingModeState] = useState<RouteTrackingMode>(DEFAULT_ROUTE_TRACKING_MODE);
  const [routeTrackingError, setRouteTrackingError] = useState<string | null>(null);
  const [startupDiagnostics, setStartupDiagnostics] = useState<StartupDiagnosticItem[]>([]);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [quickSetupRunning, setQuickSetupRunning] = useState(false);
  const [quickSetupMessage, setQuickSetupMessage] = useState<string | null>(null);
  const [apkUrlCopied, setApkUrlCopied] = useState(false);
  const [nativeSettingsOpen, setNativeSettingsOpen] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceLastText, setVoiceLastText] = useState<string | null>(null);
  const [voiceResult, setVoiceResult] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [focusDriving, setFocusDriving] = useState(false);

  const apkUrlCopyTimer = useRef<number | null>(null);
  const isNative = Capacitor.isNativePlatform();

  const openRestSessionId = useMemo(() => {
    const restStarts = events.filter(e => e.type === 'rest_start').sort((a, b) => a.ts.localeCompare(b.ts));
    const restEnds = events.filter(e => e.type === 'rest_end');
    for (let i = restStarts.length - 1; i >= 0; i--) {
      const rs: any = restStarts[i];
      const id = rs.extras?.restSessionId as string | undefined;
      if (!id) continue;
      const hasEnd = restEnds.some(re => (re as any).extras?.restSessionId === id);
      if (!hasEnd) return id;
    }
    return null;
  }, [events]);

  const loadActive = !!getOpenToggle(events, 'load_start', 'load_end', 'loadSessionId');
  const unloadActive = !!getOpenToggle(events, 'unload_start', 'unload_end', 'unloadSessionId');
  const breakActive = !!getOpenToggle(events, 'break_start', 'break_end', 'breakSessionId');
  const restActive = !!openRestSessionId;
  const expresswayActive = !!getOpenToggle(events, 'expressway_start', 'expressway_end', 'expresswaySessionId');
  const ferryActive = !!getOpenToggle(events, 'boarding', 'disembark', 'ferrySessionId');
  const operationsDisabled = loading || operationInProgress;
  const expresswayPending = activeOperation === 'expressway-start'
    ? 'start'
    : activeOperation === 'expressway-end'
      ? 'end'
      : null;

  const activeStatuses = useMemo(() => {
    const list: { name: string; startTs: string; type: 'base' | 'expressway' | 'ferry' }[] = [];

    // フェリーは基本状態なので、ほかの基本カテゴリと同時には表示しない。
    if (ferryActive) {
      const ts = getOpenToggleStartTs(events, 'boarding', 'disembark', 'ferrySessionId');
      if (ts) {
        list.push({ name: 'フェリー乗船', startTs: ts, type: 'base' });
      }
    } else if (liveDrive.currentCategory !== 'idle' && liveDrive.currentCategoryStartedAt) {
      list.push({
        name: liveDrive.currentCategoryLabel,
        startTs: liveDrive.currentCategoryStartedAt,
        type: 'base',
      });
    }

    // 2. 高速道路
    if (expresswayActive) {
      const ts = getOpenToggleStartTs(events, 'expressway_start', 'expressway_end', 'expresswaySessionId');
      if (ts) {
        list.push({
          name: '高速道路走行',
          startTs: ts,
          type: 'expressway',
        });
      }
    }

    return list;
  }, [liveDrive, expresswayActive, ferryActive, events]);

  const canStartBasicOperation = !ferryActive && !loadActive && !breakActive && !restActive && !unloadActive;
  const canStartRest = canStartBasicOperation;
  const canStartLoad = canStartBasicOperation;
  const canStartUnload = canStartBasicOperation;
  const canStartBreak = canStartBasicOperation;
  const canStartFerry = !ferryActive && !loadActive && !breakActive && !unloadActive;

  const runExpresswayToggle = async (action: 'start' | 'end') => {
    if (operationInProgress) return;
    return handleToggleEvent('expressway', action);
  };

  // Auto-switch focus when driving starts
  useEffect(() => {
    if (liveDrive.currentCategory === 'drive') {
      setFocusDriving(true);
    } else {
      setFocusDriving(false);
    }
  }, [liveDrive.currentCategory]);

  const runVoiceCommand = async () => {
    if (!isNative) {
      setVoiceError('音声コマンドはネイティブ版で利用できます。');
      return;
    }
    setVoiceListening(true);
    setVoiceError(null);
    setVoiceResult(null);
    try {
      const matches = await listenVoiceCommandJa();
      if (matches.length === 0) throw new Error('音声を認識できませんでした。');
      setVoiceLastText(matches[0]);
      const parsed = findVoiceCommand(matches);
      if (!parsed) throw new Error(`コマンドを判別できませんでした: ${matches[0]}`);

      let operationSucceeded = true;
      // Execute command using handlers from useTripManager
      switch (parsed.kind) {
        case 'trip_start':
          if (!tripId) {
            if (parsed.odoKm) operationSucceeded = (await handleStartTrip(parsed.odoKm)) != null;
            else setOdoDialog({ kind: 'trip_start' });
          }
          break;
        case 'trip_end':
          if (tripId) {
            if (parsed.odoKm) operationSucceeded = (await handleEndTrip(parsed.odoKm)) != null;
            else setOdoDialog({ kind: 'trip_end' });
          }
          break;
        case 'rest_start':
          if (tripId && canStartRest) {
            if (parsed.odoKm) operationSucceeded = (await handleStartRest(parsed.odoKm)) != null;
            else setOdoDialog({ kind: 'rest_start' });
          }
          break;
        case 'rest_end':
          if (tripId && restActive && openRestSessionId) {
            operationSucceeded = (await handleEndRest(openRestSessionId)) != null;
          }
          break;
        case 'break_start':
          if (tripId && canStartBreak) operationSucceeded = (await handleToggleEvent('break', 'start')) === true;
          break;
        case 'break_end':
          if (tripId && breakActive) operationSucceeded = (await handleToggleEvent('break', 'end')) === true;
          break;
        case 'load_start':
          if (tripId && canStartLoad) operationSucceeded = (await handleToggleEvent('load', 'start')) === true;
          break;
        case 'load_end':
          if (tripId && loadActive) operationSucceeded = (await handleToggleEvent('load', 'end')) === true;
          break;
        case 'unload_start':
          if (tripId && canStartUnload) operationSucceeded = (await handleToggleEvent('unload', 'start')) === true;
          break;
        case 'unload_end':
          if (tripId && unloadActive) operationSucceeded = (await handleToggleEvent('unload', 'end')) === true;
          break;
        case 'expressway_start':
          if (tripId && !expresswayActive) operationSucceeded = (await runExpresswayToggle('start')) === true;
          break;
        case 'expressway_end':
          if (tripId && expresswayActive) operationSucceeded = (await runExpresswayToggle('end')) === true;
          break;
        case 'boarding':
          if (tripId && canStartFerry) operationSucceeded = (await handleAddFerry('boarding')) === true;
          break;
        case 'disembark':
          if (tripId && ferryActive) operationSucceeded = (await handleAddFerry('disembark')) === true;
          break;
        case 'geo_refresh':
          await captureGeoOnce();
          break;
        case 'point_mark':
          if (tripId) operationSucceeded = (await handleAddPointMark(parsed.raw)) === true;
          break;
      }
      if (operationSucceeded) setVoiceResult(`実行しました: ${parsed.raw}`);
    } catch (e: any) {
      setVoiceError(e?.message ?? '音声操作に失敗しました。');
    } finally {
      setVoiceListening(false);
    }
  };

  const copyLatestApkUrl = async () => {
    try {
      await navigator.clipboard.writeText(LATEST_APK_URL);
      setApkUrlCopied(true);
      setTimeout(() => setApkUrlCopied(false), 2000);
    } catch {
      alert('コピーに失敗しました');
    }
  };

  useEffect(() => {
    const init = async () => {
      const mode = await getRouteTrackingMode();
      setRouteTrackingModeState(mode);
      if (isNative) {
        setVoiceAvailable(await checkVoiceRecognitionAvailable());
      }
      runStartupDiagnostics().then(setStartupDiagnostics);
    };
    init();
  }, [isNative]);

  if (!tripId) {
    return (
      <div className="start-hero">
        <div className="start-hero__frame">
          <div className="start-hero__nav">
            <div className="start-hero__brand">
              <div className="start-hero__brand-mark">TL</div>
              <div>
                <div className="start-hero__brand-name">TrackLog運行アシスト</div>
                <div className="start-hero__brand-sub">運行記録</div>
              </div>
            </div>
            <div className="start-hero__nav-actions">
              <Link to="/messages" className="pill-link">メッセージ</Link>
              <Link to="/settings" className="pill-link">同期/端末</Link>
              <Link to="/history" className="pill-link">運行履歴</Link>
              <Link to="/report" className="pill-link">運行日報</Link>
            </div>
          </div>
          <div className="start-hero__content">
            <div className="start-hero__panel start-hero__panel--hero">
              <div className="start-hero__eyebrow">出発前チェック</div>
              <div className="start-hero__title">今日の運行を開始</div>
              <div className="start-hero__subtitle">開始ODOを入力して、記録を開始します。</div>
              {operationError && (
                <OperationErrorNotice message={operationError} onDismiss={clearOperationError} />
              )}
              <div className="start-hero__actions">
                <BigButton
                  label={operationInProgress ? '処理中…' : loading ? '読み込み中…' : '運行開始'}
                  hint="開始ODOを入力して記録開始"
                  disabled={operationsDisabled}
                  onClick={() => setOdoDialog({ kind: 'trip_start' })}
                />
              </div>
            </div>
          </div>
          <OdoDialog
            open={odoDialog?.kind === 'trip_start' && !operationInProgress}
            title="運行開始"
            description="開始時のオドメーター（km）を入力してください"
            confirmText="運行開始"
            onCancel={() => setOdoDialog(null)}
            onConfirm={odoKm => {
              setOdoDialog(null);
              handleStartTrip(odoKm);
            }}
          />
        </div>
      </div>
    );
  }

  const tripStart = events.find(e => e.type === 'trip_start') as any;
  const tripElapsed = tripStart?.ts ? now - new Date(tripStart.ts).getTime() : null;
  const effectiveExpresswayActive = expresswayPending ? expresswayPending === 'start' : expresswayActive;
  const expresswayAction = effectiveExpresswayActive ? 'end' : 'start';
  const expresswayButtonClass = `big-button--expressway-hero ${
    effectiveExpresswayActive ? 'big-button--expressway-end' : 'big-button--expressway-start'
  }${expresswayPending ? ' big-button--pending' : ''}`;
  const expresswayButtonLabel = expresswayPending
    ? expresswayPending === 'start'
      ? '高速道路開始中…'
      : '高速道路終了中…'
    : effectiveExpresswayActive
      ? '高速道路終了'
      : '高速道路開始';

  return (
    <div className="home-backdrop">
      <div className="home-shell">
        <div className="home-topbar">
          <div className="home-topbar__main">
            <div className="home-topbar__eyebrow">TrackLog運行アシスト</div>
            <div className="home-topbar__title">{focusDriving ? '運転中' : '運行中'}</div>
            <div className="home-topbar__meta">
              開始 {fmtDateTime(tripStart?.ts)} / 経過 {tripElapsed != null ? fmtDuration(tripElapsed) : '-'}
            </div>
          </div>
          <div className="home-topbar__actions">
            {isNative && (
              <button className="pill-link" onClick={() => setNativeSettingsOpen(true)}>⚙</button>
            )}
            <button className="pill-link" onClick={() => setFocusDriving(!focusDriving)}>
              {focusDriving ? '通常表示' : '運転集中'}
            </button>
            <Link to="/admin" className="pill-link">管理</Link>
            <Link to="/messages" className="pill-link">メッセージ</Link>
            <Link to="/settings" className="pill-link">設定</Link>
            <Link to={`/trip/${tripId}`} className="pill-link">詳細</Link>
          </div>
        </div>

        {operationError && (
          <OperationErrorNotice message={operationError} onDismiss={clearOperationError} />
        )}

        {!focusDriving && (
          <div className="home-expressway-quick">
            <BigButton
              label={expresswayButtonLabel}
              hint={expresswayPending ? '位置情報とIC名を記録しています' : undefined}
              variant="neutral"
              className={expresswayButtonClass}
              disabled={operationsDisabled}
              onClick={() => runExpresswayToggle(expresswayAction)}
            />
          </div>
        )}

        {focusDriving ? (
          <fieldset
            disabled={operationsDisabled}
            aria-busy={operationInProgress}
            style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
          >
            <DrivingView
              liveDrive={liveDrive}
              onVoiceCommand={runVoiceCommand}
              voiceListening={voiceListening}
              expresswayActive={expresswayActive}
              expresswayPending={expresswayPending}
              onExpresswayToggle={runExpresswayToggle}
            />
          </fieldset>
        ) : (
          <div className="home-grid">
            <div className="home-primary">
              <div className="card" style={{ padding: 16 }}>
                <div className="home-section-label">現在の作業状態</div>
                <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                  {activeStatuses.map((status, idx) => {
                    const elapsedMs = now - new Date(status.startTs).getTime();
                    return (
                      <div
                        key={idx}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          background: 'rgba(255,255,255,0.05)',
                          padding: '10px 14px',
                          borderRadius: 8,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span
                            style={{
                              display: 'inline-block',
                              width: 8,
                              height: 8,
                              borderRadius: '50%',
                              background:
                                status.type === 'base'
                                  ? '#3b82f6'
                                  : status.type === 'expressway'
                                  ? '#f59e0b'
                                  : '#10b981',
                            }}
                          />
                          <span style={{ fontSize: 15, fontWeight: 'bold' }}>
                            {status.type === 'base' ? `${status.name}中` : status.name}
                          </span>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: 16, fontWeight: 900, fontFamily: 'monospace' }}>
                            {fmtDuration(elapsedMs)}
                          </div>
                          <div style={{ fontSize: 10, opacity: 0.5 }}>
                            開始 {fmtDateTime(status.startTs).split(' ')[1] /* 時刻部分のみ */}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {activeStatuses.length === 0 && (
                    <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', textAlign: 'center', padding: '8px 0' }}>
                      稼働中の作業はありません
                    </div>
                  )}
                </div>
              </div>

              <div className="card" style={{ padding: 16 }}>
                <div className="home-section-label">法令チェック</div>
                <div style={{ display: 'flex', justifyContent: 'space-around', padding: '10px 0' }}>
                  <ProgressGauge
                    value={liveDrive.driveSinceResetMinutes}
                    max={240}
                    label="連続運転"
                    color={liveDrive.continuousDriveExceeded ? '#ef4444' : '#3b82f6'}
                    size={100}
                  />
                  <ProgressGauge
                    value={activeDayMetrics?.constraintMinutes ?? 0}
                    max={activeDayMetrics?.effectiveConstraintLimitMinutes ?? 780}
                    label="拘束時間"
                    unit="分"
                    color="#10b981"
                    size={100}
                  />
                </div>
              </div>

              <div className="card" style={{ padding: 16 }}>
                <div className="home-section-label">運行セグメント（休息・休憩間）</div>
                <div className="home-status-list">
                  {liveVm?.segments.slice(-3).reverse().map((seg, idx) => (
                    <div key={idx} className="home-status-row">
                      <span style={{ fontSize: 12 }}>{seg.fromLabel} → {seg.toLabel}</span>
                      <strong>{seg.km} km</strong>
                    </div>
                  ))}
                  {liveVm?.segments.length === 0 && (
                    <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', textAlign: 'center' }}>
                      記録されたセグメントはありません
                    </div>
                  )}
                </div>
              </div>

              <div className="card home-info-card">
                <div className="home-section-label">現在地</div>
                {geoStatus ? (
                  <div className="home-info-card__address">{geoStatus.address || '住所取得中...'}</div>
                ) : (
                  <div className="home-info-card__meta">位置情報を取得しています...</div>
                )}
                <button className="trip-btn" disabled={operationsDisabled} onClick={captureGeoOnce}>更新</button>
              </div>
            </div>

            <div className="home-action-stack">
              <StoppedView
                disabled={operationsDisabled}
                loadActive={loadActive}
                unloadActive={unloadActive}
                breakActive={breakActive}
                restActive={restActive}
                ferryActive={ferryActive}
                canStartLoad={canStartLoad}
                canStartUnload={canStartUnload}
                canStartBreak={canStartBreak}
                canStartRest={canStartRest}
                canStartFerry={canStartFerry}
                onOdoDialog={kind => setOdoDialog({ kind })}
                onToggle={handleToggleEvent}
                onRestEnd={() => openRestSessionId && handleEndRest(openRestSessionId)}
                onFerry={handleAddFerry}
                onRefuel={() => setFuelOpen(true)}
                onPointMark={() => handleAddPointMark('手動')}
              />
            </div>
          </div>
        )}

        {nativeSettingsOpen && (
          <div className="auto-expressway-overlay" onClick={() => setNativeSettingsOpen(false)}>
            <div className="card" style={{ width: '90%', padding: 20 }} onClick={e => e.stopPropagation()}>
              <div className="home-section-label">ネイティブ設定</div>
              <div style={{ display: 'grid', gap: 12 }}>
                <button className="trip-btn" onClick={() => openNativeSettings()}>OS設定を開く</button>
                <button className="trip-btn" onClick={() => openAppPermissionSettings()}>アプリ権限設定</button>
                <button className="trip-btn" onClick={copyLatestApkUrl}>
                  {apkUrlCopied ? 'コピーしました' : 'APKダウンロードURLをコピー'}
                </button>
                <button className="trip-btn" onClick={() => setNativeSettingsOpen(false)}>閉じる</button>
              </div>
            </div>
          </div>
        )}
      </div>

      <OdoDialog
        open={odoDialog?.kind === 'rest_start' && !operationInProgress}
        title="休息開始"
        description="休息開始ODO（km）を入力してください"
        confirmText="休息開始"
        onCancel={() => setOdoDialog(null)}
        onConfirm={odoKm => {
          setOdoDialog(null);
          handleStartRest(odoKm);
        }}
      />
      <OdoDialog
        open={odoDialog?.kind === 'trip_end' && !operationInProgress}
        title="運行終了"
        description="終了ODO（km）を入力してください"
        confirmText="運行終了"
        onCancel={() => setOdoDialog(null)}
        onConfirm={async odoEndKm => {
          setOdoDialog(null);
          const event = await handleEndTrip(odoEndKm);
          if (event) {
            alert(`運行終了\n総距離: ${event.extras.totalKm} km`);
          }
        }}
      />
      <FuelDialog
        open={fuelOpen && !operationInProgress}
        onCancel={() => setFuelOpen(false)}
        onConfirm={liters => {
          setFuelOpen(false);
          handleAddRefuel(liters);
        }}
      />
    </div>
  );
}
