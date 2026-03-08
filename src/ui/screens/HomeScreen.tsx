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
import { openNativeSettings, startRouteTracking, stopRouteTracking } from '../../services/routeTracking';
import { cancelNativeExpresswayEndPrompt } from '../../services/nativeExpresswayPrompt';
import { runStartupDiagnostics, type StartupDiagnosticItem } from '../../services/startupDiagnostics';
import { runNativeQuickSetup as runNativeSetupWizard } from '../../services/nativeSetup';
import { DEFAULT_APK_DOWNLOAD_URL, RELEASE_PAGE_URL } from '../../app/releaseInfo';
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
  const isNative = Capacitor.isNativePlatform();

  const restActive = !!openRestSessionId;
  const loadActive = !!openLoadSessionId;
  const unloadActive = !!openUnloadSessionId;
  const breakActive = !!openBreakSessionId;
  const expresswayActive = !!openExpresswaySessionId;
  const canStartRest = !loadActive && !breakActive && !restActive && !unloadActive;
  const canStartLoad = !restActive && !breakActive && !loadActive && !unloadActive;
  const canStartUnload = !restActive && !breakActive && !unloadActive && !loadActive;
  const canStartBreak = !restActive && !loadActive && !breakActive && !unloadActive;
  const expresswayStart = openExpresswaySessionId
    ? (events.find(e => e.type === 'expressway_start' && (e as any).extras?.expresswaySessionId === openExpresswaySessionId) as any)
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
      await addBoarding({ tripId, geo, address });
      await refresh();
      return '乗船記録を追加しました。';
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
      await clearPendingExpresswayEndPrompt();
      await clearPendingExpresswayEndDecision();
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
    const timer = window.setInterval(() => {
      void refreshStartupDiagnostics();
    }, 30000);
    window.addEventListener('online', onActive);
    document.addEventListener('visibilitychange', onActive);
    return () => {
      window.clearInterval(timer);
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
    let cancelled = false;
    void (async () => {
      if (!tripId || restActive) {
        if (restActive) {
          setRouteTrackingError(null);
        }
        await stopRouteTracking();
        return;
      }
      try {
        setRouteTrackingError(null);
        await startRouteTracking(tripId, routeTrackingMode);
      } catch (e: any) {
        if (cancelled) return;
        setRouteTrackingError(e?.message ?? 'ルート記録の開始に失敗しました');
        await stopRouteTracking();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [routeTrackingMode, tripId, restActive]);

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
              <Link to="/history" className="pill-link">
                運行履歴
              </Link>
              <Link to="/report" className="pill-link">
                運行日報
              </Link>
            </div>
          </div>
          <div className="start-hero__panel">
            <div className="start-hero__title">運行開始</div>
            <div className="start-hero__subtitle">出発前にODOを入力して運行を開始します。</div>
          </div>
          <div className="start-hero__panel">
            <div className="start-hero__title">運行開始</div>
            <div className="start-hero__subtitle">虎のように鋭く、今日の運行を記録します。</div>
            <div className="start-hero__actions">
              <BigButton
                label={loading ? '読み込み中…' : '運行開始'}
                disabled={loading}
                onClick={() => {
                  setOdoDialog({ kind: 'trip_start' });
                }}
              />
            </div>
          </div>
          {isNative && (
            <div className="start-hero__panel">
              <div style={{ fontSize: 24, fontWeight: 900, marginBottom: 8 }}>音声コマンド</div>
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
  return (
    <div className="home-backdrop">
      <div className="home-shell">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 900 }}>運行中</div>
          <div style={{ opacity: 0.85, fontSize: 13 }}>
            開始時刻: {tripStart?.ts ? new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(tripStart.ts)) : '-'} / 開始ODO: {tripStartOdo ?? '-'} km
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {isNative && (
            <button className="pill-link" onClick={() => setNativeSettingsOpen(true)} aria-label="ネイティブ設定">
              ⚙
            </button>
          )}
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
          {expresswayActive && expresswayStart && (
            <div style={{ padding: '8px 10px', borderRadius: 10, background: '#0ea5e9', color: '#fff', fontWeight: 800, fontSize: 12 }}>
              高速走行中 {fmtDuration(now - new Date(expresswayStart.ts).getTime())}
            </div>
          )}
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
      {wakeLockError && <div style={{ color: '#fca5a5', marginBottom: 8 }}>{wakeLockError}</div>}
      {routeTrackingError && <div style={{ color: '#fca5a5', marginBottom: 8 }}>{routeTrackingError}</div>}
      <div className="home-grid">
        <div className="home-primary">
          <div className="card" style={{ color: '#fff', padding: 12, borderRadius: 14 }}>
            <div style={{ fontWeight: 900, marginBottom: 6 }}>進行中のイベント</div>
            <div style={{ display: 'grid', gap: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800 }}>
                <span>運行</span>
                <span>{tripElapsed != null ? fmtDuration(tripElapsed) : '-'}</span>
              </div>
              {restStart && (
                <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.9 }}>
                  <span>休息</span>
                  <span>{fmtDuration(now - new Date(restStart.ts).getTime())}</span>
                </div>
              )}
              {loadStart && (
                <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.9 }}>
                  <span>積込</span>
                  <span>{fmtDuration(now - new Date(loadStart.ts).getTime())}</span>
                </div>
              )}
              {unloadStart && (
                <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.9 }}>
                  <span>荷卸</span>
                  <span>{fmtDuration(now - new Date(unloadStart.ts).getTime())}</span>
                </div>
              )}
              {breakStart && (
                <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.9 }}>
                  <span>休憩</span>
                  <span>{fmtDuration(now - new Date(breakStart.ts).getTime())}</span>
                </div>
              )}
              {!restStart && !loadStart && !unloadStart && !breakStart && (
                <div style={{ opacity: 0.8 }}>進行中のイベントはありません</div>
              )}
            </div>
          </div>
          <div className="card" style={{ color: '#fff', padding: 12, borderRadius: 14 }}>
            <div style={{ fontWeight: 900, marginBottom: 6 }}>現在地</div>
            {geoStatus ? (
              <div style={{ display: 'grid', gap: 4, fontSize: 14 }}>
                <div>緯度: {geoStatus.lat.toFixed(5)}</div>
                <div>経度: {geoStatus.lng.toFixed(5)}</div>
                {geoStatus.accuracy != null && <div>精度: ±{Math.round(geoStatus.accuracy)}m</div>}
                {geoStatus.address && <div>住所: {geoStatus.address}</div>}
                <div style={{ opacity: 0.8 }}>取得時刻: {new Date(geoStatus.at).toLocaleString('ja-JP')}</div>
              </div>
            ) : (
              <div style={{ opacity: 0.8, marginBottom: 4 }}>未取得</div>
            )}
            {geoError && <div style={{ color: '#fca5a5', marginTop: 6 }}>{geoError}</div>}
            <button
              onClick={captureGeoOnce}
              style={{
                marginTop: 8,
                width: '100%',
                height: 40,
                borderRadius: 10,
                border: '1px solid #374151',
                background: '#1f2937',
                color: '#fff',
                fontWeight: 800,
              }}
            >
              位置情報を更新
            </button>
          </div>
          {isNative && (
            <div className="card" style={{ color: '#fff', padding: 12, borderRadius: 14 }}>
              <div style={{ fontWeight: 900, marginBottom: 6 }}>音声コマンド</div>
              <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 8 }}>
                例: 「積込開始」「荷卸終了」「高速道路開始」「高速道路終了」
              </div>
              <button
                onClick={() => void runVoiceCommand()}
                disabled={voiceListening || !voiceAvailable}
                style={{
                  width: '100%',
                  height: 42,
                  borderRadius: 12,
                  border: '1px solid #334155',
                  background: voiceListening ? '#1f2937' : '#0ea5e9',
                  color: '#fff',
                  fontWeight: 800,
                  opacity: voiceAvailable ? 1 : 0.6,
                }}
              >
                {voiceListening ? '聞き取り中…' : '音声で操作する'}
              </button>
              {voiceLastText && (
                <div style={{ marginTop: 8, fontSize: 13, opacity: 0.85 }}>
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
          {nativeSettingsDialog}
        </div>
        <div className="home-actions">
          {/* End trip */}
          <BigButton label="運行終了" variant="danger" onClick={() => setOdoDialog({ kind: 'trip_end' })} />
          {/* Load (積込) */}
          {loadActive ? (
            <BigButton
              label="積込終了"
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
              disabled={!canStartRest}
              onClick={() => {
                setOdoDialog({ kind: 'rest_start' });
              }}
            />
          )}
          {/* Fuel (給油) */}
          <BigButton
            label="給油（数量）"
            onClick={() => {
              setFuelOpen(true);
            }}
          />
          {/* Expressway (高速道路) */}
          {expresswayActive ? (
            <BigButton
              label="高速道路終了"
              variant="neutral"
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
              onClick={async () => {
                try {
                  const { geo, address } = await getGeoWithAddress();
                  const { eventId } = await startExpressway({ tripId, geo, address });
                  await clearPendingExpresswayEndDecision(tripId);
                  await cancelNativeExpresswayEndPrompt(tripId);
                  // 即時にIC名を取得して表示を早める（オンライン時のみ）
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
          {/* Boarding (乗船) */}
          <BigButton
            label="乗船記録"
            onClick={async () => {
              try {
                const { geo, address } = await getGeoWithAddress();
                await addBoarding({ tripId, geo, address });
                await refresh();
              } catch (e: any) {
                alert(e?.message ?? '乗船の記録に失敗しました');
              }
            }}
          />
          <BigButton
            label="地点マーク"
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
    </div>
  );
}
