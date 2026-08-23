import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import ExpresswayEndConfirmDialog from './HomeScreen/ExpresswayEndConfirmDialog';
import RunStatusCard from './HomeScreen/RunStatusCard';
import { subscribeHomeEventsChanged } from './HomeScreen/homeEventsRefresh';
import {
  selectPendingExpresswayEndPrompt,
  summarizeDiagnostics,
  summarizeExpressway,
  summarizeLocation,
  summarizeRouteTracking,
} from './HomeScreen/homeStatusModel';

import {
  getPendingExpresswayEndPrompt,
  getRouteTrackingMode,
  setRouteTrackingMode,
  DEFAULT_ROUTE_TRACKING_MODE,
  type PendingExpresswayEndPrompt,
} from '../../db/repositories';
import type { RouteTrackingMode } from '../../db/repositories';
import { openNativeSettings } from '../../services/routeTracking';
import {
  getNativeResidentLocationStatus,
  type NativeResidentLocationStatus,
} from '../../services/nativeResidentLocation';
import {
  commitAutomaticExpresswayEnd,
  commitAutomaticExpresswayKeep,
} from '../../services/nativeExpresswayPromptDecision';
import { runStartupDiagnostics, type StartupDiagnosticItem } from '../../services/startupDiagnostics';
import {
  openAppPermissionSettings,
  openSystemLocationSettings,
  runNativeQuickSetup as runNativeSetupWizard,
} from '../../services/nativeSetup';
import { copyLatestAndroidApkUrl } from '../../services/appDistribution';
import { requestRouteTrackingSync } from '../../app/routeTrackingSignal';
import {
  BREAK_TO_REST_MODAL_STATE_EVENT,
  isBreakToRestModalOpen,
} from '../../app/breakToRestConfirmationSignal';
import {
  checkVoiceRecognitionAvailable,
  findVoiceCommand,
  listenVoiceCommandJa,
} from '../../services/voiceControl';
import {
  EXPRESSWAY_TOGGLE_DEFINITION,
  PERSISTED_BASIC_TOGGLE_DEFINITIONS,
  findOpenToggleSessionId,
  findOpenToggleStart,
} from '../../domain/togglePairing';

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

const [
  REST_TOGGLE_DEFINITION,
  BREAK_TOGGLE_DEFINITION,
  LOAD_TOGGLE_DEFINITION,
  UNLOAD_TOGGLE_DEFINITION,
  FERRY_TOGGLE_DEFINITION,
] = PERSISTED_BASIC_TOGGLE_DEFINITIONS;

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
  const [routeTrackingMode, setRouteTrackingModeState] = useState<RouteTrackingMode>(DEFAULT_ROUTE_TRACKING_MODE);
  const [routeTrackingError, setRouteTrackingError] = useState<string | null>(null);
  const [nativeLocationStatus, setNativeLocationStatus] = useState<NativeResidentLocationStatus | null>(null);
  const [startupDiagnostics, setStartupDiagnostics] = useState<StartupDiagnosticItem[]>([]);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [quickSetupRunning, setQuickSetupRunning] = useState(false);
  const [quickSetupMessage, setQuickSetupMessage] = useState<string | null>(null);
  const [apkUrlCopied, setApkUrlCopied] = useState(false);
  const [apkUrlCopying, setApkUrlCopying] = useState(false);
  const [nativeSettingsOpen, setNativeSettingsOpen] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceLastText, setVoiceLastText] = useState<string | null>(null);
  const [voiceResult, setVoiceResult] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [focusDriving, setFocusDriving] = useState(false);
  const [breakToRestModalOpen, setBreakToRestModalOpen] = useState(isBreakToRestModalOpen);
  const [expresswayEndConfirmation, setExpresswayEndConfirmation] = useState<null | { source: 'manual' | 'voice' | 'automatic' }>(null);
  const [pendingExpresswayEndPrompt, setPendingExpresswayEndPromptState] = useState<PendingExpresswayEndPrompt | null>(null);
  const [expresswayEndBusy, setExpresswayEndBusy] = useState(false);
  const [expresswayEndError, setExpresswayEndError] = useState<string | null>(null);

  const apkUrlCopyTimer = useRef<number | null>(null);
  const isNative = Capacitor.isNativePlatform();
  const isAndroidNative = isNative && Capacitor.getPlatform() === 'android';

  useEffect(() => subscribeHomeEventsChanged(refresh), [refresh]);

  useEffect(() => {
    const syncModalState = () => setBreakToRestModalOpen(isBreakToRestModalOpen());
    window.addEventListener(BREAK_TO_REST_MODAL_STATE_EVENT, syncModalState);
    return () => window.removeEventListener(BREAK_TO_REST_MODAL_STATE_EVENT, syncModalState);
  }, []);

  useEffect(() => {
    if (!breakToRestModalOpen) return;
    // The due confirmation is modal and takes priority over optional Home
    // dialogs so a hidden dialog cannot reappear after the decision.
    setOdoDialog(null);
    setFuelOpen(false);
    setNativeSettingsOpen(false);
    setExpresswayEndConfirmation(null);
    setExpresswayEndError(null);
  }, [breakToRestModalOpen]);

  const openToggleStarts = useMemo(() => ({
    rest: findOpenToggleStart(events, REST_TOGGLE_DEFINITION),
    break: findOpenToggleStart(events, BREAK_TOGGLE_DEFINITION),
    load: findOpenToggleStart(events, LOAD_TOGGLE_DEFINITION),
    unload: findOpenToggleStart(events, UNLOAD_TOGGLE_DEFINITION),
    ferry: findOpenToggleStart(events, FERRY_TOGGLE_DEFINITION),
    expressway: findOpenToggleStart(events, EXPRESSWAY_TOGGLE_DEFINITION),
  }), [events]);
  const openRestSessionId = useMemo(
    () => findOpenToggleSessionId(events, REST_TOGGLE_DEFINITION),
    [events],
  );

  const loadActive = openToggleStarts.load !== null;
  const unloadActive = openToggleStarts.unload !== null;
  const breakActive = openToggleStarts.break !== null;
  const restActive = openToggleStarts.rest !== null;
  const expresswayActive = openToggleStarts.expressway !== null;
  const ferryActive = openToggleStarts.ferry !== null;
  const operationsDisabled = loading
    || operationInProgress
    || breakToRestModalOpen
    || expresswayEndConfirmation != null;
  const expresswayPending = activeOperation === 'expressway-start'
    ? 'start'
    : activeOperation === 'expressway-end'
      ? 'end'
      : null;

  useEffect(() => {
    if (!tripId || !expresswayActive) {
      setPendingExpresswayEndPromptState(null);
      setExpresswayEndConfirmation(current => current?.source === 'automatic' ? null : current);
      return;
    }
    let active = true;
    const syncPendingPrompt = async () => {
      try {
        const prompt = await getPendingExpresswayEndPrompt();
        if (!active) return;
        const currentPrompt = selectPendingExpresswayEndPrompt({
          activeTripId: tripId,
          expresswayActive,
          prompt,
        });
        setPendingExpresswayEndPromptState(currentPrompt);
        if (currentPrompt && !breakToRestModalOpen) {
          setExpresswayEndConfirmation(current => current ?? { source: 'automatic' });
        } else if (!currentPrompt) {
          setExpresswayEndConfirmation(current => current?.source === 'automatic' ? null : current);
        }
      } catch {
        // A persisted prompt is checked again on the next visibility/poll cycle.
      }
    };
    void syncPendingPrompt();
    const intervalId = window.setInterval(() => void syncPendingPrompt(), 3000);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void syncPendingPrompt();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      active = false;
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [breakToRestModalOpen, expresswayActive, tripId]);

  const activeStatuses = useMemo(() => {
    const list: { name: string; startTs: string; type: 'base' | 'expressway' | 'ferry' }[] = [];

    // フェリーは基本状態なので、ほかの基本カテゴリと同時には表示しない。
    if (ferryActive) {
      const ts = openToggleStarts.ferry?.ts;
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
      const ts = openToggleStarts.expressway?.ts;
      if (ts) {
        list.push({
          name: '高速道路走行',
          startTs: ts,
          type: 'expressway',
        });
      }
    }

    return list;
  }, [liveDrive, expresswayActive, ferryActive, openToggleStarts]);

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

  const requestExpresswayToggle = (action: 'start' | 'end', source: 'manual' | 'voice' = 'manual') => {
    if (operationInProgress || breakToRestModalOpen) return;
    if (action === 'end') {
      if (!expresswayActive) return;
      setExpresswayEndError(null);
      setExpresswayEndConfirmation({ source });
      if (source === 'voice') {
        setVoiceResult('高速道路を降りたか確認しています。');
      }
      return;
    }
    void runExpresswayToggle('start');
  };

  const continueExpressway = async () => {
    if (expresswayEndBusy) return;
    const source = expresswayEndConfirmation?.source;
    const pendingPrompt = source === 'automatic' ? pendingExpresswayEndPrompt : null;
    setExpresswayEndBusy(true);
    if (pendingPrompt) {
      try {
        await commitAutomaticExpresswayKeep({
          isAndroidNative,
          prompt: pendingPrompt,
          decidedAt: new Date().toISOString(),
        });
        requestRouteTrackingSync();
        setPendingExpresswayEndPromptState(null);
      } catch {
        setExpresswayEndError('高速道路の継続状態を保存できませんでした。もう一度お試しください。');
        setExpresswayEndBusy(false);
        return;
      }
    }
    setExpresswayEndConfirmation(null);
    setExpresswayEndError(null);
    if (source === 'voice') setVoiceResult('高速道路の記録を継続します。');
    setExpresswayEndBusy(false);
  };

  const confirmExpresswayEnd = async () => {
    if (!expresswayEndConfirmation || expresswayEndBusy || operationInProgress) return;
    const source = expresswayEndConfirmation.source;
    setExpresswayEndBusy(true);
    setExpresswayEndError(null);
    let completed = false;
    if (source === 'automatic' && pendingExpresswayEndPrompt?.tripId === tripId) {
      try {
        await commitAutomaticExpresswayEnd({
          isAndroidNative,
          prompt: pendingExpresswayEndPrompt,
        });
        setPendingExpresswayEndPromptState(null);
        requestRouteTrackingSync();
        await refresh();
        completed = true;
      } catch {
        completed = false;
      }
    } else {
      completed = (await runExpresswayToggle('end')) === true;
    }
    if (completed) {
      setExpresswayEndConfirmation(null);
      if (source === 'voice') setVoiceResult('実行しました: 高速道路終了');
    } else {
      const message = '高速道路の終了を記録できませんでした。通信と位置情報を確認して、もう一度お試しください。';
      setExpresswayEndError(message);
      if (source === 'voice') setVoiceError(message);
    }
    setExpresswayEndBusy(false);
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
    if (breakToRestModalOpen) {
      setVoiceError('休息への変更確認を完了してください。');
      return;
    }
    if (operationInProgress || expresswayEndConfirmation) {
      setVoiceError('別の操作を完了してから、もう一度お試しください。');
      return;
    }
    if (!isNative) {
      setVoiceError('音声コマンドはネイティブ版で利用できます。');
      return;
    }
    if (!voiceAvailable) {
      setVoiceError('この端末では音声入力を利用できません。');
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

      let operationAttempted = false;
      let operationSucceeded = false;
      let unavailableReason: string | null = null;
      let followUpMessage: string | null = null;
      switch (parsed.kind) {
        case 'trip_start':
          if (!tripId) {
            if (parsed.odoKm != null) {
              operationAttempted = true;
              operationSucceeded = (await handleStartTrip(parsed.odoKm)) != null;
            } else {
              setOdoDialog({ kind: 'trip_start' });
              followUpMessage = '開始ODOを入力してください。';
            }
          } else unavailableReason = 'すでに運行中です。';
          break;
        case 'trip_end':
          if (tripId) {
            if (parsed.odoKm != null) {
              operationAttempted = true;
              operationSucceeded = (await handleEndTrip(parsed.odoKm)) != null;
            } else {
              setOdoDialog({ kind: 'trip_end' });
              followUpMessage = '終了ODOを入力してください。';
            }
          } else unavailableReason = '開始中の運行がありません。';
          break;
        case 'rest_start':
          if (tripId && canStartRest) {
            if (parsed.odoKm != null) {
              operationAttempted = true;
              operationSucceeded = (await handleStartRest(parsed.odoKm)) != null;
            } else {
              setOdoDialog({ kind: 'rest_start' });
              followUpMessage = '休息開始ODOを入力してください。';
            }
          } else unavailableReason = tripId ? '別の作業中のため休息を開始できません。' : '開始中の運行がありません。';
          break;
        case 'rest_end':
          if (tripId && restActive && openRestSessionId) {
            operationAttempted = true;
            operationSucceeded = (await handleEndRest(openRestSessionId)) != null;
          } else unavailableReason = '終了できる休息がありません。';
          break;
        case 'break_start':
          if (tripId && canStartBreak) {
            operationAttempted = true;
            operationSucceeded = (await handleToggleEvent('break', 'start')) === true;
          } else unavailableReason = tripId ? '別の作業中のため休憩を開始できません。' : '開始中の運行がありません。';
          break;
        case 'break_end':
          if (tripId && breakActive) {
            operationAttempted = true;
            operationSucceeded = (await handleToggleEvent('break', 'end')) === true;
          } else unavailableReason = '終了できる休憩がありません。';
          break;
        case 'load_start':
          if (tripId && canStartLoad) {
            operationAttempted = true;
            operationSucceeded = (await handleToggleEvent('load', 'start')) === true;
          } else unavailableReason = tripId ? '別の作業中のため積込を開始できません。' : '開始中の運行がありません。';
          break;
        case 'load_end':
          if (tripId && loadActive) {
            operationAttempted = true;
            operationSucceeded = (await handleToggleEvent('load', 'end')) === true;
          } else unavailableReason = '終了できる積込がありません。';
          break;
        case 'unload_start':
          if (tripId && canStartUnload) {
            operationAttempted = true;
            operationSucceeded = (await handleToggleEvent('unload', 'start')) === true;
          } else unavailableReason = tripId ? '別の作業中のため荷卸を開始できません。' : '開始中の運行がありません。';
          break;
        case 'unload_end':
          if (tripId && unloadActive) {
            operationAttempted = true;
            operationSucceeded = (await handleToggleEvent('unload', 'end')) === true;
          } else unavailableReason = '終了できる荷卸がありません。';
          break;
        case 'expressway_start':
          if (tripId && !expresswayActive) {
            operationAttempted = true;
            operationSucceeded = (await runExpresswayToggle('start')) === true;
          } else unavailableReason = tripId ? 'すでに高速道路を記録中です。' : '開始中の運行がありません。';
          break;
        case 'expressway_end':
          if (tripId && expresswayActive) {
            requestExpresswayToggle('end', 'voice');
            followUpMessage = '高速道路を降りたか確認してください。';
          } else unavailableReason = '終了できる高速区間がありません。';
          break;
        case 'boarding':
          if (tripId && canStartFerry) {
            operationAttempted = true;
            operationSucceeded = (await handleAddFerry('boarding')) === true;
          } else unavailableReason = tripId ? '現在の作業を終了してから乗船を記録してください。' : '開始中の運行がありません。';
          break;
        case 'disembark':
          if (tripId && ferryActive) {
            operationAttempted = true;
            operationSucceeded = (await handleAddFerry('disembark')) === true;
          } else unavailableReason = '下船できるフェリー記録がありません。';
          break;
        case 'geo_refresh': {
          operationAttempted = true;
          const result = await captureGeoOnce();
          operationSucceeded = !!result.geo;
          if (!operationSucceeded) unavailableReason = '位置情報を取得できませんでした。端末設定を確認してください。';
          break;
        }
        case 'point_mark':
          if (tripId) {
            operationAttempted = true;
            operationSucceeded = (await handleAddPointMark(parsed.raw)) === true;
          } else unavailableReason = '開始中の運行がありません。';
          break;
      }
      if (followUpMessage) {
        setVoiceResult(followUpMessage);
        return;
      }
      if (unavailableReason) throw new Error(unavailableReason);
      if (!operationAttempted) throw new Error('この操作は現在実行できません。');
      if (!operationSucceeded) throw new Error('操作を完了できませんでした。画面の案内を確認してください。');
      setVoiceResult(`実行しました: ${parsed.raw}`);
    } catch (e: any) {
      setVoiceError(e?.message ?? '音声操作に失敗しました。');
    } finally {
      setVoiceListening(false);
    }
  };

  const copyLatestApkUrl = async () => {
    setApkUrlCopying(true);
    setApkUrlCopied(false);
    setRouteTrackingError(null);
    setQuickSetupMessage('最新APKの公開状況を確認しています…');
    try {
      const result = await copyLatestAndroidApkUrl();
      setApkUrlCopied(true);
      setQuickSetupMessage(`公開版 v${result.release.latestVersion} のダウンロードURLをコピーしました`);
      if (apkUrlCopyTimer.current != null) window.clearTimeout(apkUrlCopyTimer.current);
      apkUrlCopyTimer.current = window.setTimeout(() => setApkUrlCopied(false), 2000);
    } catch (error: any) {
      setQuickSetupMessage(null);
      setRouteTrackingError(error?.message ?? '最新版APKを確認できないためコピーを停止しました。通信状態を確認してください。');
    } finally {
      setApkUrlCopying(false);
    }
  };

  const refreshNativeStatus = useCallback(async () => {
    if (!isAndroidNative) {
      setNativeLocationStatus(null);
      return;
    }
    try {
      const status = await getNativeResidentLocationStatus();
      setNativeLocationStatus(status);
    } catch {
      setRouteTrackingError('バックグラウンド記録の状態を確認できませんでした。再診断してください。');
    }
  }, [isAndroidNative]);

  const refreshDiagnostics = useCallback(async () => {
    setDiagnosticsLoading(true);
    setRouteTrackingError(null);
    const [diagnosticResult, nativeStatusResult] = await Promise.allSettled([
      runStartupDiagnostics(),
      isAndroidNative ? getNativeResidentLocationStatus() : Promise.resolve(null),
    ]);
    if (diagnosticResult.status === 'fulfilled') {
      setStartupDiagnostics(diagnosticResult.value);
    } else {
      setStartupDiagnostics([]);
      setRouteTrackingError('端末状態を診断できませんでした。もう一度お試しください。');
    }
    if (nativeStatusResult.status === 'fulfilled') {
      setNativeLocationStatus(nativeStatusResult.value);
    } else if (isAndroidNative) {
      setRouteTrackingError('バックグラウンド記録の状態を確認できませんでした。再診断してください。');
    }
    setDiagnosticsLoading(false);
  }, [isAndroidNative]);

  const runQuickSetup = async () => {
    if (!isAndroidNative || quickSetupRunning) return;
    setQuickSetupRunning(true);
    setQuickSetupMessage(null);
    setRouteTrackingError(null);
    try {
      const result = await runNativeSetupWizard();
      setQuickSetupMessage(
        result.requiresManualFollowUp
          ? '端末設定を開きました。必要な許可を確認したあと、再診断してください。'
          : 'バックグラウンド記録の準備が整いました。',
      );
      requestRouteTrackingSync();
      await refreshDiagnostics();
    } catch {
      setQuickSetupMessage('かんたん設定を完了できませんでした。端末設定から許可を確認してください。');
      setRouteTrackingError('端末設定を確認してください。');
    } finally {
      setQuickSetupRunning(false);
    }
  };

  const changeRouteTrackingMode = async (mode: RouteTrackingMode) => {
    if (mode === routeTrackingMode) return;
    setRouteTrackingError(null);
    try {
      const saved = await setRouteTrackingMode(mode);
      setRouteTrackingModeState(saved);
      requestRouteTrackingSync();
      await refreshNativeStatus();
    } catch {
      setRouteTrackingError('位置記録モードを変更できませんでした。もう一度お試しください。');
    }
  };

  useEffect(() => {
    const init = async () => {
      try {
        const mode = await getRouteTrackingMode();
        setRouteTrackingModeState(mode);
      } catch {
        setRouteTrackingError('位置記録モードを読み込めませんでした。');
      }
      if (isNative) setVoiceAvailable(await checkVoiceRecognitionAvailable());
      await refreshDiagnostics();
    };
    void init();
    return () => {
      if (apkUrlCopyTimer.current != null) window.clearTimeout(apkUrlCopyTimer.current);
    };
  }, [isNative, refreshDiagnostics]);

  useEffect(() => {
    if (!isAndroidNative) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refreshDiagnostics();
    };
    const intervalId = window.setInterval(() => void refreshNativeStatus(), 15000);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [isAndroidNative, refreshDiagnostics, refreshNativeStatus]);

  const diagnosticSummary = summarizeDiagnostics(startupDiagnostics, diagnosticsLoading);
  const locationSummary = summarizeLocation(geoStatus, geoError);
  const routeSummary = summarizeRouteTracking({
    tripActive: !!tripId,
    isAndroidNative,
    nativeStatus: nativeLocationStatus,
    routeTrackingError,
  });
  const expresswaySummary = useMemo(
    () => summarizeExpressway(events, openToggleStarts.expressway),
    [events, openToggleStarts.expressway],
  );
  const statusCard = (
    <RunStatusCard
      route={routeSummary}
      expressway={expresswaySummary}
      location={locationSummary}
      diagnostics={diagnosticSummary}
      diagnosticItems={startupDiagnostics}
      compact={!!tripId && focusDriving}
      isAndroidNative={isAndroidNative}
      diagnosticsLoading={diagnosticsLoading}
      quickSetupRunning={quickSetupRunning}
      quickSetupMessage={quickSetupMessage}
      onRefreshDiagnostics={() => void refreshDiagnostics()}
      onQuickSetup={() => void runQuickSetup()}
    />
  );

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
            {statusCard}
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
  const homeModalOpen = breakToRestModalOpen || expresswayEndConfirmation != null;

  return (
    <div className="home-backdrop">
      <div
        className="home-shell"
        aria-hidden={homeModalOpen ? true : undefined}
        style={homeModalOpen ? { pointerEvents: 'none', userSelect: 'none' } : undefined}
      >
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
              <button
                type="button"
                className="pill-link"
                aria-label="端末と位置記録の設定を開く"
                title="端末と位置記録の設定"
                onClick={() => setNativeSettingsOpen(true)}
              >
                ⚙
              </button>
            )}
            <button type="button" className="pill-link" onClick={() => setFocusDriving(!focusDriving)}>
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

        {statusCard}

        {!focusDriving && (
          <div className="home-expressway-quick">
            <BigButton
              label={expresswayButtonLabel}
              hint={expresswayPending ? '位置情報とIC名を記録しています' : undefined}
              variant="neutral"
              className={expresswayButtonClass}
              disabled={operationsDisabled}
              onClick={() => requestExpresswayToggle(expresswayAction)}
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
              voiceAvailable={voiceAvailable}
              voiceListening={voiceListening}
              voiceLastText={voiceLastText}
              voiceResult={voiceResult}
              voiceError={voiceError}
              expresswayActive={expresswayActive}
              expresswayPending={expresswayPending}
              onExpresswayToggle={action => requestExpresswayToggle(action)}
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
            <div
              className="card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="native-settings-title"
              style={{ width: 'min(520px, 90%)', padding: 20 }}
              onClick={e => e.stopPropagation()}
            >
              <div className="home-section-label">ネイティブ設定</div>
              <h2 id="native-settings-title" style={{ margin: '6px 0 14px' }}>位置記録の設定</h2>
              <div style={{ display: 'grid', gap: 12 }}>
                <div className="home-native-mode" role="group" aria-label="位置記録モード">
                  <button
                    type="button"
                    aria-pressed={routeTrackingMode === 'precision'}
                    onClick={() => void changeRouteTrackingMode('precision')}
                  >
                    高精度
                  </button>
                  <button
                    type="button"
                    aria-pressed={routeTrackingMode === 'battery'}
                    onClick={() => void changeRouteTrackingMode('battery')}
                  >
                    省電力
                  </button>
                </div>
                <button type="button" className="trip-btn" onClick={() => void runQuickSetup()} disabled={quickSetupRunning}>
                  {quickSetupRunning ? '設定を確認中…' : 'かんたん設定を実行'}
                </button>
                <button type="button" className="trip-btn" onClick={() => void openNativeSettings()}>位置記録のOS設定</button>
                <button type="button" className="trip-btn" onClick={() => void openAppPermissionSettings()}>アプリ権限設定</button>
                <button type="button" className="trip-btn" onClick={() => void openSystemLocationSettings()}>端末の位置情報設定</button>
                <button type="button" className="trip-btn" onClick={copyLatestApkUrl} disabled={apkUrlCopying}>
                  {apkUrlCopying ? '最新版を確認中…' : apkUrlCopied ? 'コピーしました' : '最新版APK URLをコピー'}
                </button>
                {routeTrackingError && <div className="home-inline-alert" role="alert">{routeTrackingError}</div>}
                {quickSetupMessage && <div className="home-inline-success" role="status">{quickSetupMessage}</div>}
                <button type="button" className="trip-btn" onClick={() => setNativeSettingsOpen(false)}>閉じる</button>
              </div>
            </div>
          </div>
        )}
      </div>

      <ExpresswayEndConfirmDialog
        open={expresswayEndConfirmation != null}
        busy={expresswayEndBusy || operationInProgress}
        detectedAutomatically={expresswayEndConfirmation?.source === 'automatic'}
        errorMessage={expresswayEndError}
        onContinue={() => void continueExpressway()}
        onEnd={() => void confirmExpresswayEnd()}
      />

      <OdoDialog
        open={odoDialog?.kind === 'rest_start' && !operationInProgress}
        title="休息開始"
        description="休息開始ODO（km）を入力してください"
        confirmText="休息開始"
        allowZero
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
