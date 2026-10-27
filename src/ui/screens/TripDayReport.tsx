import { useState } from 'react';
import type { AppEvent } from '../../domain/types';
import { getExpresswayIcDisplay } from '../../domain/expresswayIcDisplay';
import type { HistoryDay } from './tripHistoryReport';

type Category = 'drive' | 'work' | 'break' | 'ferry' | 'rest';

const CATEGORIES: readonly { key: Category; label: string }[] = [
  { key: 'drive', label: '走行' },
  { key: 'work', label: '作業' },
  { key: 'break', label: '休憩' },
  { key: 'ferry', label: 'フェリー' },
  { key: 'rest', label: '休息' },
];

const EVENT_LABELS: Record<string, string> = {
  trip_start: '運行開始', trip_end: '運行終了',
  load_start: '積込開始', load_end: '積込終了',
  unload_start: '荷卸し開始', unload_end: '荷卸し終了',
  break_start: '休憩開始', break_end: '休憩終了',
  rest_start: '休息開始', rest_end: '休息終了',
  boarding: 'フェリー乗船', disembark: 'フェリー下船',
  wait_start: '待機開始', wait_end: '待機終了',
  work_start: 'その他作業開始', work_end: 'その他作業終了',
  drive_start: '走行開始', drive_end: '走行終了',
  expressway_start: '高速入口', expressway_end: '高速出口',
  expressway: '高速道路', refuel: '給油', point_mark: '地点記録',
};

function minuteLabel(minute: number): string {
  const value = Math.max(0, Math.min(1440, Math.round(minute)));
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function durationLabel(minutes: number): string {
  const value = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

/** The model supplies the same rounded/minimum-duration boundary as the graph. */
export function formatTripDayEventTime(effectiveMinute: number | undefined): string {
  if (effectiveMinute == null || !Number.isFinite(effectiveMinute) || effectiveMinute < 0 || effectiveMinute > 1440) return '時刻未確認';
  return minuteLabel(effectiveMinute);
}

/** A display-only abbreviation of a saved Japanese address, with no lookup. */
export function getTripDayMunicipality(address: string | undefined): string | undefined {
  if (typeof address !== 'string' || !address.trim()) return undefined;
  const source = address.trim()
    .replace(/^日本[、,\s]*/, '')
    .replace(/^〒?\d{3}[-－]\d{4}[、,\s]*/, '');
  const prefecture = source.match(/^(北海道|東京都|京都府|大阪府|[^\s、,]{2,3}県)/)?.[1] ?? '';
  // A facility name containing 市/町 is not evidence of a municipality.
  if (!prefecture) return undefined;
  const clean = source.slice(prefecture.length);
  // A county can itself contain 市 (e.g. 余市郡), so handle it before cities.
  const county = clean.match(/^([^\d\s、,]{1,12}郡)([^\d\s、,]{1,12}?[町村])/);
  if (county) return prefecture + county[1] + county[2];
  const city = clean.match(/^(四日市市|野々市市|廿日市市|[^\d\s、,]{1,12}?市)/);
  if (city) {
    const name = city[1];
    // Ambiguous 市/町/村 sequences stay as the saved address instead of a guess.
    // E.g. 市川三郷町市川大門 must not become a fabricated 市川三郷町市.
    if (/[町村]/.test(name.slice(1, -1))) return undefined;
    const ward = clean.slice(name.length).match(/^([^\d\s、,]{1,10}?区)/)?.[1];
    return prefecture + name + (ward ?? '');
  }
  const district = clean.match(/^([^\d\s、,]{1,12}?[区町村])/);
  return district ? prefecture + district[1] : undefined;
}

function eventCategory(type: string): Category | undefined {
  if (type.startsWith('load_') || type.startsWith('unload_') || type.startsWith('work_') || type.startsWith('wait_')) return 'work';
  if (type.startsWith('break_')) return 'break';
  if (type.startsWith('rest_')) return 'rest';
  if (type === 'boarding' || type === 'disembark') return 'ferry';
  if (type.startsWith('trip_') || type.startsWith('drive_') || type.startsWith('expressway')) return 'drive';
  return undefined;
}

function savedAddress(event: AppEvent): string | undefined {
  return typeof event.address === 'string' && event.address.trim() ? event.address.trim() : undefined;
}

function EventRow({ event, effectiveMinute }: { event: AppEvent; effectiveMinute: number | undefined }) {
  const expressway = event.type === 'expressway_start' || event.type === 'expressway_end' || event.type === 'expressway';
  const ic = expressway ? getExpresswayIcDisplay(event.extras) : undefined;
  const address = savedAddress(event);
  const municipality = getTripDayMunicipality(address);
  const liters = event.type === 'refuel' && typeof event.extras?.liters === 'number'
    && Number.isFinite(event.extras.liters) && event.extras.liters > 0 ? event.extras.liters : undefined;
  const automatic = typeof event.extras?.autoReason === 'string' && !!event.extras.autoReason;
  const hasDetail = !!ic || !!(address && municipality && address !== municipality) || automatic;
  return (
    <li className="trip-report-event" data-event-id={event.id} data-event-type={event.type}>
      <time dateTime={Number.isFinite(Date.parse(event.ts)) ? event.ts : undefined}>
        {formatTripDayEventTime(effectiveMinute)}
      </time>
      <div className="trip-report-event__body">
        <div className="trip-report-event__label">
          <span className={`trip-report-dot${eventCategory(event.type) ? ` trip-report-color--${eventCategory(event.type)}` : ''}`} aria-hidden="true" />
          {EVENT_LABELS[event.type] ?? '記録'}
          {liters != null && <span className="trip-report-event__quantity">{liters.toLocaleString('ja-JP')} L</span>}
        </div>
        {ic && <div className="trip-report-event__ic">{ic.label}</div>}
        <div className="trip-report-event__place">{municipality ?? address ?? '場所未確認'}</div>
        {hasDetail && (
          <details className="trip-report-event__details">
            <summary>記録の詳細</summary>
            {address && municipality && address !== municipality && <p>保存住所：{address}</p>}
            {ic && <p>{ic.detail}</p>}
            {automatic && <p>自動切替の記録</p>}
          </details>
        )}
      </div>
    </li>
  );
}

export function TripDayReport({ day, km }: { day: HistoryDay; km?: number }) {
  const [selectedSegment, setSelectedSegment] = useState<string | null>(null);
  const displayTotal = CATEGORIES.reduce((sum, category) => sum + (day.totals[category.key] || 0), 0);
  const y = (category: Category) => CATEGORIES.findIndex(item => item.key === category) * 42 + 21;
  const segmentKey = (segment: HistoryDay['segments'][number]) => `${day.dateKey}-${segment.startMinute}-${segment.endMinute}-${segment.category}`;
  const describeSegment = (segment: HistoryDay['segments'][number]) => {
    const category = CATEGORIES.find(item => item.key === segment.category);
    return `${category?.label ?? '未確認'} ${minuteLabel(segment.startMinute)}–${minuteLabel(segment.endMinute)}（${durationLabel(segment.endMinute - segment.startMinute)}）`;
  };
  const activeSegment = day.segments.find(segment => segmentKey(segment) === selectedSegment);
  const orderedEvents = day.events.map((event, index) => ({ event, index }))
    .sort((a, b) => ((day.effectiveMinutes[a.event.id] ?? Infinity) - (day.effectiveMinutes[b.event.id] ?? Infinity))
      || (Date.parse(a.event.ts) - Date.parse(b.event.ts)) || a.index - b.index);

  return (
    <section className="trip-history-report" aria-labelledby={`history-report-day-${day.dayIndex}`}>
      <header className="trip-history-report__head">
        <div>
          <h2 id={`history-report-day-${day.dayIndex}`}>{day.dayIndex}日目</h2>
          <p>{day.dateKey}{day.ongoing && <span className="trip-history-report__ongoing">運行中</span>}</p>
        </div>
        {km != null && Number.isFinite(km) && <strong>{km.toLocaleString('ja-JP')} <span>km</span></strong>}
      </header>

      <div className="trip-report-chart" aria-label="15分単位の運行時間表">
        <div className="trip-report-chart__summary"><span>15分単位</span><span>合計 {durationLabel(displayTotal)}</span></div>
        <div className="trip-report-axis" aria-hidden="true">
          <span>区分</span>
          <div>{Array.from({ length: 25 }, (_, hour) => (
            <span key={hour} className={`trip-report-axis__hour${hour % 6 === 0 ? ' trip-report-axis__hour--major' : hour % 3 === 0 ? ' trip-report-axis__hour--middle' : ''}`}
              style={{ left: `${hour / 24 * 100}%` }}>{String(hour).padStart(2, '0')}</span>
          ))}</div>
          <span>合計</span>
        </div>
        <div className="trip-report-grid">
          <div className="trip-report-grid__labels">
            {CATEGORIES.map(category => <div key={category.key}>{category.label}</div>)}
          </div>
          <svg className="trip-report-grid__plot" viewBox="0 0 1440 210" preserveAspectRatio="none" role="group"
            aria-label={`${day.dateKey}、0時から24時までの走行・作業・休憩・フェリー・休息`}>
            <title>区分ごとの時間帯。区間を選ぶと時刻を表示します。</title>
            {Array.from({ length: 97 }, (_, quarter) => <line key={`v-${quarter}`} x1={quarter * 15} x2={quarter * 15} y1="0" y2="210"
              className={quarter % 24 === 0 ? 'trip-report-grid__line trip-report-grid__line--major' : quarter % 4 === 0 ? 'trip-report-grid__line trip-report-grid__line--hour' : 'trip-report-grid__line'} />)}
            {Array.from({ length: 6 }, (_, row) => <line key={`h-${row}`} x1="0" x2="1440" y1={row * 42} y2={row * 42} className="trip-report-grid__line trip-report-grid__line--row" />)}
            {day.segments.map((segment, index) => {
              if (segment.category == null || segment.endMinute <= segment.startMinute) return null;
              const center = y(segment.category);
              const previous = day.segments[index - 1];
              const description = describeSegment(segment);
              return (
                <g key={`${segment.startMinute}-${segment.endMinute}-${segment.category}`} className={`trip-report-grid__segment trip-report-color--${segment.category}`}
                  role="button" tabIndex={0} aria-label={description} data-category={segment.category}
                  data-start-minute={segment.startMinute} data-end-minute={segment.endMinute}
                  onClick={() => setSelectedSegment(segmentKey(segment))} onFocus={() => setSelectedSegment(segmentKey(segment))}
                  onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedSegment(segmentKey(segment)); } }}>
                  <title>{description}</title>
                  <rect x={segment.startMinute} y={center - 15} width={segment.endMinute - segment.startMinute} height="30" />
                  {segment.category === 'break' && <line x1={segment.startMinute} x2={segment.endMinute} y1={center} y2={center} className="trip-report-grid__activity-edge" />}
                  <line x1={segment.startMinute} x2={segment.endMinute} y1={center} y2={center} className="trip-report-grid__activity" />
                  {previous?.category && previous.category !== segment.category && previous.endMinute === segment.startMinute && (
                    <line x1={segment.startMinute} x2={segment.startMinute} y1={y(previous.category)} y2={center} className="trip-report-grid__transition" />
                  )}
                </g>
              );
            })}
          </svg>
          <div className="trip-report-grid__totals">
            {CATEGORIES.map(category => <div key={category.key} data-category-total={category.key}
              aria-label={`${category.label}合計 ${durationLabel(day.totals[category.key])}`}>{durationLabel(day.totals[category.key])}</div>)}
          </div>
        </div>
        <div className="trip-report-chart__selection" aria-live="polite">{activeSegment ? describeSegment(activeSegment) : '区間をタップすると時刻を表示'}</div>
        <div className="trip-report-chart__note">空白：運行外・未確認{day.unknownMinutes > 0 && ` · 未確認 ${durationLabel(day.unknownMinutes)}`}</div>
      </div>

      <section className="trip-report-events" aria-labelledby={`history-report-events-${day.dayIndex}`}>
        <div className="trip-report-events__heading"><h3 id={`history-report-events-${day.dayIndex}`}>時刻・作業場所</h3><span>15分単位</span></div>
        {orderedEvents.length ? <ol>{orderedEvents.map(({ event, index }) => <EventRow key={`${event.id}-${index}`} event={event} effectiveMinute={day.effectiveMinutes[event.id]} />)}</ol>
          : <p className="trip-report-events__empty">この日の記録はありません</p>}
      </section>
    </section>
  );
}

export default TripDayReport;
