import { useState, useEffect, useMemo } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import type { Trip, DayRecord, DayMetrics, JobInfo, TimeSegmentDetail } from '../../domain/reportTypes';
import {
  buildReportTripFromAppEvents,
  parseJsonToTrip,
  computeTripDayMetrics,
  computeMonthSummary,
  formatMinutes,
  formatMinutesShort,
  formatRoundedJstTime,
} from '../../domain/reportLogic';
import {
  saveReportTrip,
  listReportTrips,
  deleteReportTrip,
} from '../../db/reportRepository';
import { getEventsByTripId, restoreSnapshotJson, uuid } from '../../db/repositories';
import { buildTripViewModel } from '../../state/selectors';

// --- Status colors ---
const STATUS_COLORS: Record<string, string> = {
  drive: '#22c55e',
  load1: '#3b82f6',
  load2: '#60a5fa',
  unload: '#a78bfa',
  break: '#f59e0b',
  rest: '#ef4444',
  wait: '#64748b',
  work: '#14b8a6',
};

// --- Main tabs ---
type MainTab = 'list' | 'new' | 'report' | 'monthly';
const MAIN_TABS: { key: MainTab; label: string; icon: string }[] = [
  { key: 'list', label: '運行一覧', icon: '\u{1F3E0}' },
  { key: 'new', label: '新規登録', icon: '\u{2795}' },
  { key: 'report', label: '日報', icon: '\u{1F4CA}' },
  { key: 'monthly', label: '月次集計', icon: '\u{1F4C8}' },
];

// --- Report sub-tabs ---
type ReportSubTab = 'daily' | 'jobs' | 'timeline';

type ReportLocationState = {
  initialReportTrip?: Trip;
};

function upsertTrip(trips: Trip[], nextTrip: Trip): Trip[] {
  const remaining = trips.filter(trip => trip.id !== nextTrip.id);
  return [nextTrip, ...remaining];
}

export default function ReportDashboard() {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [mainTab, setMainTab] = useState<MainTab>('list');
  const [trips, setTrips] = useState<Trip[]>([]);
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestedTripId = searchParams.get('tripId');
  const initialReportTrip = (location.state as ReportLocationState | null)?.initialReportTrip ?? null;

  async function loadTrips() {
    try {
      const list = await listReportTrips();
      setTrips(initialReportTrip ? upsertTrip(list, initialReportTrip) : list);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load trips');
    }
  }

  useEffect(() => { void loadTrips(); }, []);
  useEffect(() => {
    if (!initialReportTrip) return;
    setTrips(prev => upsertTrip(prev, initialReportTrip));
    setSelectedTripId(initialReportTrip.id);
    setMainTab('report');
    setError(null);
  }, [initialReportTrip]);
  useEffect(() => {
    if (!requestedTripId) return;
    setSelectedTripId(requestedTripId);
    setMainTab('report');
  }, [requestedTripId]);

  const selectedTrip = useMemo(
    () => trips.find(t => t.id === selectedTripId) ?? null,
    [trips, selectedTripId]
  );
  const totalDays = useMemo(() => trips.reduce((sum, trip) => sum + trip.days.length, 0), [trips]);
  const activeMonths = useMemo(() => {
    const months = new Set<string>();
    for (const trip of trips) {
      for (const day of trip.days) {
        months.add(day.dateKey.slice(0, 7));
      }
    }
    return months.size;
  }, [trips]);

  function selectTrip(tripId: string) {
    const next = new URLSearchParams(searchParams);
    next.set('tripId', tripId);
    setSearchParams(next, { replace: true });
    setSelectedTripId(tripId);
  }

  function openTrip(tripId: string) {
    selectTrip(tripId);
    setMainTab('report');
  }

  async function refreshTripFromLive(tripId: string) {
    const liveEvents = await getEventsByTripId(tripId);
    if (liveEvents.length === 0) {
      throw new Error('元の運行データが見つかりません。運行詳細から再作成してください。');
    }
    const liveVm = buildTripViewModel(tripId, liveEvents);
    const currentLabel = trips.find(item => item.id === tripId)?.label;
    const nextTrip = buildReportTripFromAppEvents({
      tripId,
      events: liveEvents,
      dayRuns: liveVm.dayRuns,
      label: currentLabel,
    });
    await saveReportTrip(nextTrip);
    await loadTrips();
    selectTrip(tripId);
    setMainTab('report');
    setError(null);
  }

  return (
    <div className="report-backdrop">
      <div className="report-shell">
        {/* Header */}
        <div className="report-header">
          <div>
            <div className="report-header__eyebrow">日報・月次管理</div>
            <div className="report-header__title">運行日報</div>
          </div>
          <div className="report-header__actions">
            <div className="report-header__chips">
              <span className="report-header__chip">運行 {trips.length}件</span>
              <span className="report-header__chip">日数 {totalDays}日</span>
              <span className="report-header__chip">対象月 {activeMonths}件</span>
            </div>
            <Link to="/" className="pill-link">ホーム</Link>
          </div>
        </div>

        {/* Tab bar */}
        <div className="report-tabs">
          {MAIN_TABS.map(t => (
            <button
              key={t.key}
              className={`report-tab ${mainTab === t.key ? 'report-tab--active' : ''}`}
              onClick={() => setMainTab(t.key)}
            >
              <span className="report-tab__icon">{t.icon}</span>
              <span className="report-tab__label">{t.label}</span>
            </button>
          ))}
        </div>

        {error && <div className="report-alert report-alert--danger">{error}</div>}

        {/* Tab content */}
        {mainTab === 'list' && (
          <TripListTab trips={trips} onOpen={openTrip} onReload={loadTrips} />
        )}
        {mainTab === 'new' && (
          <NewTripTab onSaved={(trip) => {
            void loadTrips().then(() => {
              openTrip(trip.id);
            });
          }} />
        )}
        {mainTab === 'report' && (
          <ReportTab
            trip={selectedTrip}
            trips={trips}
            requestedTripId={requestedTripId}
            onSelectTrip={selectTrip}
            onRefreshLiveTrip={refreshTripFromLive}
          />
        )}
        {mainTab === 'monthly' && (
          <MonthlyTab trips={trips} />
        )}
      </div>
    </div>
  );
}

// =============================================
// Tab: Trip List
// =============================================
function TripListTab({ trips, onOpen, onReload }: {
  trips: Trip[];
  onOpen: (id: string) => void;
  onReload: () => Promise<void>;
}) {
  async function handleDelete(id: string) {
    if (!window.confirm('この運行を削除しますか？')) return;
    try {
      await deleteReportTrip(id);
      await onReload();
    } catch {
      // ignore
    }
  }

  if (trips.length === 0) {
    return (
      <div className="report-card" style={{ textAlign: 'center', padding: 32 }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>{'\u{1F69A}'}</div>
        <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 8 }}>まだ運行がありません</div>
        <div style={{ color: 'var(--muted)', fontSize: 14 }}>「新規登録」タブからJSONを登録してください</div>
      </div>
    );
  }

  return (
    <div className="report-list">
      {trips.map(trip => (
        <div key={trip.id} className="report-card report-trip-card" onClick={() => onOpen(trip.id)}>
          <div className="report-trip-card__row">
            <div className="report-trip-card__label">{trip.label || '無題の運行'}</div>
            <div className="report-trip-card__date">
              {trip.days.length > 0 ? trip.days[0].dateKey : '-'}
            </div>
          </div>
          <div className="report-trip-card__meta">
            <span>{trip.days.length}日間</span>
            <span>{trip.jobs.length}案件</span>
            <span>#{trip.id.slice(0, 8)}</span>
          </div>
          <div className="report-trip-card__summary">
            <span>最初の日付</span>
            <strong>{trip.days[0]?.dateKey ?? '-'}</strong>
          </div>
          <div className="report-trip-card__actions">
            <button
              className="report-btn report-btn--danger report-btn--small"
              onClick={(e) => { e.stopPropagation(); void handleDelete(trip.id); }}
            >
              削除
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// =============================================
// Tab: New Trip Registration
// =============================================
function NewTripTab({ onSaved }: { onSaved: (trip: Trip) => void }) {
  const [jsonText, setJsonText] = useState('');
  const [label, setLabel] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    setParseError(null);
    setRestoreMessage(null);
    if (!jsonText.trim()) {
      setParseError('JSONを入力してください');
      return;
    }
    try {
      const tripId = uuid();
      const trip = parseJsonToTrip(jsonText.trim(), tripId);
      if (label.trim()) trip.label = label.trim();
      setSaving(true);
      await saveReportTrip(trip);
      setSaving(false);
      setJsonText('');
      setLabel('');
      onSaved(trip);
    } catch (e: any) {
      setSaving(false);
      setParseError(e?.message ?? 'JSONのパースに失敗しました');
    }
  }

  async function handleRestore() {
    setParseError(null);
    setRestoreMessage(null);
    if (!jsonText.trim()) {
      setParseError('JSONを入力してください');
      return;
    }
    if (!window.confirm('この JSON から現行運行を復元します。未終了の運行があればアクティブ状態として戻します。続けますか？')) {
      return;
    }
    try {
      setSaving(true);
      const result = await restoreSnapshotJson(jsonText.trim());
      setSaving(false);
      setRestoreMessage(
        result.activeTripId
          ? `復元しました。${result.importedEvents}件のイベントを戻し、未終了の運行をアクティブにしました。ホームで確認してください。`
          : `復元しました。${result.importedEvents}件のイベントを戻しました。`
      );
    } catch (e: any) {
      setSaving(false);
      setParseError(e?.message ?? 'JSON からの復元に失敗しました');
    }
  }

  return (
    <div className="report-card" style={{ padding: 20 }}>
      <div className="report-section-title">運行JSONを貼り付け</div>
      <div style={{ marginBottom: 12 }}>
        <label className="report-label">ラベル（任意）</label>
        <input
          type="text"
          className="report-input"
          placeholder="例：東京→大阪 配送"
          value={label}
          onChange={e => setLabel(e.target.value)}
        />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label className="report-label">JSON</label>
        <textarea
          className="report-textarea"
          rows={12}
          placeholder={'{\n  "events": [...],\n  "dayRuns": [...],\n  "jobs": [...]\n}'}
          value={jsonText}
          onChange={e => setJsonText(e.target.value)}
        />
      </div>
      {parseError && <div className="report-alert report-alert--danger">{parseError}</div>}
      {restoreMessage && <div className="report-alert report-alert--success">{restoreMessage}</div>}
      <button
        className="report-btn report-btn--primary"
        onClick={() => void handleSubmit()}
        disabled={saving}
        style={{ width: '100%', marginTop: 8 }}
      >
        {saving ? '保存中...' : '登録する'}
      </button>
      <button
        className="report-btn"
        onClick={() => void handleRestore()}
        disabled={saving}
        style={{ width: '100%', marginTop: 10 }}
      >
        {saving ? '復元中...' : '現行運行へ復元する'}
      </button>
      <div className="report-section-caption" style={{ marginTop: 10 }}>
        `登録する` は `events` / `dayRuns` / `operation_log` に対応します。`運行履歴データ:` 付きの共有テキストもそのまま貼り付け可能です。`現行運行へ復元する` は `events` 付きスナップショットか `operation_log` を受け付けます。
      </div>
    </div>
  );
}

// =============================================
// Tab: Daily Report
// =============================================
function ReportTab({ trip, trips, requestedTripId, onSelectTrip, onRefreshLiveTrip }: {
  trip: Trip | null;
  trips: Trip[];
  requestedTripId: string | null;
  onSelectTrip: (id: string) => void;
  onRefreshLiveTrip: (id: string) => Promise<void>;
}) {
  const [subTab, setSubTab] = useState<ReportSubTab>('daily');
  const [dayIdx, setDayIdx] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useEffect(() => { setDayIdx(0); }, [trip?.id]);

  if (!trip) {
    return (
      <div className="report-card" style={{ textAlign: 'center', padding: 32 }}>
        <div style={{ fontSize: 36, marginBottom: 8 }}>{'\u{1F4CB}'}</div>
        <div style={{ fontWeight: 800, marginBottom: 12 }}>
          {requestedTripId ? '日報を読み込み中です' : '運行を選択してください'}
        </div>
        {requestedTripId && (
          <div style={{ color: 'var(--muted)', fontSize: 14, marginBottom: 12 }}>
            保存した日報を開いています。数秒待っても切り替わらない場合は「最新状態へ更新」を試してください。
          </div>
        )}
        <select
          className="report-select"
          value=""
          onChange={e => { if (e.target.value) onSelectTrip(e.target.value); }}
        >
          <option value="">-- 選択 --</option>
          {trips.map(t => (
            <option key={t.id} value={t.id}>
              {t.label || t.days[0]?.dateKey || t.id.slice(0, 8)}
            </option>
          ))}
        </select>
      </div>
    );
  }

  const day = trip.days[dayIdx];
  const metricsList = useMemo(() => computeTripDayMetrics(trip), [trip]);
  const metrics = metricsList[dayIdx];
  if (!day) return null;
  if (!metrics) return null;

  const subTabs: { key: ReportSubTab; label: string; icon: string }[] = [
    { key: 'daily', label: '日報', icon: '\u{1F4CA}' },
    { key: 'jobs', label: '案件', icon: '\u{1F4CB}' },
    { key: 'timeline', label: 'TL', icon: '\u{1F552}' },
  ];

  return (
    <div>
      <div className="report-card report-trip-summary">
        <div className="report-trip-summary__eyebrow">選択中の運行</div>
        <div className="report-trip-summary__title">{trip.label || day.dateKey}</div>
        <div className="report-trip-summary__meta">
          <span>{trip.days.length}日構成</span>
          <span>{trip.jobs.length}案件</span>
          <span>#{trip.id.slice(0, 8)}</span>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
          <button
            className="report-btn report-btn--primary"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true);
              setRefreshError(null);
              void onRefreshLiveTrip(trip.id)
                .catch((error: any) => {
                  setRefreshError(error?.message ?? '最新状態への更新に失敗しました');
                })
                .finally(() => setRefreshing(false));
            }}
          >
            {refreshing ? '更新中...' : '最新状態へ更新'}
          </button>
        </div>
        {refreshError && (
          <div className="report-alert report-alert--danger" style={{ marginTop: 12 }}>
            {refreshError}
          </div>
        )}
      </div>
      {/* Trip selector + Day selector */}
      <div className="report-selectors">
        <select
          className="report-select"
          value={trip.id}
          onChange={e => onSelectTrip(e.target.value)}
        >
          {trips.map(t => (
            <option key={t.id} value={t.id}>
              {t.label || t.days[0]?.dateKey || t.id.slice(0, 8)}
            </option>
          ))}
        </select>
        {trip.days.length > 1 && (
          <div className="report-day-pills">
            {trip.days.map((d, idx) => (
              <button
                key={d.dayIndex}
                className={`report-day-pill ${idx === dayIdx ? 'report-day-pill--active' : ''}`}
                onClick={() => setDayIdx(idx)}
              >
                {d.dayIndex}日目
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Sub tabs */}
      <div className="report-sub-tabs">
        {subTabs.map(st => (
          <button
            key={st.key}
            className={`report-sub-tab ${subTab === st.key ? 'report-sub-tab--active' : ''}`}
            onClick={() => setSubTab(st.key)}
          >
            <span>{st.icon}</span> {st.label}
          </button>
        ))}
      </div>

      {subTab === 'daily' && <DailyView day={day} metrics={metrics} />}
      {subTab === 'jobs' && <JobsView jobs={trip.jobs} />}
      {subTab === 'timeline' && <TimelineView day={day} />}
    </div>
  );
}

// =============================================
// Sub-view: Daily Report (metrics cards)
// =============================================
function DailyView({ day, metrics }: { day: DayRecord; metrics: DayMetrics }) {
  const businessMinutes = getBusinessMinutes(metrics);
  const totalMinutes = metrics.driveMinutes
    + businessMinutes
    + metrics.breakMinutes
    + metrics.ferryMinutes
    + metrics.restMinutes;

  return (
    <div className="report-daily">
      {/* Date header */}
      <div className="report-date-header">
        <span className="report-date-header__day">{day.dayIndex}日目</span>
        <span className="report-date-header__date">{day.dateKey}</span>
        <span className="report-date-header__km">{day.km} km</span>
      </div>

      {/* Alerts */}
      {metrics.alerts.map((a, i) => (
        <div key={i} className={`report-alert report-alert--${a.level}`}>
          {a.level === 'danger' ? '\u{26A0}\u{FE0F}' : '\u{26A0}'} {a.message}
        </div>
      ))}

      {/* 3 Big Metric Cards */}
      <div className="report-section-caption">その日の拘束・実働・48時間運転余力を上段に集約しています。</div>
      <div className="report-big-cards">
        <ConstraintCard metrics={metrics} />
        <WorkloadCard metrics={metrics} />
        <RollingDriveCard metrics={metrics} />
      </div>

      <ComplianceCard metrics={metrics} />

      {/* Activity breakdown */}
      <div className="report-card" style={{ padding: 16 }}>
        <div className="report-section-title">項目別集計</div>
        <div className="report-section-caption" style={{ marginBottom: 12 }}>
          表示時刻と集計は 15 分単位に丸め、業務には積込・荷卸などを含めています。休息中のフェリーは別行として表示し、休息はフェリー前後のみを計上します。通常日は 1 日合計が 24:00 ですが、初日の運行開始前と最終日の運行終了後は集計しません。休息が日をまたぐ場合は、当日 00:00 以降の継続分を当日に計上します。
        </div>
        <div className="report-breakdown">
          <BreakdownRow label="運転" minutes={metrics.driveMinutes} color={STATUS_COLORS.drive} />
          <BreakdownRow label="業務" minutes={businessMinutes} color={STATUS_COLORS.work} />
          <BreakdownRow label="休憩" minutes={metrics.breakMinutes} color={STATUS_COLORS.break} />
          <BreakdownRow label="フェリー" minutes={metrics.ferryMinutes} color="#0f766e" />
          <BreakdownRow label="休息" minutes={metrics.restMinutes} color={STATUS_COLORS.rest} />
          <BreakdownTotalRow label="合計" minutes={totalMinutes} />
        </div>
      </div>

      {metrics.restSegments.length > 0 && (
        <div className="report-card" style={{ padding: 16 }}>
          <div className="report-section-title">休息内訳</div>
          <div className="report-section-caption" style={{ marginBottom: 12 }}>
            フェリー前後の休息のみを表示します。初日の運行開始前と最終日の運行終了後は含めず、日をまたぐ休息は当日 00:00 以降の継続分と当日開始分を分けて表示します。
          </div>
          {metrics.restSegments.map((segment, index) => (
            <RestSegmentCard key={`rest-${index}`} segment={segment} />
          ))}
        </div>
      )}

      {metrics.ferrySegments.length > 0 && (
        <div className="report-card" style={{ padding: 16 }}>
          <div className="report-section-title">フェリー区間</div>
          <div className="report-section-caption" style={{ marginBottom: 12 }}>
            乗船から下船までをフェリー区間として扱い、日報では休息と分けて表示します。法令判定ではフェリー特例候補に回しています。
          </div>
          {metrics.ferrySegments.map((segment, index) => (
            <FerrySegmentCard key={`ferry-${index}`} segment={segment} />
          ))}
        </div>
      )}

      {/* Load/Unload details */}
      {(metrics.loads.length > 0 || metrics.unloads.length > 0) && (
        <div className="report-card" style={{ padding: 16 }}>
          <div className="report-section-title">積込・荷卸 内訳</div>
          {metrics.loads.map((ld, i) => (
            <LoadCard key={`load-${i}`} detail={ld} type="load" index={i} />
          ))}
          {metrics.unloads.map((ld, i) => (
            <LoadCard key={`unload-${i}`} detail={ld} type="unload" index={i} />
          ))}
        </div>
      )}

      {/* Next day outlook */}
      <NextDayCard day={day} />
    </div>
  );
}

function getBusinessMinutes(metrics: DayMetrics) {
  return metrics.workMinutes + metrics.loadMinutes + metrics.unloadMinutes + metrics.waitMinutes;
}

// --- Constraint time card ---
function ConstraintCard({ metrics }: { metrics: DayMetrics }) {
  const pct = Math.min(100, (metrics.constraintMinutes / metrics.effectiveConstraintLimitMinutes) * 100);
  const barColor = metrics.constraintOverLimit ? '#ef4444' : '#38bdf8';

  return (
    <div className="report-metric-card">
      <div className="report-metric-card__header">
        <span className="report-metric-card__label">拘束時間</span>
        <span className="report-metric-card__limit">上限 {formatMinutesShort(metrics.effectiveConstraintLimitMinutes)}</span>
      </div>
      <div className="report-metric-card__value" style={{ color: metrics.constraintOverLimit ? '#ef4444' : '#e2e8f0' }}>
        {formatMinutesShort(metrics.constraintMinutes)}
      </div>
      <div className="report-bar">
        <div className="report-bar__fill" style={{ width: `${pct}%`, background: barColor }} />
        <div className="report-bar__marker" style={{ left: '100%' }} />
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
        原則 13:00 / 適用 {formatMinutesShort(metrics.effectiveConstraintLimitMinutes)}
      </div>
      {metrics.constraintOverLimit && <div className="report-metric-card__warning">上限超過</div>}
    </div>
  );
}

// --- Workload card ---
function WorkloadCard({ metrics }: { metrics: DayMetrics }) {
  const businessMinutes = getBusinessMinutes(metrics);
  const total = metrics.driveMinutes + businessMinutes;
  const drivePct = total > 0 ? (metrics.driveMinutes / total) * 100 : 0;
  const workPct = total > 0 ? (businessMinutes / total) * 100 : 0;

  return (
    <div className="report-metric-card">
      <div className="report-metric-card__header">
        <span className="report-metric-card__label">稼働時間</span>
      </div>
      <div className="report-metric-card__value">{formatMinutesShort(total)}</div>
      <div className="report-stacked-bar">
        {drivePct > 0 && (
          <div className="report-stacked-bar__seg" style={{ width: `${drivePct}%`, background: STATUS_COLORS.drive }} />
        )}
        {workPct > 0 && (
          <div className="report-stacked-bar__seg" style={{ width: `${workPct}%`, background: STATUS_COLORS.work }} />
        )}
      </div>
      <div className="report-legend">
        <span><span className="report-legend__dot" style={{ background: STATUS_COLORS.drive }} />運転 {formatMinutesShort(metrics.driveMinutes)}</span>
        <span><span className="report-legend__dot" style={{ background: STATUS_COLORS.work }} />業務 {formatMinutesShort(businessMinutes)}</span>
      </div>
    </div>
  );
}

// --- Drive remaining card ---
function RollingDriveCard({ metrics }: { metrics: DayMetrics }) {
  const limitMin = 18 * 60;
  const usedPct = Math.min(100, (metrics.rollingTwoDayDriveMinutes / limitMin) * 100);
  const over = metrics.driveOverLimit;

  return (
    <div className="report-metric-card">
      <div className="report-metric-card__header">
        <span className="report-metric-card__label">48時間残り運転</span>
        <span className="report-metric-card__limit">上限 18:00</span>
      </div>
      <div className="report-metric-card__value" style={{ color: over ? '#ef4444' : '#22c55e' }}>
        {formatMinutesShort(metrics.nextDriveRemaining)}
      </div>
      <div className="report-bar">
        <div className="report-bar__fill" style={{ width: `${usedPct}%`, background: over ? '#ef4444' : '#22c55e' }} />
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
        使用: {formatMinutesShort(metrics.rollingTwoDayDriveMinutes)} / 18:00
      </div>
    </div>
  );
}

function ComplianceCard({ metrics }: { metrics: DayMetrics }) {
  return (
    <div className="report-card" style={{ padding: 16 }}>
      <div className="report-section-title">法令チェック</div>
      <div className="report-section-caption" style={{ marginBottom: 12 }}>
        適用ルールは自動判定です。長距離特例は `450km以上区間`、フェリー特例は `乗船→下船` の検出を基準にしています。
      </div>
      <div className="report-load-item" style={{ borderLeftColor: '#38bdf8' }}>
        <div className="report-load-item__header">
          <span style={{ color: '#38bdf8' }}>{metrics.ruleModeLabel}</span>
          <span className="mono">48h {formatMinutesShort(metrics.rollingTwoDayDriveMinutes)} / 18:00</span>
        </div>
        <div className="report-load-item__meta">
          <span>2週平均 {formatMinutesShort(metrics.rollingTwoWeekWeeklyAverageMinutes)} / 44:00</span>
          <span>連続運転 {formatMinutesShort(metrics.longestContinuousDriveMinutes)}</span>
          <span>休息判定 {formatMinutesShort(metrics.restEquivalentMinutes)} / 最低 {formatMinutesShort(metrics.effectiveRestMinimumMinutes)}</span>
          {metrics.ferryMinutes > 0 && <span>フェリー {formatMinutes(metrics.ferryMinutes)}</span>}
        </div>
        <div className="report-load-item__address">{metrics.ruleModeReason}</div>
      </div>
    </div>
  );
}

// --- Breakdown row ---
function BreakdownRow({ label, minutes, color }: { label: string; minutes: number; color: string }) {
  return (
    <div className="report-breakdown__row">
      <span className="report-breakdown__dot" style={{ background: color }} />
      <span className="report-breakdown__label">{label}</span>
      <span className="report-breakdown__value">{formatMinutesShort(minutes)}</span>
      <span className="report-breakdown__text">{formatMinutes(minutes)}</span>
    </div>
  );
}

function BreakdownTotalRow({ label, minutes }: { label: string; minutes: number }) {
  return (
    <div className="report-breakdown__row" style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(148, 163, 184, 0.18)' }}>
      <span className="report-breakdown__dot" style={{ background: '#e2e8f0' }} />
      <span className="report-breakdown__label" style={{ fontWeight: 800 }}>{label}</span>
      <span className="report-breakdown__value" style={{ fontWeight: 800 }}>{formatMinutesShort(minutes)}</span>
      <span className="report-breakdown__text" style={{ fontWeight: 700 }}>{formatMinutes(minutes)}</span>
    </div>
  );
}

function RestSegmentCard({ segment }: { segment: TimeSegmentDetail }) {
  return (
    <div className="report-load-item" style={{ borderLeftColor: STATUS_COLORS.rest }}>
      <div className="report-load-item__header">
        <span style={{ color: STATUS_COLORS.rest }}>休息</span>
        <span className="mono">{formatRoundedJstTime(segment.startTs)} - {formatRoundedJstTime(segment.endTs)}</span>
      </div>
      <div className="report-load-item__meta">
        <span>{formatMinutes(segment.durationMinutes)}</span>
        {segment.continuesFromPreviousDay && <span className="report-badge">前日から継続</span>}
        {segment.continuesToNextDay && <span className="report-badge">翌日へ継続</span>}
      </div>
    </div>
  );
}

function FerrySegmentCard({ segment }: { segment: TimeSegmentDetail }) {
  return (
    <div className="report-load-item" style={{ borderLeftColor: '#0f766e' }}>
      <div className="report-load-item__header">
        <span style={{ color: '#0f766e' }}>フェリー</span>
        <span className="mono">{formatRoundedJstTime(segment.startTs)} - {formatRoundedJstTime(segment.endTs)}</span>
      </div>
      <div className="report-load-item__meta">
        <span>{formatMinutes(segment.durationMinutes)}</span>
      </div>
    </div>
  );
}

// --- Load/Unload card ---
function LoadCard({ detail, type, index }: {
  detail: { customer: string; volume: number; startTs: string; endTs: string; durationMinutes: number; address?: string };
  type: 'load' | 'unload';
  index: number;
}) {
  const isLoad = type === 'load';
  const color = isLoad ? (index === 0 ? STATUS_COLORS.load1 : STATUS_COLORS.load2) : STATUS_COLORS.unload;
  const typeLabel = isLoad ? '積込' : '荷卸';

  return (
    <div className="report-load-item" style={{ borderLeftColor: color }}>
      <div className="report-load-item__header">
        <span style={{ color }}>{typeLabel}{index > 0 ? ` #${index + 1}` : ''}</span>
        <span className="mono">{formatRoundedJstTime(detail.startTs)} - {formatRoundedJstTime(detail.endTs)}</span>
      </div>
      {detail.customer && <div className="report-load-item__customer">{detail.customer}</div>}
      <div className="report-load-item__meta">
        {detail.volume > 0 && <span>{detail.volume} M3</span>}
        <span>{formatMinutes(detail.durationMinutes)}</span>
      </div>
      {detail.address && <div className="report-load-item__address">{detail.address}</div>}
    </div>
  );
}

// --- Rest milestone card ---
function NextDayCard({ day }: { day: DayRecord }) {
  const restStart = [...day.events]
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .reverse()
    .find(event => event.type === 'rest_start');
  const milestones = [8, 9, 10, 12].map(hours => ({
    hours,
    ts: restStart
      ? new Date(new Date(restStart.ts).getTime() + hours * 60 * 60000).toISOString()
      : null,
  }));

  return (
    <div className="report-card report-next-day">
      <div className="report-section-title">休息開始からの目安</div>
      <div className="report-section-caption" style={{ marginBottom: 12 }}>
        当日最後の休息開始時刻を基準に、8 / 9 / 10 / 12 時間後を 15 分単位で表示します。
      </div>
      <div className="report-next-day__grid">
        {milestones.map(item => (
          <div key={item.hours} className="report-next-day__item">
            <span className="report-next-day__label">{item.hours}時間後</span>
            <span className="report-next-day__value mono">
              {item.ts ? formatRoundedJstTime(item.ts) : '--:--'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// =============================================
// Sub-view: Jobs
// =============================================
function JobsView({ jobs }: { jobs: JobInfo[] }) {
  if (jobs.length === 0) {
    return (
      <div className="report-card" style={{ padding: 24, textAlign: 'center' }}>
        <div style={{ color: 'var(--muted)' }}>案件情報がありません</div>
      </div>
    );
  }

  return (
    <div className="report-list">
      {jobs.map(job => (
        <div key={job.id} className="report-card report-job-card">
          <div className="report-job-card__header">
            <span className="report-job-card__customer">{job.customer || '顧客未設定'}</span>
            <span className={`report-job-card__status ${job.completed ? 'report-job-card__status--done' : ''}`}>
              {job.completed ? '完了' : '未完了'}
            </span>
          </div>
          <div className="report-job-card__details">
            {job.volume > 0 && <span>{job.volume} M3</span>}
            {job.loadAt && <span>積: {job.loadAt}</span>}
            {job.loadTime && <span>{job.loadTime}</span>}
            {job.dropAt && <span>卸: {job.dropAt}</span>}
            {job.dropDate && <span>{job.dropDate}</span>}
            {job.isBranchDrop && <span className="report-badge">支店卸</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

// =============================================
// Sub-view: Timeline
// =============================================
function TimelineView({ day }: { day: DayRecord }) {
  const sorted = useMemo(
    () => [...day.events].sort((a, b) => a.ts.localeCompare(b.ts)),
    [day.events]
  );

  const typeLabels: Record<string, string> = {
    trip_start: '運行開始',
    trip_end: '運行終了',
    load_start: '積込開始',
    load_end: '積込終了',
    unload_start: '荷卸開始',
    unload_end: '荷卸終了',
    break_start: '休憩開始',
    break_end: '休憩終了',
    rest_start: '休息開始',
    rest_end: '休息終了',
    expressway_start: '高速開始',
    expressway_end: '高速終了',
    expressway: '高速道路',
    boarding: 'フェリー乗船',
    disembark: 'フェリー下船',
    wait_start: '待機開始',
    wait_end: '待機終了',
    drive_start: '運転開始',
    drive_end: '運転終了',
    work_start: '業務開始',
    work_end: '業務終了',
  };

  const typeColors: Record<string, string> = {
    trip_start: '#38bdf8',
    trip_end: '#38bdf8',
    drive_start: STATUS_COLORS.drive,
    drive_end: STATUS_COLORS.drive,
    load_start: STATUS_COLORS.load1,
    load_end: STATUS_COLORS.load1,
    unload_start: STATUS_COLORS.unload,
    unload_end: STATUS_COLORS.unload,
    break_start: STATUS_COLORS.break,
    break_end: STATUS_COLORS.break,
    rest_start: STATUS_COLORS.rest,
    rest_end: STATUS_COLORS.rest,
    expressway_start: '#ec4899',
    expressway_end: '#ec4899',
    expressway: '#ec4899',
    boarding: '#0f766e',
    disembark: '#0f766e',
    wait_start: STATUS_COLORS.wait,
    wait_end: STATUS_COLORS.wait,
    work_start: STATUS_COLORS.work,
    work_end: STATUS_COLORS.work,
  };

  if (sorted.length === 0) {
    return (
      <div className="report-card" style={{ padding: 24, textAlign: 'center' }}>
        <div style={{ color: 'var(--muted)' }}>イベントがありません</div>
      </div>
    );
  }

  return (
    <div className="report-timeline">
      {sorted.map((ev, i) => {
        const color = typeColors[ev.type] ?? '#94a3b8';
        return (
          <div key={i} className="report-timeline__item">
            <div className="report-timeline__line">
              <div className="report-timeline__dot" style={{ background: color }} />
              {i < sorted.length - 1 && <div className="report-timeline__connector" />}
            </div>
            <div className="report-timeline__content">
              <div className="report-timeline__time mono">{formatRoundedJstTime(ev.ts)}</div>
              <div className="report-timeline__label" style={{ color }}>
                {typeLabels[ev.type] ?? ev.type}
              </div>
              {ev.customer && <div className="report-timeline__detail">{ev.customer}</div>}
              {ev.address && <div className="report-timeline__detail">{ev.address}</div>}
              {ev.memo && <div className="report-timeline__detail">{ev.memo}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// =============================================
// Tab: Monthly Summary
// =============================================
function MonthlyTab({ trips }: { trips: Trip[] }) {
  const now = new Date();
  const [month, setMonth] = useState(
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  );

  const summary = useMemo(() => computeMonthSummary(trips, month), [trips, month]);

  // Generate month options from trip data
  const months = useMemo(() => {
    const set = new Set<string>();
    for (const t of trips) {
      for (const d of t.days) {
        const m = d.dateKey.slice(0, 7);
        set.add(m);
      }
    }
    set.add(month);
    return [...set].sort().reverse();
  }, [trips, month]);

  return (
    <div>
      <div className="report-monthly-controls">
        <select
          className="report-select"
          value={month}
          onChange={e => setMonth(e.target.value)}
        >
          {months.map(m => (
            <option key={m} value={m}>{m.replace('-', '年')}月</option>
          ))}
        </select>
      </div>

      {/* Summary cards */}
      <div className="report-monthly-grid">
        <MonthlyStatCard label="運行数" value={String(summary.totalTrips)} />
        <MonthlyStatCard label="総走行距離" value={`${summary.totalKm} km`} />
        <MonthlyStatCard label="総運転時間" value={formatMinutesShort(summary.totalDriveMinutes)} />
        <MonthlyStatCard label="総拘束時間" value={formatMinutesShort(summary.totalConstraintMinutes)} />
        <MonthlyStatCard label="拘束超過日数" value={String(summary.overConstraintDays)} danger={summary.overConstraintDays > 0} />
        <MonthlyStatCard label="運転超過日数" value={String(summary.overDriveDays)} danger={summary.overDriveDays > 0} />
        <MonthlyStatCard label="休息不足日数" value={String(summary.underRestDays)} danger={summary.underRestDays > 0} />
      </div>

      {/* Daily breakdown */}
      {summary.days.length > 0 && (
        <div className="report-card" style={{ padding: 16, marginTop: 16 }}>
          <div className="report-section-title">日別明細</div>
          <div className="report-monthly-table">
            <div className="report-monthly-table__header">
              <span>日付</span>
              <span>拘束</span>
              <span>運転</span>
              <span>休息</span>
              <span>状態</span>
            </div>
            {summary.days.map((d, i) => {
              const hasAlert = d.metrics.constraintOverLimit || d.metrics.driveOverLimit || d.metrics.restUnderLimit;
              return (
                <div key={i} className={`report-monthly-table__row ${hasAlert ? 'report-monthly-table__row--alert' : ''}`}>
                  <span className="mono">{d.dateKey.slice(5)}</span>
                  <span className="mono" style={d.metrics.constraintOverLimit ? { color: '#ef4444' } : undefined}>
                    {formatMinutesShort(d.metrics.constraintMinutes)}
                  </span>
                  <span className="mono" style={d.metrics.driveOverLimit ? { color: '#ef4444' } : undefined}>
                    {formatMinutesShort(d.metrics.driveMinutes)}
                  </span>
                  <span className="mono" style={d.metrics.restUnderLimit ? { color: '#f59e0b' } : undefined}>
                    {formatMinutesShort(d.metrics.restMinutes)}
                  </span>
                  <span>
                    {hasAlert ? '\u{26A0}\u{FE0F}' : '\u{2705}'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function MonthlyStatCard({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="report-stat-card">
      <div className="report-stat-card__label">{label}</div>
      <div className={`report-stat-card__value mono ${danger ? 'report-stat-card__value--danger' : ''}`}>
        {value}
      </div>
    </div>
  );
}
