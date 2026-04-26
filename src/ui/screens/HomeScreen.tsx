import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import BigButton from '../components/BigButton';
import OdoDialog from '../components/OdoDialog';
import FuelDialog from '../components/FuelDialog';
import { getGeoWithAddress } from '../../services/geo';
import { isWakeLockSupported, requestWakeLock, releaseWakeLock } from '../../services/wakeLock';
import {
  getActiveTripId,
  getEventsByTripId,
  startTrip,
  endTrip,
  startRest,
  endRest,
  startLoad,
  endLoad,
  startUnload,
  endUnload,
  startBreak,
  endBreak,
  addRefuel,
  addBoarding,
  addDisembark,
  addPointMark,
  startExpressway,
  endExpressway,
  updateExpresswayResolved,
  backfillMissingAddresses,
  clearPendingExpresswayEndDecision,
  clearPendingExpresswayEndPrompt,
  getRouteTrackingMode,
  setRouteTrackingMode,
  DEFAULT_ROUTE_TRACKING_MODE,
} from '../../db/repositories';
import type { RouteTrackingMode } from '../../db/repositories';
import type { AppEvent } from '../../domain/types';
import { resolveNearestIC } from '../../services/icResolver';
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
import { buildTripViewModel } from '../../state/selectors';
import { buildReportTripFromAppEvents, computeTripDayMetrics } from '../../domain/reportLogic';
import { computeLiveDriveStatus } from '../../domain/liveDriveStatus';
import {
  checkVoiceRecognitionAvailable,
  findVoiceCommand,
  listenVoiceCommandJa,
  type VoiceCommand,
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

// Helpers to find open sessions
function getOpenRestSessionId(events: AppEvent[]): string | null {
  const restStarts = events.filter(e => e.type === 'rest_start').sort((a, b) => a.ts.localeCompare(b.ts));
  if (restStarts.length === 0) return null;
  const restEnds = events.filter(e => e.type === 'rest_end');
  for (let i = restStarts.length - 1; i >= 0; i--) {
    const rs: any = restStarts[i];
    const id = rs.extras?.restSessionId as string | undefined;
    if (!id) continue;
    const hasEnd = restEnds.some(re => (re as any).extras?.restSessionId === id);
    if (!hasEnd) return id;
  }
  return null;
}

function getOpenToggle(events: AppEvent[], startType: string, endType: string, key: string): string | null {
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


export default function HomeScreen() {
  const [tripId, setTripId] = useState<string | null>(null);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [odoDialog, setOdoDialog] = useState<null | { kind: 'trip_start' | 'rest_start' | 'trip_end' }>(null);
  const [fuelOpen, setFuelOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [geoStatus, setGeoStatus] = useState<{ lat: number; lng: number; accuracy?: number; at: string; address?: string } | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [wakeLockOn, setWakeLockOn] = useState(false);
  const [wakeLockAvailable, setWakeLockAvailable] = useState(false);
  const [wakeLockError, setWakeLockError] = useState<string | null>(null);
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
  const breakReminderTimer = useRef<number | null>(null);
  const apkUrlCopyTimer = useRef<number | null>(null);

  const openRestSessionId = useMemo(() => getOpenRestSessionId(events), [events]);
  const openLoadSessionId = useMemo(() => getOpenToggle(events, 'load_start', 'load_end', 'loadSessionId'), [events]);
  const openUnloadSessionId = useMemo(
    () => getOpenToggle(events, 'unload_start', 'unload_end', 'unloadSessionId'),
    [events],
  );
  const openBreakSessionId = useMemo(() => getOpenToggle(events, 'break_start', 'break_end', 'breakSessionId'), [events]);
  const openExpresswaySessionId = useMemo(
    () => getOpenToggle(events, 'expressway_start', 'expressway_end', 'expresswaySessionId'),
    [events],
  );
  const openFerrySessionId = useMemo(
    () => getOpenToggle(events, 'boarding', 'disembark', 'ferrySessionId'),
    [events],
  );
  const isNative = Capacitor.isNativePlatform();

  const restActive = !!openRestSessionId;
  const loadActive = !!openLoadSessionId;
  const unloadActive = !!openUnloadSessionId;
  const breakActive = !!openBreakSessionId;
  const expresswayActive = !!openExpresswaySessionId;
  const ferryActive = !!openFerrySessionId;
  const canStartRest = !ferryActive && !loadActive && !breakActive && !restActive && !unloadActive;
  const canStartLoad = !ferryActive && !restActive && !breakActive && !loadActive && !unloadActive;
  const canStartUnload = !ferryActive && !restActive && !breakActive && !unloadActive && !loadActive;
  const canStartBreak = !ferryActive && !restActive && !loadActive && !breakActive && !unloadActive;
  const expresswayStart = openExpresswaySessionId
    ? (events.find(e => e.type === 'expressway_start' && (e as any).extras?.expresswaySessionId === openExpresswaySessionId) as any)
    : null;
  const ferryStart = openFerrySessionId
    ? (events.find(e => e.type === 'boarding' && (e as any).extras?.ferrySessionId === openFerrySessionId) as any)
    : null;

  // Fill missing addresses later whenオンラインになった際に補完する
  async function backfillAddresses(active: string | null, limit = 40, batches = 3) {
    // Attempt multiple batches (bigger limit) whenオンライン復帰や起動時にできるだけ埋める
    const updated = await backfillMissingAddresses(limit, batches);
    if (updated && active) {
      const ev = await getEventsByTripId(active);
      setEvents(ev);
    }
  }

  async function refresh() {
    setLoading(true);
    try {
      const active = await getActiveTripId();
      setTripId(active);
      if (active) {
        const ev = await getEventsByTripId(active);
        setEvents(ev);
        void backfillAddresses(active);
        // Re-schedule break reminder based on open break session
        const openBreakId = getOpenToggle(ev, 'break_start', 'break_end', 'breakSessionId');
        if (openBreakId) {
          const startEv = ev.find(e => e.type === 'break_start' && (e as any).extras?.breakSessionId === openBreakId);
          if (startEv) {
            scheduleBreakReminder(new Date(startEv.ts).getTime());
          }
        } else {
          cancelBreakReminder();
        }
      } else {
        setEvents([]);
        void backfillAddresses(null);
        cancelBreakReminder();
      }
    } finally {
      setLoading(false);
    }
  }

  async function updateRouteTrackingMode(next: RouteTrackingMode) {
    setRouteTrackingError(null);
    setRouteTrackingModeState(next);
    await setRouteTrackingMode(next);
  }

  async function copyText(text: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // fallback below
    }
    try {
      const el = document.createElement('textarea');
      el.value = text;
      el.setAttribute('readonly', 'true');
      el.style.position = 'absolute';
      el.style.left = '-9999px';
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }

  async function copyLatestApkUrl() {
    const ok = await copyText(LATEST_APK_URL);
    if (!ok) {
      alert('URLをコピーできませんでした。手動でコピーしてください。');
      return;
    }
    setApkUrlCopied(true);
    if (apkUrlCopyTimer.current != null) {
      window.clearTimeout(apkUrlCopyTimer.current);
    }
    apkUrlCopyTimer.current = window.setTimeout(() => {
      setApkUrlCopied(false);
      apkUrlCopyTimer.current = null;
    }, 2000);
  }

  function openLatestApkUrl() {
    window.open(LATEST_APK_URL, '_blank', 'noopener');
  }

  function openReleasePage() {
    window.open(RELEASE_PAGE_URL, '_blank', 'noopener');
  }

  async function openNativeSettingsSafe() {
    try {
      await openNativeSettings();
    } catch {
      setRouteTrackingError('設定を開けませんでした。端末設定からバッテリー最適化を解除してください。');
    }
  }

  async function openAppPermissionSettingsSafe() {
    const opened = await openAppPermissionSettings();
    if (!opened) {
      setRouteTrackingError('アプリ設定を開けませんでした。端末設定から TrackLog の権限を確認してください。');
    }
  }

  async function openSystemLocationSettingsSafe() {
    const opened = await openSystemLocationSettings();
    if (!opened) {
      setRouteTrackingError('位置情報設定を開けませんでした。端末設定から位置情報を有効にしてください。');
    }
  }

  async function refreshStartupDiagnostics() {
    setDiagnosticsLoading(true);
    try {
      const items = await runStartupDiagnostics();
      setStartupDiagnostics(items);
    } finally {
      setDiagnosticsLoading(false);
    }
  }

  async function runNativeQuickSetupNow() {
    if (!isNative) return;
    setQuickSetupRunning(true);
    setQuickSetupMessage(null);
    try {
      const result = await runNativeSetupWizard();
      await refreshStartupDiagnostics();
      const unresolved = result.steps.filter(step => step.level !== 'ok');
      if (unresolved.length === 0) {
        setQuickSetupMessage('一括セットアップが完了しました。');
      } else {
        setQuickSetupMessage(`追加操作が必要です: ${unresolved.map(step => step.label).join(' / ')}`);
      }
    } catch (e: any) {
      setQuickSetupMessage(e?.message ?? '一括セットアップに失敗しました。');
    } finally {
      setQuickSetupRunning(false);
    }
  }

  async function executeVoiceCommand(command: VoiceCommand): Promise<string> {
    if (command.kind === 'geo_refresh') {
      await captureGeoOnce();
      return '現在地を更新しました。';
    }

    if (command.kind === 'trip_start') {
      if (tripId) return 'すでに運行中です。';
      if (command.odoKm == null) {
        throw new Error('運行開始は「運行開始 123456」のようにODO値を含めてください。');
      }
      const { geo, address } = await getGeoWithAddress();
      const { tripId: newTripId } = await startTrip({ odoKm: command.odoKm, geo, address });
      setTripId(newTripId);
      const ev = await getEventsByTripId(newTripId);
      setEvents(ev);
      return `運行を開始しました（ODO ${command.odoKm} km）。`;
    }

    if (!tripId) {
      throw new Error('この操作は運行開始後に使えます。');
    }

    if (command.kind === 'trip_end') {
      if (command.odoKm == null) {
        throw new Error('運行終了は「運行終了 123999」のようにODO値を含めてください。');
      }
      const { geo, address } = await getGeoWithAddress();
      const { event } = await endTrip({ tripId, odoEndKm: command.odoKm, geo, address });
      await refresh();
      return `運行を終了しました（総距離 ${event.extras.totalKm} km）。`;
    }

    if (command.kind === 'rest_start') {
      if (!canStartRest) throw new Error('今は休息開始できません。進行中の作業を終了してください。');
      if (command.odoKm == null) throw new Error('休息開始はODO値が必要です。');
      const { geo, address } = await getGeoWithAddress();
      await startRest({ tripId, odoKm: command.odoKm, geo, address });
      await refresh();
      return `休息を開始しました（ODO ${command.odoKm} km）。`;
    }

    if (command.kind === 'rest_end') {
      if (!openRestSessionId) throw new Error('休息中ではありません。');
      const { geo, address } = await getGeoWithAddress();
      await endRest({ tripId, restSessionId: openRestSessionId, dayClose: false, geo, address });
      await refresh();
      return '休息を終了しました。';
    }

    if (command.kind === 'break_start') {
      if (!canStartBreak) throw new Error('今は休憩開始できません。');
      const { geo, address } = await getGeoWithAddress();
      await startBreak({ tripId, geo, address });
      await refresh();
      return '休憩を開始しました。';
    }

    if (command.kind === 'break_end') {
      if (!breakActive) throw new Error('休憩中ではありません。');
      const { geo, address } = await getGeoWithAddress();
      await endBreak({ tripId, geo, address });
      cancelBreakReminder();
      await refresh();
      return '休憩を終了しました。';
    }

    if (command.kind === 'load_start') {
      if (!canStartLoad) throw new Error('今は積込開始できません。');
      const { geo, address } = await getGeoWithAddress();
      await startLoad({ tripId, geo, address });
      await refresh();
      return '積込を開始しました。';
    }

    if (command.kind === 'load_end') {
      if (!loadActive) throw new Error('積込中ではありません。');
      const { geo, address } = await getGeoWithAddress();
      await endLoad({ tripId, geo, address });
      await refresh();
      return '積込を終了しました。';
    }

    if (command.kind === 'unload_start') {
      if (!canStartUnload) throw new Error('今は荷卸開始できません。');
      const { geo, address } = await getGeoWithAddress();
      await startUnload({ tripId, geo, address });
      await refresh();
      return '荷卸を開始しました。';
    }

    if (command.kind === 'unload_end') {
      if (!unloadActive) throw new Error('荷卸中ではありません。');
      const { geo, address } = await getGeoWithAddress();
      await endUnload({ tripId, geo, address });
      await refresh();
      return '荷卸を終了しました。';
    }

    if (command.kind === 'expressway_start') {
      if (expresswayActive) throw new Error('すでに高速道路を記録中です。');
      const { geo, address } = await getGeoWithAddress();
      const { eventId } = await startExpressway({ tripId, geo, address });
      await clearPendingExpresswayEndDecision(tripId);
      await cancelNativeExpresswayEndPrompt(tripId);
      if (navigator.onLine && geo) {
        const result = await resolveNearestIC(geo.lat, geo.lng);
        if (result) {
          await updateExpresswayResolved({
            eventId,
            status: 'resolved',
            icName: result.icName,
            icDistanceM: result.distanceM,
          });
        }
      }
      await refresh();
      return '高速道路開始を記録しました。';
    }

    if (command.kind === 'expressway_end') {
      if (!expresswayActive) throw new Error('高速道路を記録中ではありません。');
      const { geo, address } = await getGeoWithAddress();
      await endExpressway({ tripId, geo, address });
      await clearPendingExpresswayEndPrompt(tripId);
      await clearPendingExpresswayEndDecision(tripId);
      await cancelNativeExpresswayEndPrompt(tripId);
      await refresh();
      return '高速道路終了を記録しました。';
    }

    if (command.kind === 'expressway_keep') {
      await clearPendingExpresswayEndPrompt(tripId);
      await clearPendingExpresswayEndDecision(tripId);
      await cancelNativeExpresswayEndPrompt(tripId);
      return '高速の自動終了判定は無効です。手動の開始/終了を使ってください。';
    }

    if (command.kind === 'boarding') {
      const { geo, address } = await getGeoWithAddress();
      const { autoRestStarted } = await addBoarding({ tripId, geo, address });
      await refresh();
      return autoRestStarted
        ? '休息を自動開始して乗船記録を追加しました。'
        : '乗船記録を追加しました。';
    }

    if (command.kind === 'disembark') {
      if (!ferryActive) throw new Error('フェリー乗船を記録中ではありません。');
      const { geo, address } = await getGeoWithAddress();
      await addDisembark({ tripId, geo, address });
      await refresh();
      return '下船記録を追加しました。';
    }

    if (command.kind === 'point_mark') {
      const { geo, address } = await getGeoWithAddress();
      await addPointMark({ tripId, geo, address, label: '音声コマンド' });
      await refresh();
      return '地点マークを追加しました。';
    }

    throw new Error('未対応のコマンドです。');
  }

  async function runVoiceCommand() {
    if (!isNative) {
      setVoiceError('音声コマンドはネイティブ版で利用できます。');
      return;
    }
    setVoiceListening(true);
    setVoiceError(null);
    try {
      const matches = await listenVoiceCommandJa();
      if (matches.length === 0) {
        throw new Error('音声を認識できませんでした。もう一度お試しください。');
      }
      const parsed = findVoiceCommand(matches);
      setVoiceLastText(matches[0]);
      if (!parsed) {
        throw new Error(`コマンドを判別できませんでした: ${matches[0]}`);
      }
      const result = await executeVoiceCommand(parsed);
      setVoiceResult(result);
    } catch (e: any) {
      setVoiceError(e?.message ?? '音声操作に失敗しました。');
    } finally {
      setVoiceListening(false);
    }
  }

  // Periodic backfill while画面を開いている間も走らせる
  useEffect(() => {
    const id = setInterval(() => {
      void backfillAddresses(tripId, 12, 1);
    }, 20000);
    return () => clearInterval(id);
  }, [tripId]);

  // Retry backfill whenオンラインに戻ったら即走らせる
  useEffect(() => {
    const handler = () => {
      void backfillAddresses(tripId);
    };
    window.addEventListener('online', handler);
    return () => window.removeEventListener('online', handler);
  }, [tripId]);

  useEffect(() => {
    refresh();
    void refreshStartupDiagnostics();
    void (async () => {
      await cancelNativeExpresswayEndPrompt();
      const mode = await getRouteTrackingMode();
      setRouteTrackingModeState(mode);
    })();
    setWakeLockAvailable(isWakeLockSupported());
  }, []);

  useEffect(() => {
    const onActive = () => {
      if (document.visibilityState === 'visible') {
        void refreshStartupDiagnostics();
      }
    };
    window.addEventListener('online', onActive);
    document.addEventListener('visibilitychange', onActive);
    return () => {
      window.removeEventListener('online', onActive);
      document.removeEventListener('visibilitychange', onActive);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (apkUrlCopyTimer.current != null) {
        window.clearTimeout(apkUrlCopyTimer.current);
        apkUrlCopyTimer.current = null;
      }
    };
  }, []);

  async function captureGeoOnce() {
    try {
      setGeoError(null);
      const { geo, address } = await getGeoWithAddress();
      if (geo) {
        setGeoStatus({
          lat: geo.lat,
          lng: geo.lng,
          accuracy: geo.accuracy,
          at: new Date().toISOString(),
        });
        if (address) {
          setGeoStatus(prev => (prev ? { ...prev, address } : null));
        }
      } else {
        setGeoError('位置情報が取得できませんでした。位置情報の許可を確認してください。');
      }
    } catch (e: any) {
      setGeoError(e?.message ?? '位置情報の取得に失敗しました');
    }
  }

  useEffect(() => {
    captureGeoOnce();
  }, []);

  useEffect(() => {
    if (!isNative) return;
    let disposed = false;
    void (async () => {
      const available = await checkVoiceRecognitionAvailable();
      if (disposed) return;
      setVoiceAvailable(available);
      if (!available) {
        setVoiceError('音声認識を利用できません。端末の音声入力設定を確認してください。');
      }
    })();
    return () => {
      disposed = true;
    };
  }, [isNative]);

  useEffect(() => {
    if (!tripId) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [tripId]);

  useEffect(() => {
    setRouteTrackingError(null);
    requestRouteTrackingSync();
  }, [routeTrackingMode, tripId, restActive, ferryActive]);

  // Re-acquire wake lock when tab returns to foreground
  useEffect(() => {
    if (!wakeLockOn) return;
    const handler = async () => {
      if (document.visibilityState === 'visible') {
        const ok = await requestWakeLock();
        if (!ok) setWakeLockError('画面スリープ防止を再取得できませんでした');
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [wakeLockOn]);

  // -------- Break reminder (30min) --------
  function cancelBreakReminder() {
    if (breakReminderTimer.current != null) {
      window.clearTimeout(breakReminderTimer.current);
      breakReminderTimer.current = null;
    }
  }

  async function showBreakNotification() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      await Notification.requestPermission();
    }
    if (Notification.permission !== 'granted') return;

    const options: NotificationOptions & { vibrate?: number[]; renotify?: boolean } = {
      body: '休憩開始から30分経過しました',
      vibrate: [200, 100, 200],
      requireInteraction: true,
      tag: 'tracklog-break-30min',
      renotify: true,
    };

    try {
      new Notification('休憩30分経過', options);
    } catch {
      // ignore
    }
  }

  function scheduleBreakReminder(startMs: number) {
    cancelBreakReminder();
    const elapsed = Date.now() - startMs;
    const remaining = 30 * 60 * 1000 - elapsed;
    if (remaining <= 0) {
      void showBreakNotification();
      return;
    }
    breakReminderTimer.current = window.setTimeout(() => {
      void showBreakNotification();
      breakReminderTimer.current = null;
    }, remaining);
  }

  const routeTrackingModeNote =
    routeTrackingMode === 'precision'
      ? '精度重視: 更新頻度を高めて記録します（電池消費は大きめ）。'
      : 'バッテリー重視: 更新頻度を下げて電池を節約します。';

  const nativeToolsContent = isNative ? (
    <div style={{ display: 'grid', gap: 12 }}>
      <div>
        <div style={{ fontWeight: 800, marginBottom: 6 }}>ルート記録モード</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            className="trip-btn"
            style={{ background: routeTrackingMode === 'precision' ? '#0ea5e9' : undefined, color: routeTrackingMode === 'precision' ? '#fff' : undefined }}
            onClick={() => void updateRouteTrackingMode('precision')}
          >
            精度重視
          </button>
          <button
            className="trip-btn"
            style={{ background: routeTrackingMode === 'battery' ? '#16a34a' : undefined, color: routeTrackingMode === 'battery' ? '#fff' : undefined }}
            onClick={() => void updateRouteTrackingMode('battery')}
          >
            バッテリー重視
          </button>
        </div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 6 }}>{routeTrackingModeNote}</div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 4 }}>
          運行中は自動でルート記録し、休息中はGPS記録を自動停止します。
        </div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 4 }}>
          Androidでは画面OFF/バックグラウンド中もルート記録を継続します。高速道路の開始/終了は手動です。
        </div>
      </div>
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div style={{ fontWeight: 800 }}>起動時セルフ診断</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="trip-btn" onClick={() => void runNativeQuickSetupNow()} disabled={quickSetupRunning}>
              {quickSetupRunning ? '設定中…' : '一括セットアップ'}
            </button>
            <button className="trip-btn trip-btn--ghost" onClick={() => void refreshStartupDiagnostics()} disabled={diagnosticsLoading}>
              {diagnosticsLoading ? '診断中…' : '再診断'}
            </button>
          </div>
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          {startupDiagnostics.map(item => {
            const color = item.level === 'ok' ? '#86efac' : item.level === 'warn' ? '#fcd34d' : '#fca5a5';
            return (
              <div key={item.id} style={{ fontSize: 12, color: '#e2e8f0' }}>
                <span style={{ color, fontWeight: 900 }}>{item.label}</span>
                <span> : {item.detail}</span>
              </div>
            );
          })}
          {startupDiagnostics.length === 0 && !diagnosticsLoading && (
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>診断結果なし</div>
          )}
          {quickSetupMessage && (
            <div style={{ fontSize: 12, color: '#93c5fd' }}>{quickSetupMessage}</div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <button className="trip-btn trip-btn--ghost" onClick={() => void openAppPermissionSettingsSafe()}>
            権限設定を開く
          </button>
          <button className="trip-btn trip-btn--ghost" onClick={() => void openSystemLocationSettingsSafe()}>
            位置情報設定を開く
          </button>
        </div>
      </div>
      <div>
        <div style={{ fontWeight: 800, marginBottom: 6 }}>電池の最適化対策</div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>
          バックグラウンドで止まる場合は、アプリの電池最適化を除外してください。
        </div>
        <button className="trip-btn" style={{ marginTop: 8 }} onClick={() => void openNativeSettingsSafe()}>
          設定を開く
        </button>
      </div>
      <div>
        <div style={{ fontWeight: 800, marginBottom: 6 }}>アップデート（APKダウンロード）</div>
        <div style={{ fontSize: 12, wordBreak: 'break-all', color: '#e2e8f0' }}>{LATEST_APK_URL}</div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 4 }}>
          更新時はこのURLから最新版をダウンロードできます。
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <button className="trip-btn" onClick={() => void copyLatestApkUrl()}>
            URLをコピー
          </button>
          <button className="trip-btn" onClick={openLatestApkUrl}>
            開く
          </button>
          <button className="trip-btn trip-btn--ghost" onClick={openReleasePage}>
            リリースページ
          </button>
        </div>
        {apkUrlCopied && <div style={{ fontSize: 12, color: '#86efac', marginTop: 6 }}>コピーしました</div>}
      </div>
    </div>
  ) : null;

  const nativeSettingsDialog = nativeToolsContent && nativeSettingsOpen ? (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.6)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 10000,
      }}
      onClick={() => setNativeSettingsOpen(false)}
    >
      <div
        style={{ width: 'min(720px, 94vw)', background: '#0f172a', color: '#fff', borderRadius: 16, padding: 16 }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontSize: 18, fontWeight: 900 }}>ネイティブ設定</div>
          <button className="trip-detail__button trip-detail__button--small" onClick={() => setNativeSettingsOpen(false)}>
            閉じる
          </button>
        </div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', marginBottom: 10 }}>
          バックグラウンド安定化と更新リンク
        </div>
        {nativeToolsContent}
      </div>
    </div>
  ) : null;

  const liveVm = useMemo(() => {
    if (!tripId) return null;
    const hasTripStart = events.some(event => event.tripId === tripId && event.type === 'trip_start');
    if (!hasTripStart) return null;
    return buildTripViewModel(tripId, events);
  }, [tripId, events]);
  const liveReportTrip = useMemo(() => {
    if (!tripId || !liveVm) return null;
    return buildReportTripFromAppEvents({
      tripId,
      events,
      dayRuns: liveVm.dayRuns,
    });
  }, [tripId, events, liveVm]);
  const metricsMinute = Math.floor(now / 60000);
  const metricsNowIso = useMemo(() => new Date(metricsMinute * 60000).toISOString(), [metricsMinute]);
  const liveMetricsList = useMemo(
    () => (liveReportTrip ? computeTripDayMetrics(liveReportTrip, { currentTs: metricsNowIso }) : []),
    [liveReportTrip, metricsNowIso],
  );
  const activeDayMetrics = liveMetricsList[liveMetricsList.length - 1] ?? null;
  const liveDrive = useMemo(() => computeLiveDriveStatus(events, metricsNowIso), [events, metricsNowIso]);

  // Render when no trip is active
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
            {isNative && (
              <button className="pill-link" onClick={() => setNativeSettingsOpen(true)} aria-label="ネイティブ設定">
                ⚙
              </button>
            )}
              <Link to="/settings" className="pill-link">
                同期/端末
              </Link>
              <Link to="/history" className="pill-link">
                運行履歴
              </Link>
              <Link to="/report" className="pill-link">
                運行日報
              </Link>
            </div>
          </div>
          <div className="start-hero__content">
            <div className="start-hero__panel start-hero__panel--hero">
              <div className="start-hero__eyebrow">出発前チェック</div>
              <div className="start-hero__title">今日の運行を開始</div>
              <div className="start-hero__subtitle">開始ODOを入力して、そのまま今日の運行記録を始めます。</div>
              <div className="start-hero__support-grid">
                <div className="start-hero__support-card">
                  <strong>最初に必要なのは開始ODOだけ</strong>
                  <span>出発時点を先に固定し、距離と区間の計算を安定させます。</span>
                </div>
                <div className="start-hero__support-card">
                  <strong>履歴と日報は別導線</strong>
                  <span>開始前でも上部リンクから履歴確認や日報入力にすぐ移動できます。</span>
                </div>
              </div>
              <div className="start-hero__actions">
                <BigButton
                  label={loading ? '読み込み中…' : '運行開始'}
                  hint="開始ODOを入力して記録開始"
                  disabled={loading}
                  onClick={() => {
                    setOdoDialog({ kind: 'trip_start' });
                  }}
                />
              </div>
            </div>
            <div className="start-hero__stack">
              <div className="start-hero__panel start-hero__panel--compact">
                <div className="start-hero__panel-title">このあと使う操作</div>
                <div className="start-hero__subtitle">
                  運行開始後はホームで積込・荷卸・休憩・休息をまとめて記録できます。
                </div>
              </div>
              {isNative && (
                <div className="start-hero__panel start-hero__panel--compact">
                  <div className="start-hero__panel-title">音声コマンド</div>
                  <div className="start-hero__subtitle" style={{ marginBottom: 10 }}>
                    例: 「運行開始 123456」「現在地更新」
                  </div>
                  <button
                    className="pill-link"
                    style={{ width: '100%', justifyContent: 'center', padding: '14px 16px' }}
                    onClick={() => void runVoiceCommand()}
                    disabled={voiceListening || !voiceAvailable}
                  >
                    {voiceListening ? '聞き取り中…' : '音声で操作する'}
                  </button>
                  {voiceLastText && (
                    <div style={{ marginTop: 10, fontSize: 13, opacity: 0.8 }}>
                      認識: {voiceLastText}
                    </div>
                  )}
                  {voiceResult && (
                    <div style={{ marginTop: 6, fontSize: 13, color: '#86efac' }}>
                      結果: {voiceResult}
                    </div>
                  )}
                  {voiceError && (
                    <div style={{ marginTop: 6, fontSize: 13, color: '#fca5a5' }}>
                      {voiceError}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          {nativeSettingsDialog}
          <OdoDialog
            open={odoDialog?.kind === 'trip_start'}
            title="運行開始"
            description="運行開始時のオドメーター（km）を入力してください"
            confirmText="運行開始"
            onCancel={() => setOdoDialog(null)}
            onConfirm={async odoKm => {
              setOdoDialog(null);
              setLoading(true);
              try {
                const { geo, address } = await getGeoWithAddress();
                const { tripId: newTripId } = await startTrip({ odoKm, geo, address });
                setTripId(newTripId);
                const ev = await getEventsByTripId(newTripId);
                setEvents(ev);
              } catch (e: any) {
                alert(e?.message ?? '運行開始に失敗しました');
              } finally {
                setLoading(false);
              }
            }}
          />
        </div>
      </div>
    );
  }

  // trip is active
  const tripStart = events.find(e => e.type === 'trip_start') as any;
  const tripStartOdo = tripStart?.extras?.odoKm;
  const tripElapsed = tripStart?.ts ? now - new Date(tripStart.ts).getTime() : null;
  const restStart = openRestSessionId
    ? (events.find(e => e.type === 'rest_start' && (e as any).extras?.restSessionId === openRestSessionId) as any)
    : null;
  const loadStart = openLoadSessionId
    ? (events.find(e => e.type === 'load_start' && (e as any).extras?.loadSessionId === openLoadSessionId) as any)
    : null;
  const unloadStart = openUnloadSessionId
    ? (events.find(e => e.type === 'unload_start' && (e as any).extras?.unloadSessionId === openUnloadSessionId) as any)
    : null;
  const breakStart = openBreakSessionId
    ? (events.find(e => e.type === 'break_start' && (e as any).extras?.breakSessionId === openBreakSessionId) as any)
    : null;
  const driveStartedAt = liveDrive.currentCategory === 'drive' ? liveDrive.currentCategoryStartedAt : null;
  const liveContinuousMessage =
    liveDrive.currentCategory === 'drive'
      ? liveDrive.continuousDriveEmergencyExceeded
        ? '4時間30分を超過しています'
        : liveDrive.continuousDriveExceeded
          ? `4時間超過 / 4時間30分まで残り ${fmtMinutesShort(liveDrive.remainingUntilEmergencyLimitMinutes)}`
          : `4時間まで残り ${fmtMinutesShort(liveDrive.remainingUntilLimitMinutes)}`
      : liveDrive.resetCompleted
        ? `初期化済み${liveDrive.resetCompletedAt ? ` / ${fmtDateTime(liveDrive.resetCompletedAt)}` : ''}`
        : liveDrive.currentNonDrivingMinutes > 0
          ? liveDrive.currentNonDrivingMinutes < 10
            ? `現在の中断 ${fmtMinutesShort(liveDrive.currentNonDrivingMinutes)} / 10分未満は未算入`
            : `初期化進捗 ${fmtMinutesShort(30 - liveDrive.remainingUntilResetMinutes)} / 30分`
          : '次の中断で30分確保すると初期化できます';
  const legalSummaryRows = activeDayMetrics
    ? [
        {
          key: 'rule',
          label: '適用ルール',
          value: activeDayMetrics.ruleModeLabel,
          note: activeDayMetrics.ruleModeReason,
        },
        {
          key: 'rolling-48h',
          label: '直近48h運転',
          value: `${fmtMinutesShort(activeDayMetrics.rollingTwoDayDriveMinutes)} / 18時間`,
          note: `残り ${fmtMinutesShort(activeDayMetrics.nextDriveRemaining)}`,
        },
        {
          key: 'rolling-14d',
          label: '直近14日運転',
          value: `${fmtMinutesShort(activeDayMetrics.rollingTwoWeekDriveMinutes)} / 88時間`,
          note: `週平均 ${fmtMinutesShort(activeDayMetrics.rollingTwoWeekWeeklyAverageMinutes)}`,
        },
        {
          key: 'constraint',
          label: '拘束時間',
          value: `${fmtMinutesShort(activeDayMetrics.constraintMinutes)} / ${fmtMinutesShort(activeDayMetrics.effectiveConstraintLimitMinutes)}`,
          note: '当日累計',
        },
        {
          key: 'rest-equivalent',
          label: '休息相当',
          value: `${fmtMinutesShort(activeDayMetrics.restEquivalentMinutes)} / 最低 ${fmtMinutesShort(activeDayMetrics.effectiveRestMinimumMinutes)}`,
          note: activeDayMetrics.earliestRestart ? `次の再開目安 ${fmtDateTime(activeDayMetrics.earliestRestart)}` : '休息開始待ち',
        },
      ]
    : [];
  const startMetaText = fmtDateTime(tripStart?.ts);
  const activeStatusRows = [
    {
      key: 'trip',
      label: '運行',
      value: tripElapsed != null ? fmtDuration(tripElapsed) : '-',
      tone: 'trip',
    },
    ferryStart
      ? {
          key: 'ferry',
          label: 'フェリー',
          value: fmtDuration(now - new Date(ferryStart.ts).getTime()),
          tone: 'ferry',
        }
      : null,
    restStart
      ? {
          key: 'rest',
          label: '休息',
          value: fmtDuration(now - new Date(restStart.ts).getTime()),
          tone: 'rest',
        }
      : null,
    loadStart
      ? {
          key: 'load',
          label: '積込',
          value: fmtDuration(now - new Date(loadStart.ts).getTime()),
          tone: 'load',
        }
      : null,
    unloadStart
      ? {
          key: 'unload',
          label: '荷卸',
          value: fmtDuration(now - new Date(unloadStart.ts).getTime()),
          tone: 'unload',
        }
      : null,
    breakStart
      ? {
          key: 'break',
          label: '休憩',
          value: fmtDuration(now - new Date(breakStart.ts).getTime()),
          tone: 'break',
        }
      : null,
    driveStartedAt
      ? {
          key: 'drive',
          label: '運転',
          value: fmtDuration(now - new Date(driveStartedAt).getTime()),
          tone: 'drive',
        }
      : null,
  ].filter(Boolean) as Array<{ key: string; label: string; value: string; tone: string }>;
  const activeHighlights = [
    {
      key: 'route',
      label: 'GPS記録',
      value: routeTrackingMode === 'precision' ? '精度重視' : '電池重視',
      tone: 'route',
    },
    expresswayActive && expresswayStart
      ? {
          key: 'expressway',
          label: '高速',
          value: fmtDuration(now - new Date(expresswayStart.ts).getTime()),
          tone: 'expressway',
        }
      : null,
    ferryActive && ferryStart
      ? {
          key: 'ferry',
          label: 'フェリー',
          value: fmtDuration(now - new Date(ferryStart.ts).getTime()),
          tone: 'ferry',
        }
      : null,
    wakeLockAvailable
      ? {
          key: 'wake-lock',
          label: '画面ON',
          value: wakeLockOn ? '維持中' : 'OFF',
          tone: wakeLockOn ? 'wake' : 'muted',
        }
      : null,
  ].filter(Boolean) as Array<{ key: string; label: string; value: string; tone: string }>;
  const currentActivity = activeStatusRows.find(row => row.key !== 'trip');
  const currentActivityLabel = currentActivity ? `${currentActivity.label}中` : '通常運行';
  const currentActivityTone = currentActivity?.tone ?? 'trip';
  const highestAlert = activeDayMetrics?.alerts[0] ?? null;
  const driveTone = liveDrive.continuousDriveEmergencyExceeded
    ? 'danger'
    : liveDrive.continuousDriveExceeded
      ? 'warning'
      : 'drive';
  const cockpitCards = [
    {
      key: 'current',
      label: '現在',
      value: currentActivityLabel,
      note: currentActivity?.value
        ? `${currentActivity.label} ${currentActivity.value}`
        : `運行 ${tripElapsed != null ? fmtDuration(tripElapsed) : '-'}`,
      tone: currentActivityTone,
    },
    {
      key: 'drive',
      label: '連続運転',
      value: fmtMinutesShort(liveDrive.driveSinceResetMinutes),
      note: liveContinuousMessage,
      tone: driveTone,
    },
    {
      key: 'next',
      label: '次の確認',
      value: highestAlert ? '警告あり' : expresswayActive ? '高速中' : restActive ? '休息中' : '記録継続',
      note: highestAlert?.message
        ?? (expresswayActive
          ? '高速終了時は確認アクションで確定'
          : restActive
            ? '休息終了操作まで休息として扱います'
            : '積込・荷卸・休憩は右側の主要操作から記録'),
      tone: highestAlert ? (highestAlert.level === 'danger' ? 'danger' : 'warning') : expresswayActive ? 'expressway' : 'route',
    },
  ];
  return (
    <div className="home-backdrop">
      <div className="home-shell">
        <div className="home-topbar">
          <div className="home-topbar__main">
            <div className="home-topbar__eyebrow">TrackLog運行アシスト</div>
            <div className="home-topbar__title">運行中</div>
            <div className="home-topbar__meta">開始 {startMetaText} / 開始ODO {tripStartOdo ?? '-'} km</div>
          </div>
          <div className="home-topbar__actions">
            {isNative && (
              <button className="pill-link" onClick={() => setNativeSettingsOpen(true)} aria-label="ネイティブ設定">
                ⚙
              </button>
            )}
            <Link to="/settings" className="pill-link">
              同期/端末
            </Link>
            <Link to={`/trip/${tripId}`} className="pill-link">
              運行詳細
            </Link>
            <Link to={`/trip/${tripId}/route`} className="pill-link">
              ルート表示
            </Link>
            <Link to="/history" className="pill-link">
              運行履歴
            </Link>
            <Link to="/report" className="pill-link">
              運行日報
            </Link>
            {wakeLockAvailable && (
              <button
                className="pill-link"
                style={{ background: wakeLockOn ? '#0ea5e9' : undefined, color: wakeLockOn ? '#fff' : undefined }}
                onClick={async () => {
                  setWakeLockError(null);
                  if (wakeLockOn) {
                    await releaseWakeLock();
                    setWakeLockOn(false);
                    return;
                  }
                  const ok = await requestWakeLock();
                  if (ok) {
                    setWakeLockOn(true);
                  } else {
                    setWakeLockError('画面スリープ防止を有効にできませんでした。ブラウザの許可を確認してください。');
                  }
                }}
              >
                画面ON維持
              </button>
            )}
          </div>
        </div>
        <div className="home-cockpit">
          <div className="home-cockpit__heading">
            <span>運行コックピット</span>
            <strong>{routeTrackingMode === 'precision' ? 'GPS精度重視' : 'GPS電池重視'}</strong>
          </div>
          <div className="home-cockpit__cards">
            {cockpitCards.map(card => (
              <div key={card.key} className={`home-cockpit-card home-cockpit-card--${card.tone}`}>
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.note}</small>
              </div>
            ))}
          </div>
        </div>
        <div className="home-grid">
          <div className="home-primary">
            <div className="card home-overview-card">
              <div className="home-section-label">記録状態</div>
              <div className="home-overview__hero">
                <div>
                  <div className="home-overview__title">バックグラウンド記録を継続中</div>
                  <div className="home-overview__subtitle">{routeTrackingModeNote}</div>
                </div>
                <div className="home-overview__hero-pills">
                  <div className={`home-overview__pill home-overview__pill--${currentActivityTone}`}>{currentActivityLabel}</div>
                  <div className="home-overview__pill">開始ODO {tripStartOdo ?? '-'} km</div>
                </div>
              </div>
              <div className="home-status-list">
                {activeStatusRows.map(row => (
                  <div key={row.key} className={`home-status-row home-status-row--${row.tone}`}>
                    <span>{row.label}</span>
                    <strong>{row.value}</strong>
                  </div>
                ))}
              </div>
              <div className="home-highlight-pills">
                {activeHighlights.map(item => (
                  <div key={item.key} className={`home-highlight-pill home-highlight-pill--${item.tone}`}>
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </div>
                ))}
              </div>
            </div>
            <div className="card home-compliance-card">
              <div className="home-section-label">運行状態と法令チェック</div>
              <div className="home-compliance-hero">
                <div className="home-compliance-hero__item">
                  <span>現在状態</span>
                  <strong>{currentActivityLabel}</strong>
                  <small>
                    {currentActivity?.value
                      ? `継続 ${currentActivity.value}`
                      : `運行 ${tripElapsed != null ? fmtDuration(tripElapsed) : '-'}`}
                  </small>
                </div>
                <div className="home-compliance-hero__item">
                  <span>純運転</span>
                  <strong>{fmtMinutesShort(liveDrive.driveSinceResetMinutes)}</strong>
                  <small>{liveContinuousMessage}</small>
                </div>
                <div className="home-compliance-hero__item">
                  <span>初期化判定</span>
                  <strong>
                    {liveDrive.resetCompleted
                      ? '初期化済み'
                      : liveDrive.currentNonDrivingMinutes > 0
                        ? `${fmtMinutesShort(30 - liveDrive.remainingUntilResetMinutes)} / 30分`
                        : '待機中'}
                  </strong>
                  <small>
                    {liveDrive.lastResetAt
                      ? `前回 ${fmtDateTime(liveDrive.lastResetAt)}`
                      : 'まだ初期化していません'}
                  </small>
                </div>
              </div>
              {legalSummaryRows.length > 0 && (
                <div className="home-compliance-grid">
                  {legalSummaryRows.map(row => (
                    <div key={row.key} className="home-compliance-metric">
                      <span>{row.label}</span>
                      <strong>{row.value}</strong>
                      <small>{row.note}</small>
                    </div>
                  ))}
                </div>
              )}
              {activeDayMetrics && activeDayMetrics.alerts.length > 0 && (
                <div className="home-compliance-alerts">
                  {activeDayMetrics.alerts.map((alert, index) => (
                    <div
                      key={`${alert.message}-${index}`}
                      className={`home-alert ${alert.level === 'danger' ? 'home-alert--danger' : 'home-alert--warning'}`}
                    >
                      {alert.message}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="card home-info-card">
              <div className="home-section-label">現在地</div>
              {geoStatus ? (
                <div className="home-kv-list">
                  <div className="home-kv-row">
                    <span>精度</span>
                    <strong>{geoStatus.accuracy != null ? `±${Math.round(geoStatus.accuracy)}m` : '取得中'}</strong>
                  </div>
                  <div className="home-kv-row">
                    <span>緯度</span>
                    <strong>{geoStatus.lat.toFixed(5)}</strong>
                  </div>
                  <div className="home-kv-row">
                    <span>経度</span>
                    <strong>{geoStatus.lng.toFixed(5)}</strong>
                  </div>
                  {geoStatus.address && <div className="home-info-card__address">{geoStatus.address}</div>}
                  <div className="home-info-card__meta">取得時刻: {new Date(geoStatus.at).toLocaleString('ja-JP')}</div>
                </div>
              ) : (
                <div className="home-info-card__meta">位置情報は未取得です。</div>
              )}
              {geoError && <div className="home-inline-alert">{geoError}</div>}
              <button className="trip-btn home-secondary-button" onClick={captureGeoOnce}>
                位置情報を更新
              </button>
            </div>
            {isNative && (
              <div className="card home-info-card">
                <div className="home-section-label">音声コマンド</div>
                <div className="home-info-card__meta">例: 「積込開始」「荷卸終了」「高速道路開始」「高速道路終了」</div>
                <button
                  onClick={() => void runVoiceCommand()}
                  disabled={voiceListening || !voiceAvailable}
                  className="home-voice-button"
                >
                  {voiceListening ? '聞き取り中…' : '音声で操作する'}
                </button>
                {voiceLastText && <div className="home-info-card__meta">認識: {voiceLastText}</div>}
                {voiceResult && <div className="home-inline-success">結果: {voiceResult}</div>}
                {voiceError && <div className="home-inline-alert">{voiceError}</div>}
              </div>
            )}
          </div>
          <div className="home-action-stack">
            {wakeLockError && <div className="home-alert home-alert--danger">{wakeLockError}</div>}
            {routeTrackingError && <div className="home-alert home-alert--danger">{routeTrackingError}</div>}
            <div className="card home-action-panel">
              <div className="home-section-label">主要操作</div>
              <div className="home-action-panel__hint">運行中に頻繁に使う記録操作です。</div>
              <div className="home-actions">
          {/* End trip */}
          <BigButton
            label="運行終了"
            hint="終了ODOを入力して総距離を確定"
            variant="danger"
            onClick={() => setOdoDialog({ kind: 'trip_end' })}
          />
          {/* Load (積込) */}
          {loadActive ? (
            <BigButton
              label="積込終了"
              hint="進行中の積込を終了"
              variant="neutral"
              onClick={async () => {
                try {
                  const { geo, address } = await getGeoWithAddress();
                  await endLoad({ tripId, geo, address });
                  await refresh();
                } catch (e: any) {
                  alert(e?.message ?? '積込終了に失敗しました');
                }
              }}
            />
          ) : (
            <BigButton
              label="積込開始"
              hint="積込イベントを開始"
              disabled={!canStartLoad}
              onClick={async () => {
                try {
                  const { geo, address } = await getGeoWithAddress();
                  await startLoad({ tripId, geo, address });
                  await refresh();
                } catch (e: any) {
                  alert(e?.message ?? '積込開始に失敗しました');
                }
              }}
            />
          )}
          {/* Unload (荷卸) */}
          {unloadActive ? (
            <BigButton
              label="荷卸終了"
              hint="進行中の荷卸を終了"
              variant="neutral"
              onClick={async () => {
                try {
                  const { geo, address } = await getGeoWithAddress();
                  await endUnload({ tripId, geo, address });
                  await refresh();
                } catch (e: any) {
                  alert(e?.message ?? '荷卸終了に失敗しました');
                }
              }}
            />
          ) : (
            <BigButton
              label="荷卸開始"
              hint="荷卸イベントを開始"
              disabled={!canStartUnload}
              onClick={async () => {
                try {
                  const { geo, address } = await getGeoWithAddress();
                  await startUnload({ tripId, geo, address });
                  await refresh();
                } catch (e: any) {
                  alert(e?.message ?? '荷卸開始に失敗しました');
                }
              }}
            />
          )}
          {/* Break (休憩) */}
          {breakActive ? (
            <BigButton
              label="休憩終了"
              hint="進行中の休憩を終了"
              variant="neutral"
              onClick={async () => {
                try {
                  const { geo, address } = await getGeoWithAddress();
                  await endBreak({ tripId, geo, address });
                  cancelBreakReminder();
                  await refresh();
                } catch (e: any) {
                  alert(e?.message ?? '休憩終了に失敗しました');
                }
              }}
            />
          ) : (
            <BigButton
              label="休憩開始"
              hint="短時間の休憩を記録"
              disabled={!canStartBreak}
              onClick={async () => {
                try {
                  const { geo, address } = await getGeoWithAddress();
                  await startBreak({ tripId, geo, address });
                  await refresh();
                } catch (e: any) {
                  alert(e?.message ?? '休憩開始に失敗しました');
                }
              }}
            />
          )}
          {/* Rest (休息) */}
          {restActive ? (
            <BigButton
              label="休息終了"
              hint="進行中の休息を終了"
              variant="neutral"
              onClick={async () => {
                if (!openRestSessionId) return;
                setLoading(true);
                try {
                  const { geo, address } = await getGeoWithAddress();
                  await endRest({ tripId, restSessionId: openRestSessionId, dayClose: false, geo, address });
                  await refresh();
                } catch (e: any) {
                  alert(e?.message ?? '休息終了に失敗しました');
                } finally {
                  setLoading(false);
                }
              }}
            />
          ) : (
            <BigButton
              label="休息開始（ODO）"
              hint="開始ODOを入力して休息開始"
              disabled={!canStartRest}
              onClick={() => {
                setOdoDialog({ kind: 'rest_start' });
              }}
            />
          )}
              </div>
            </div>
            <div className="card home-action-panel">
              <div className="home-section-label">補助操作</div>
              <div className="home-action-panel__hint">給油や補助イベントは一段弱く表示しています。</div>
              <div className="home-action-grid">
                <BigButton
                  label="給油（数量）"
                  hint="給油量を記録"
                  size="compact"
                  variant="neutral"
                  onClick={() => {
                    setFuelOpen(true);
                  }}
                />
                {expresswayActive ? (
                  <BigButton
                    label="高速道路終了"
                    hint="終了地点を記録"
                    variant="neutral"
                    size="compact"
                    onClick={async () => {
                      try {
                        const { geo, address } = await getGeoWithAddress();
                        await endExpressway({ tripId, geo, address });
                        await clearPendingExpresswayEndPrompt(tripId);
                        await clearPendingExpresswayEndDecision(tripId);
                        await cancelNativeExpresswayEndPrompt(tripId);
                        await refresh();
                      } catch (e: any) {
                        alert(e?.message ?? '高速道路の記録に失敗しました');
                      }
                    }}
                  />
                ) : (
                  <BigButton
                    label="高速道路開始"
                    hint="開始地点を記録"
                    size="compact"
                    variant="neutral"
                    onClick={async () => {
                      try {
                        const { geo, address } = await getGeoWithAddress();
                        const { eventId } = await startExpressway({ tripId, geo, address });
                        await clearPendingExpresswayEndDecision(tripId);
                        await cancelNativeExpresswayEndPrompt(tripId);
                        if (navigator.onLine && geo) {
                          const result = await resolveNearestIC(geo.lat, geo.lng);
                          if (result) {
                            await updateExpresswayResolved({
                              eventId,
                              status: 'resolved',
                              icName: result.icName,
                              icDistanceM: result.distanceM,
                            });
                          }
                        }
                        await refresh();
                      } catch (e: any) {
                        alert(e?.message ?? '高速道路の記録に失敗しました');
                      }
                    }}
                  />
                )}
                {ferryActive ? (
                  <BigButton
                    label="フェリー下船"
                    hint="下船イベントを追加"
                    size="compact"
                    variant="neutral"
                    onClick={async () => {
                      try {
                        const { geo, address } = await getGeoWithAddress();
                        await addDisembark({ tripId, geo, address });
                        await refresh();
                      } catch (e: any) {
                        alert(e?.message ?? '下船の記録に失敗しました');
                      }
                    }}
                  />
                ) : (
                  <BigButton
                    label="フェリー乗船"
                    hint="未休息なら休息開始も同時に記録"
                    size="compact"
                    variant="neutral"
                    onClick={async () => {
                      try {
                        const { geo, address } = await getGeoWithAddress();
                        const { autoRestStarted } = await addBoarding({ tripId, geo, address });
                        await refresh();
                        if (autoRestStarted) {
                          alert('休息を自動開始してフェリー乗船を記録しました。');
                        }
                      } catch (e: any) {
                        alert(e?.message ?? '乗船の記録に失敗しました');
                      }
                    }}
                  />
                )}
                <BigButton
                  label="地点マーク"
                  hint="現在地をメモ"
                  size="compact"
                  variant="neutral"
                  onClick={async () => {
                    try {
                      const { geo, address } = await getGeoWithAddress();
                      await addPointMark({ tripId, geo, address, label: 'ホーム画面ボタン' });
                      await refresh();
                    } catch (e: any) {
                      alert(e?.message ?? '地点マークの保存に失敗しました');
                    }
                  }}
                />
              </div>
            </div>
          </div>
        </div>
        {nativeSettingsDialog}
      </div>
      {/* Fuel dialog */}
      <FuelDialog
        open={fuelOpen}
        onCancel={() => setFuelOpen(false)}
        onConfirm={async liters => {
          setFuelOpen(false);
          try {
            const { geo, address } = await getGeoWithAddress();
            await addRefuel({ tripId, liters, geo, address });
            await refresh();
          } catch (e: any) {
            alert(e?.message ?? '給油の記録に失敗しました');
          }
        }}
      />
      {/* Rest start dialog */}
      <OdoDialog
        open={odoDialog?.kind === 'rest_start'}
        title="休息開始"
        description="休息開始ODO（km）を入力してください"
        confirmText="休息開始"
        onCancel={() => setOdoDialog(null)}
        onConfirm={async odoKm => {
          setOdoDialog(null);
          setLoading(true);
          try {
              const { geo, address } = await getGeoWithAddress();
              // 直近チェックポイント（運行開始 or 直前の休息開始）との差を計算して通知する
            const lastCheckpointOdo = (() => {
              const checkpoints = events
                .filter(e => e.type === 'trip_start' || e.type === 'rest_start')
                .sort((a, b) => a.ts.localeCompare(b.ts));
              const last = checkpoints[checkpoints.length - 1] as any;
              return last?.extras?.odoKm as number | undefined;
            })();
            const diffKm = lastCheckpointOdo != null ? odoKm - lastCheckpointOdo : undefined;

            await startRest({ tripId, odoKm, geo, address });
            if (diffKm != null && diffKm >= 0) {
              alert(`休息開始までの走行距離: ${diffKm} km`);
            }
            await refresh();
          } catch (e: any) {
            alert(e?.message ?? '休息開始に失敗しました');
          } finally {
            setLoading(false);
          }
        }}
      />
      {/* Trip end dialog */}
      <OdoDialog
        open={odoDialog?.kind === 'trip_end'}
        title="運行終了"
        description="終了ODO（km）を入力してください。総距離と最終区間距離を計算します。"
        confirmText="運行終了"
        onCancel={() => setOdoDialog(null)}
          onConfirm={async odoEndKm => {
            setOdoDialog(null);
            setLoading(true);
            try {
              const { geo, address } = await getGeoWithAddress();
              const { event } = await endTrip({ tripId, odoEndKm, geo, address });
              alert(
                `運行終了\n` +
                  `総距離: ${event.extras.totalKm} km\n` +
                  `最終区間: ${event.extras.lastLegKm} km`,
            );
            await refresh();
          } catch (e: any) {
            alert(e?.message ?? '運行終了に失敗しました');
          } finally {
            setLoading(false);
          }
        }}
      />
    </div>
  );
}
