import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { Trip, DayRecord, DayMetrics, MonthSummary, JobInfo } from '../../domain/reportTypes';
import {
  parseJsonToTrip,
  computeDayMetrics,
  computeMonthSummary,
  formatMinutes,
  formatMinutesShort,
  formatJstTime,
  jstDateKey,
} from '../../domain/reportLogic';
import {
  saveReportTrip,
  listReportTrips,
  deleteReportTrip,
  getReportTripsByMonth,
} from '../../db/reportRepository';
import { restoreSnapshotJson, uuid } from '../../db/repositories';

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

export default function ReportDashboard() {
  const [mainTab, setMainTab] = useState<MainTab>('list');
  const [trips, setTrips] = useState<Trip[]>([]);
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadTrips() {
    try {
      const list = await listReportTrips();
      setTrips(list);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load trips');
    }
  }

  useEffect(() => { void loadTrips(); }, []);

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

  function openTrip(tripId: string) {
    setSelectedTripId(tripId);
    setMainTab('report');
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
              setSelectedTripId(trip.id);
              setMainTab('report');
            });
          }} />
        )}
        {mainTab === 'report' && (
          <ReportTab
            trip={selectedTrip}
            trips={trips}
            onSelectTrip={setSelectedTripId}
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
        `events` 付きスナップショットか `operation_log` 形式を復元できます。`operation_log` は運行開始・休憩・休息・積込・荷卸・給油の時刻を再構成し、未終了の `trip_start` があれば運行中として戻します。
      </div>
    </div>
  );
}

// =============================================
// Tab: Daily Report
// =============================================
function ReportTab({ trip, trips, onSelectTrip }: {
  trip: Trip | null;
  trips: Trip[];
  onSelectTrip: (id: string) => void;
}) {
  const [subTab, setSubTab] = useState<ReportSubTab>('daily');
  const [dayIdx, setDayIdx] = useState(0);

  useEffect(() => { setDayIdx(0); }, [trip?.id]);

  if (!trip) {
    return (
      <div className="report-card" style={{ textAlign: 'center', padding: 32 }}>
        <div style={{ fontSize: 36, marginBottom: 8 }}>{'\u{1F4CB}'}</div>
        <div style={{ fontWeight: 800, marginBottom: 12 }}>運行を選択してください</div>
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
  if (!day) return null;

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

      {subTab === 'daily' && <DailyView day={day} />}
      {subTab === 'jobs' && <JobsView jobs={trip.jobs} />}
      {subTab === 'timeline' && <TimelineView day={day} />}
    </div>
  );
}

// =============================================
// Sub-view: Daily Report (metrics cards)
// =============================================
function DailyView({ day }: { day: DayRecord }) {
  const metrics = useMemo(() => computeDayMetrics(day), [day]);

  return (
    <div className="report-daily">
      {/* Date header */}
      <div className="report-date-header">
        <span className="report-date-header__day">{day.dayIndex}日目</span>
        <span className="report-date-header__date">{day.dateKey}</span>
        {day.km > 0 && <span className="report-date-header__km">{day.km} km</span>}
      </div>

      {/* Alerts */}
      {metrics.alerts.map((a, i) => (
        <div key={i} className={`report-alert report-alert--${a.level}`}>
          {a.level === 'danger' ? '\u{26A0}\u{FE0F}' : '\u{26A0}'} {a.message}
        </div>
      ))}

      {/* 3 Big Metric Cards */}
      <div className="report-section-caption">その日の拘束・実働・翌日余力を上段に集約しています。</div>
      <div className="report-big-cards">
        <ConstraintCard minutes={metrics.constraintMinutes} overLimit={metrics.constraintOverLimit} />
        <WorkloadCard metrics={metrics} />
        <DriveRemainingCard metrics={metrics} />
      </div>

      {/* Activity breakdown */}
      <div className="report-card" style={{ padding: 16 }}>
        <div className="report-section-title">項目別集計</div>
        <div className="report-breakdown">
          <BreakdownRow label="運転" minutes={metrics.driveMinutes} color={STATUS_COLORS.drive} />
          <BreakdownRow label="業務" minutes={metrics.workMinutes} color={STATUS_COLORS.work} />
          <BreakdownRow label="休憩" minutes={metrics.breakMinutes} color={STATUS_COLORS.break} />
          <BreakdownRow label="休息" minutes={metrics.restMinutes} color={STATUS_COLORS.rest} />
          <BreakdownRow label="待機" minutes={metrics.waitMinutes} color={STATUS_COLORS.wait} />
        </div>
      </div>

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
      <NextDayCard metrics={metrics} />
    </div>
  );
}

// --- Constraint time card ---
function ConstraintCard({ minutes, overLimit }: { minutes: number; overLimit: boolean }) {
  const limitMin = 13 * 60;
  const pct = Math.min(100, (minutes / limitMin) * 100);
  const barColor = overLimit ? '#ef4444' : '#38bdf8';

  return (
    <div className="report-metric-card">
      <div className="report-metric-card__header">
        <span className="report-metric-card__label">拘束時間</span>
        <span className="report-metric-card__limit">上限 13:00</span>
      </div>
      <div className="report-metric-card__value" style={{ color: overLimit ? '#ef4444' : '#e2e8f0' }}>
        {formatMinutesShort(minutes)}
      </div>
      <div className="report-bar">
        <div className="report-bar__fill" style={{ width: `${pct}%`, background: barColor }} />
        <div className="report-bar__marker" style={{ left: '100%' }} />
      </div>
      {overLimit && <div className="report-metric-card__warning">上限超過</div>}
    </div>
  );
}

// --- Workload card ---
function WorkloadCard({ metrics }: { metrics: DayMetrics }) {
  const total = metrics.driveMinutes + metrics.workMinutes + metrics.breakMinutes;
  const drivePct = total > 0 ? (metrics.driveMinutes / total) * 100 : 0;
  const workPct = total > 0 ? (metrics.workMinutes / total) * 100 : 0;
  const breakPct = total > 0 ? (metrics.breakMinutes / total) * 100 : 0;

  return (
    <div className="report-metric-card">
      <div className="report-metric-card__header">
        <span className="report-metric-card__label">実働時間</span>
      </div>
      <div className="report-metric-card__value">{formatMinutesShort(total)}</div>
      <div className="report-stacked-bar">
        {drivePct > 0 && (
          <div className="report-stacked-bar__seg" style={{ width: `${drivePct}%`, background: STATUS_COLORS.drive }} />
        )}
        {workPct > 0 && (
          <div className="report-stacked-bar__seg" style={{ width: `${workPct}%`, background: STATUS_COLORS.work }} />
        )}
        {breakPct > 0 && (
          <div className="report-stacked-bar__seg" style={{ width: `${breakPct}%`, background: STATUS_COLORS.break }} />
        )}
      </div>
      <div className="report-legend">
        <span><span className="report-legend__dot" style={{ background: STATUS_COLORS.drive }} />運転 {formatMinutesShort(metrics.driveMinutes)}</span>
        <span><span className="report-legend__dot" style={{ background: STATUS_COLORS.work }} />業務 {formatMinutesShort(metrics.workMinutes)}</span>
        <span><span className="report-legend__dot" style={{ background: STATUS_COLORS.break }} />休憩 {formatMinutesShort(metrics.breakMinutes)}</span>
      </div>
    </div>
  );
}

// --- Drive remaining card ---
function DriveRemainingCard({ metrics }: { metrics: DayMetrics }) {
  const limitMin = 9 * 60;
  const usedPct = Math.min(100, (metrics.driveMinutes / limitMin) * 100);
  const over = metrics.driveOverLimit;

  return (
    <div className="report-metric-card">
      <div className="report-metric-card__header">
        <span className="report-metric-card__label">翌日残り運転</span>
        <span className="report-metric-card__limit">上限 09:00</span>
      </div>
      <div className="report-metric-card__value" style={{ color: over ? '#ef4444' : '#22c55e' }}>
        {formatMinutesShort(metrics.nextDriveRemaining)}
      </div>
      <div className="report-bar">
        <div className="report-bar__fill" style={{ width: `${usedPct}%`, background: over ? '#ef4444' : '#22c55e' }} />
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
        使用: {formatMinutesShort(metrics.driveMinutes)} / 09:00
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
        <span className="mono">{formatJstTime(detail.startTs)} - {formatJstTime(detail.endTs)}</span>
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

// --- Next day outlook card ---
function NextDayCard({ metrics }: { metrics: DayMetrics }) {
  return (
    <div className="report-card report-next-day">
      <div className="report-section-title">翌日運行見通し</div>
      <div className="report-next-day__grid">
        <div className="report-next-day__item">
          <span className="report-next-day__label">最短運行再開</span>
          <span className="report-next-day__value mono">
            {metrics.earliestRestart ? formatJstTime(metrics.earliestRestart) : '--:--'}
          </span>
        </div>
        <div className="report-next-day__item">
          <span className="report-next-day__label">残り運転時間</span>
          <span className="report-next-day__value mono">{formatMinutesShort(metrics.nextDriveRemaining)}</span>
        </div>
        <div className="report-next-day__item">
          <span className="report-next-day__label">残り拘束時間</span>
          <span className="report-next-day__value mono">{formatMinutesShort(metrics.nextConstraintRemaining)}</span>
        </div>
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
              <div className="report-timeline__time mono">{formatJstTime(ev.ts)}</div>
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
