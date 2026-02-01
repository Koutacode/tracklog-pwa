import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import BigButton from '../components/BigButton';
import OdoDialog from '../components/OdoDialog';
import FuelDialog from '../components/FuelDialog';
import InstallButton from '../components/InstallButton';
import { getGeo, getGeoWithAddress } from '../../services/geo';
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
  startExpressway,
  endExpressway,
  deleteEvent,
  updateExpresswayResolved,
  backfillMissingAddresses,
  getAutoExpresswayConfig,
  setAutoExpresswayConfig,
  DEFAULT_AUTO_EXPRESSWAY_CONFIG,
} from '../../db/repositories';
import type { AutoExpresswayConfig } from '../../db/repositories';
import type { AppEvent } from '../../domain/types';
import { resolveNearestIC } from '../../services/icResolver';

function fmtDuration(ms: number) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

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
  const [fullscreenOn, setFullscreenOn] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [autoExpresswayConfig, setAutoExpresswayConfigState] = useState<AutoExpresswayConfig>(DEFAULT_AUTO_EXPRESSWAY_CONFIG);
  const [autoExpresswaySettingsOpen, setAutoExpresswaySettingsOpen] = useState(false);
  const [autoExpresswaySettingsError, setAutoExpresswaySettingsError] = useState<string | null>(null);
  const [autoExpresswayDraft, setAutoExpresswayDraft] = useState({
    speedKmh: String(DEFAULT_AUTO_EXPRESSWAY_CONFIG.speedKmh),
    durationSec: String(DEFAULT_AUTO_EXPRESSWAY_CONFIG.durationSec),
  });
  const [autoExpresswayToast, setAutoExpresswayToast] = useState<null | { eventId: string; speedKmh: number }>(null);
  const breakReminderTimer = useRef<number | null>(null);
  const fullscreenAttempted = useRef(false);
  const speedWatchId = useRef<number | null>(null);
  const autoExpresswayInFlight = useRef(false);
  const lastAutoExpresswayAt = useRef<number | null>(null);
  const speedAboveSince = useRef<number | null>(null);
  const autoExpresswayToastTimer = useRef<number | null>(null);

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

  function showAutoExpresswayToast(eventId: string, speedKmh: number) {
    if (autoExpresswayToastTimer.current != null) {
      window.clearTimeout(autoExpresswayToastTimer.current);
    }
    setAutoExpresswayToast({ eventId, speedKmh });
    autoExpresswayToastTimer.current = window.setTimeout(() => {
      dismissAutoExpresswayToast();
    }, 3000);
  }

  function dismissAutoExpresswayToast() {
    if (autoExpresswayToastTimer.current != null) {
      window.clearTimeout(autoExpresswayToastTimer.current);
      autoExpresswayToastTimer.current = null;
    }
    setAutoExpresswayToast(null);
  }

  async function cancelAutoExpressway(eventId: string) {
    dismissAutoExpresswayToast();
    try {
      await deleteEvent(eventId);
      await refresh();
    } catch (e: any) {
      alert(e?.message ?? '自動開始の取り消しに失敗しました');
    }
  }

  function openAutoExpresswaySettings() {
    setAutoExpresswaySettingsError(null);
    setAutoExpresswayDraft({
      speedKmh: String(autoExpresswayConfig.speedKmh),
      durationSec: String(autoExpresswayConfig.durationSec),
    });
    setAutoExpresswaySettingsOpen(true);
  }

  async function saveAutoExpresswaySettings() {
    const speed = Number(autoExpresswayDraft.speedKmh);
    const duration = Number(autoExpresswayDraft.durationSec);
    if (!Number.isFinite(speed) || speed < 30 || speed > 160) {
      setAutoExpresswaySettingsError('開始速度は30〜160km/hの範囲で入力してください。');
      return;
    }
    if (!Number.isFinite(duration) || duration < 1 || duration > 60) {
      setAutoExpresswaySettingsError('継続時間は1〜60秒の範囲で入力してください。');
      return;
    }
    const saved = await setAutoExpresswayConfig({ speedKmh: Math.round(speed), durationSec: Math.round(duration) });
    setAutoExpresswayConfigState(saved);
    setAutoExpresswaySettingsOpen(false);
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

  // Speed watcher for高速道路の自動記録（一定速度を一定時間キープで開始）
  useEffect(() => {
    if (!tripId || !navigator.geolocation) return;
    if (speedWatchId.current != null) {
      navigator.geolocation.clearWatch(speedWatchId.current);
      speedWatchId.current = null;
    }
    const tripIdForWatch = tripId;
    const thresholdKmh = autoExpresswayConfig.speedKmh;
    const durationMs = autoExpresswayConfig.durationSec * 1000;
    speedAboveSince.current = null;
    const id = navigator.geolocation.watchPosition(
      pos => {
        const spd = pos.coords.speed; // m/s
        const nowMs = pos.timestamp ? pos.timestamp : Date.now();
        if (spd == null || Number.isNaN(spd)) {
          speedAboveSince.current = null;
          return;
        }
        const kmh = spd * 3.6;
        if (kmh < thresholdKmh) {
          speedAboveSince.current = null;
          return;
        }
        if (speedAboveSince.current == null) {
          speedAboveSince.current = nowMs;
        }
        if (expresswayActive) return;
        const last = lastAutoExpresswayAt.current ?? 0;
        if (autoExpresswayInFlight.current || nowMs - last < 60 * 1000) return;
        if (nowMs - speedAboveSince.current < durationMs) return;

        autoExpresswayInFlight.current = true;
        lastAutoExpresswayAt.current = nowMs;
        const geo = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        };
        void (async () => {
          try {
            const { eventId } = await startExpressway({ tripId: tripIdForWatch, geo });
            showAutoExpresswayToast(eventId, Math.round(kmh));
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
          } catch {
            // ignore auto-start errors
          } finally {
            autoExpresswayInFlight.current = false;
          }
        })();
      },
      () => {
        // ignore errors
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 3000 },
    );
    speedWatchId.current = id;
    return () => {
      if (id != null) navigator.geolocation.clearWatch(id);
      speedWatchId.current = null;
      speedAboveSince.current = null;
      autoExpresswayInFlight.current = false;
    };
  }, [tripId, expresswayActive, autoExpresswayConfig.speedKmh, autoExpresswayConfig.durationSec]);

  useEffect(() => {
    refresh();
    void (async () => {
      const config = await getAutoExpresswayConfig();
      setAutoExpresswayConfigState(config);
      setAutoExpresswayDraft({
        speedKmh: String(config.speedKmh),
        durationSec: String(config.durationSec),
      });
    })();
    setWakeLockAvailable(isWakeLockSupported());
    setFullscreenSupported(
      typeof document !== 'undefined' &&
        !!(document.fullscreenEnabled || (document as any).webkitFullscreenEnabled),
    );
  }, []);

  useEffect(() => {
    const handler = () => {
      const fs = !!(document.fullscreenElement || (document as any).webkitFullscreenElement);
      setFullscreenOn(fs);
    };
    document.addEventListener('fullscreenchange', handler);
    document.addEventListener('webkitfullscreenchange', handler as any);
    return () => {
      document.removeEventListener('fullscreenchange', handler);
      document.removeEventListener('webkitfullscreenchange', handler as any);
    };
  }, []);

  // Try to enter fullscreen on firstユーザー操作（仕様上ジェスチャーが必要なため）
  useEffect(() => {
    if (!fullscreenSupported) return;
    const handler = () => {
      if (fullscreenAttempted.current) return;
      fullscreenAttempted.current = true;
      void enterFullscreen();
    };
    window.addEventListener('pointerdown', handler, { once: true, capture: true });
    return () => window.removeEventListener('pointerdown', handler, true as any);
  }, [fullscreenSupported]);

  async function enterFullscreen() {
    try {
      const el = document.documentElement as any;
      if (el.requestFullscreen) {
        await el.requestFullscreen();
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
      }
      fullscreenAttempted.current = true;
    } catch (e: any) {
      setGeoError(e?.message ?? '全画面表示に失敗しました');
    }
  }

  async function exitFullscreen() {
    try {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if ((document as any).webkitExitFullscreen) {
        await (document as any).webkitExitFullscreen();
      }
    } catch {
      // ignore
    }
  }

  function ensureFullscreen() {
    if (!fullscreenSupported) return;
    if (!fullscreenOn) {
      void enterFullscreen();
    }
  }

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
    if (!tripId) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [tripId]);

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

    const options: NotificationOptions = {
      body: '休憩開始から30分経過しました',
      vibrate: [200, 100, 200],
      requireInteraction: true,
      tag: 'tracklog-break-30min',
      renotify: true,
    };

    try {
      const reg = await navigator.serviceWorker?.ready;
      if (reg?.showNotification) {
        await reg.showNotification('休憩30分経過', options);
      } else {
        new Notification('休憩30分経過', options);
      }
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

  const autoExpresswayToastView = autoExpresswayToast ? (
    <div className="auto-expressway-overlay" onClick={dismissAutoExpresswayToast}>
      <div className="auto-expressway-card" onClick={e => e.stopPropagation()}>
        <div className="auto-expressway-title">高速道路を自動で開始しました</div>
        <div className="auto-expressway-speed">{autoExpresswayToast.speedKmh} km/h</div>
        <div className="auto-expressway-note">誤検知のときは取り消してください。</div>
        <div className="auto-expressway-actions">
          <button
            className="trip-detail__button trip-detail__button--danger"
            onClick={() => cancelAutoExpressway(autoExpresswayToast.eventId)}
          >
            取り消す
          </button>
          <button className="trip-detail__button" onClick={dismissAutoExpresswayToast}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  ) : null;

  const autoExpresswaySettingsDialog = autoExpresswaySettingsOpen ? (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.6)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 10000,
      }}
    >
      <div style={{ width: 'min(520px, 92vw)', background: '#111', color: '#fff', borderRadius: 16, padding: 16 }}>
        <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 6 }}>高速自動開始設定</div>
        <div style={{ opacity: 0.8, fontSize: 13, marginBottom: 12 }}>
          指定速度が指定秒数続いたら、自動で高速道路の開始を記録します。
        </div>
        <div style={{ display: 'grid', gap: 12 }}>
          <label style={{ display: 'grid', gap: 6 }}>
            開始速度（km/h）
            <input
              type="number"
              min={30}
              max={160}
              value={autoExpresswayDraft.speedKmh}
              onChange={e => setAutoExpresswayDraft(prev => ({ ...prev, speedKmh: e.target.value }))}
              style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid #334155', background: '#0f172a', color: '#fff' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 6 }}>
            継続時間（秒）
            <input
              type="number"
              min={1}
              max={60}
              value={autoExpresswayDraft.durationSec}
              onChange={e => setAutoExpresswayDraft(prev => ({ ...prev, durationSec: e.target.value }))}
              style={{ padding: '10px 12px', borderRadius: 10, border: '1px solid #334155', background: '#0f172a', color: '#fff' }}
            />
          </label>
          {autoExpresswaySettingsError && (
            <div style={{ color: '#fca5a5', fontSize: 13 }}>{autoExpresswaySettingsError}</div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button
            onClick={() => setAutoExpresswaySettingsOpen(false)}
            style={{ padding: '10px 14px', borderRadius: 12 }}
          >
            閉じる
          </button>
          <button onClick={saveAutoExpresswaySettings} style={{ padding: '10px 14px', borderRadius: 12, fontWeight: 800 }}>
            保存
          </button>
        </div>
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
                <div className="start-hero__brand-name">TrackLog</div>
                <div className="start-hero__brand-sub">運行記録</div>
              </div>
            </div>
            <div className="start-hero__nav-actions">
              {fullscreenSupported && (
                <button
                  className="pill-link"
                  style={{ background: fullscreenOn ? '#22c55e' : undefined, color: fullscreenOn ? '#fff' : undefined }}
                  onClick={() => {
                    if (fullscreenOn) {
                      void exitFullscreen();
                    } else {
                      void enterFullscreen();
                    }
                  }}
                >
                  全画面表示
                </button>
              )}
              <button className="pill-link" onClick={openAutoExpresswaySettings}>
                高速自動開始
              </button>
              <Link to="/history" className="pill-link">
                運行履歴
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
                  ensureFullscreen();
                  setOdoDialog({ kind: 'trip_start' });
                }}
              />
              <InstallButton />
            </div>
          </div>
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
                ensureFullscreen();
                const geo = await getGeo();
                const { tripId: newTripId } = await startTrip({ odoKm, geo });
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
        {autoExpresswaySettingsDialog}
        {autoExpresswayToastView}
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
          <Link to={`/trip/${tripId}`} className="pill-link">
            運行詳細
          </Link>
          <button className="pill-link" onClick={openAutoExpresswaySettings}>
            高速自動開始
          </button>
          <Link to="/history" className="pill-link">
            運行履歴
          </Link>
          {expresswayActive && expresswayStart && (
            <div style={{ padding: '8px 10px', borderRadius: 10, background: '#0ea5e9', color: '#fff', fontWeight: 800, fontSize: 12 }}>
              高速走行中 {fmtDuration(now - new Date(expresswayStart.ts).getTime())}
            </div>
          )}
          {fullscreenSupported && (
            <button
              className="pill-link"
              style={{ background: fullscreenOn ? '#22c55e' : undefined, color: fullscreenOn ? '#fff' : undefined }}
              onClick={() => {
                if (fullscreenOn) {
                  void exitFullscreen();
                } else {
                  void enterFullscreen();
                }
              }}
            >
              全画面表示
            </button>
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
                  ensureFullscreen();
                  const geo = await getGeo();
                  await endLoad({ tripId, geo });
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
                  ensureFullscreen();
                  const geo = await getGeo();
                  await startLoad({ tripId, geo });
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
                  ensureFullscreen();
                  const geo = await getGeo();
                  await endUnload({ tripId, geo });
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
                  ensureFullscreen();
                  const geo = await getGeo();
                  await startUnload({ tripId, geo });
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
                  ensureFullscreen();
                  const geo = await getGeo();
                  await endBreak({ tripId, geo });
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
                  ensureFullscreen();
                  const geo = await getGeo();
                  await startBreak({ tripId, geo });
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
                  ensureFullscreen();
                  const geo = await getGeo();
                  await endRest({ tripId, restSessionId: openRestSessionId, dayClose: false, geo });
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
                ensureFullscreen();
                setOdoDialog({ kind: 'rest_start' });
              }}
            />
          )}
          {/* Fuel (給油) */}
          <BigButton
            label="給油（数量）"
            onClick={() => {
              ensureFullscreen();
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
                  ensureFullscreen();
                  const geo = await getGeo();
                  await endExpressway({ tripId, geo });
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
                  ensureFullscreen();
                  const geo = await getGeo();
                  const { eventId } = await startExpressway({ tripId, geo });
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
                ensureFullscreen();
                const geo = await getGeo();
                await addBoarding({ tripId, geo });
                await refresh();
              } catch (e: any) {
                alert(e?.message ?? '乗船の記録に失敗しました');
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
            const geo = await getGeo();
            await addRefuel({ tripId, liters, geo });
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
            ensureFullscreen();
            const geo = await getGeo();
            // 直近チェックポイント（運行開始 or 直前の休息開始）との差を計算して通知する
            const lastCheckpointOdo = (() => {
              const checkpoints = events
                .filter(e => e.type === 'trip_start' || e.type === 'rest_start')
                .sort((a, b) => a.ts.localeCompare(b.ts));
              const last = checkpoints[checkpoints.length - 1] as any;
              return last?.extras?.odoKm as number | undefined;
            })();
            const diffKm = lastCheckpointOdo != null ? odoKm - lastCheckpointOdo : undefined;

            await startRest({ tripId, odoKm, geo });
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
              ensureFullscreen();
              const geo = await getGeo();
              const { event } = await endTrip({ tripId, odoEndKm, geo });
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
      {autoExpresswaySettingsDialog}
      {autoExpresswayToastView}
      </div>
    </div>
  );
}
