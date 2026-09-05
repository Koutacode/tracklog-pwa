import { formatMinutes, formatReportMinute, type ProjectedReportTimelineEvent } from '../../domain/reportLogic';
import type { TripEvent, TripEventType } from '../../domain/reportTypes';

export type TripDetailWorkTimelineRow = {
  key: string;
  kind: 'interval' | 'instant';
  label: string;
  startMinute: number;
  endMinute?: number;
  detail?: string;
  liters?: number;
  continuesFromPreviousDay?: boolean;
  continuesToNextDay?: boolean;
};

export type TripDetailDayTimeline = {
  dayIndex: number;
  timeline: ProjectedReportTimelineEvent[];
};

const WORK_TIMELINE_PAIRS: Array<{ start: TripEventType; end: TripEventType; label: string }> = [
  { start: 'load_start', end: 'load_end', label: '積込' },
  { start: 'unload_start', end: 'unload_end', label: '荷卸' },
  { start: 'break_start', end: 'break_end', label: '休憩' },
  { start: 'rest_start', end: 'rest_end', label: '休息' },
  { start: 'boarding', end: 'disembark', label: 'フェリー' },
  { start: 'wait_start', end: 'wait_end', label: '待機' },
  { start: 'work_start', end: 'work_end', label: '業務' },
];

function getRefuelLiters(event: TripEvent): number | undefined {
  const liters = event.extras?.liters;
  return typeof liters === 'number' && Number.isFinite(liters) && liters > 0
    ? liters
    : undefined;
}

function formatRefuelLiters(liters: number): string {
  return new Intl.NumberFormat('ja-JP', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 3,
  }).format(liters);
}

export function buildTripDetailWorkTimeline(
  timeline: ProjectedReportTimelineEvent[],
): TripDetailWorkTimelineRow[] {
  return buildTripDetailWorkTimelineForDay([{ dayIndex: 1, timeline }], 1);
}

export function buildTripDetailWorkTimelineForDay(
  dayTimelines: TripDetailDayTimeline[],
  targetDayIndex: number,
): TripDetailWorkTimelineRow[] {
  const startDefinitions = new Map(WORK_TIMELINE_PAIRS.map(pair => [pair.start, pair] as const));
  const endDefinitions = new Map(WORK_TIMELINE_PAIRS.map(pair => [pair.end, pair] as const));
  const openByStartType = new Map<TripEventType, Array<{
    event: TripEvent;
    absoluteMinute: number;
    index: number;
  }>>();
  const absoluteRows: Array<{
    key: string;
    kind: 'interval';
    label: string;
    startMinute: number;
    endMinute?: number;
    detail?: string;
    missingStart?: boolean;
  }> = [];
  const targetDayPosition = dayTimelines.findIndex(day => day.dayIndex === targetDayIndex);
  if (targetDayPosition < 0) return [];

  const absoluteTimeline = dayTimelines.flatMap((day, dayPosition) => (
    day.timeline.map(projected => ({
      ...projected,
      absoluteMinute: dayPosition * 1440 + projected.effectiveMinute,
    }))
  ));

  absoluteTimeline.forEach((projected, index) => {
    const startDefinition = startDefinitions.get(projected.event.type);
    if (startDefinition) {
      const open = openByStartType.get(startDefinition.start) ?? [];
      open.push({ event: projected.event, absoluteMinute: projected.absoluteMinute, index });
      openByStartType.set(startDefinition.start, open);
      return;
    }

    const endDefinition = endDefinitions.get(projected.event.type);
    if (!endDefinition) return;
    const open = openByStartType.get(endDefinition.start) ?? [];
    const start = open.shift();
    openByStartType.set(endDefinition.start, open);
    absoluteRows.push({
      key: `${endDefinition.start}-${start?.index ?? `carry-${index}`}-${index}`,
      kind: 'interval',
      label: endDefinition.label,
      startMinute: start?.absoluteMinute ?? Number.NEGATIVE_INFINITY,
      endMinute: projected.absoluteMinute,
      detail: start?.event.customer || start?.event.address,
      missingStart: !start,
    });
  });

  for (const pair of WORK_TIMELINE_PAIRS) {
    for (const start of openByStartType.get(pair.start) ?? []) {
      absoluteRows.push({
        key: `${pair.start}-${start.index}-open`,
        kind: 'interval',
        label: pair.label,
        startMinute: start.absoluteMinute,
        detail: start.event.customer || start.event.address,
      });
    }
  }

  const targetStart = targetDayPosition * 1440;
  const targetEnd = targetStart + 1440;
  const isLastDay = targetDayPosition === dayTimelines.length - 1;
  const rows = absoluteRows.flatMap(row => {
    const absoluteEnd = row.endMinute ?? Number.POSITIVE_INFINITY;
    if (absoluteEnd <= targetStart || row.startMinute >= targetEnd) return [];
    const continuesFromPreviousDay = row.missingStart || row.startMinute < targetStart;
    const continuesToNextDay = row.endMinute == null ? !isLastDay : absoluteEnd > targetEnd;
    return [{
      key: `${targetDayIndex}-${row.key}`,
      kind: row.kind,
      label: row.label,
      startMinute: Math.max(0, row.startMinute - targetStart),
      endMinute: row.endMinute == null && isLastDay
        ? undefined
        : Math.min(1440, absoluteEnd - targetStart),
      detail: row.detail,
      continuesFromPreviousDay,
      continuesToNextDay,
    }];
  });

  const instantRows: TripDetailWorkTimelineRow[] = dayTimelines[targetDayPosition].timeline.flatMap(
    (projected, index) => {
      if (projected.event.type !== 'refuel') return [];
      const liters = getRefuelLiters(projected.event);
      return [{
        key: `${targetDayIndex}-refuel-${projected.event.ts}-${index}`,
        kind: 'instant',
        label: liters == null ? '給油' : `給油 ${formatRefuelLiters(liters)} L`,
        startMinute: projected.effectiveMinute,
        detail: projected.event.address || projected.event.memo,
        liters,
      }];
    },
  );

  return [...rows, ...instantRows].sort((a, b) => (
    a.startMinute - b.startMinute
    || (a.endMinute ?? Infinity) - (b.endMinute ?? Infinity)
  ));
}

export function formatTripDetailWorkTimelineRow(row: TripDetailWorkTimelineRow) {
  if (row.kind === 'instant') {
    return {
      startLabel: `時刻 ${formatReportMinute(row.startMinute)}`,
      endLabel: '',
      durationLabel: row.liters == null ? '給油量 未記録' : '給油記録',
    };
  }
  return {
    startLabel: `開始 ${formatReportMinute(row.startMinute)}`,
    endLabel: `終了 ${row.endMinute == null ? '進行中' : formatReportMinute(row.endMinute)}`,
    durationLabel: row.endMinute == null
      ? '作業時間 継続中'
      : `作業時間 ${formatMinutes(Math.max(0, row.endMinute - row.startMinute))}`,
  };
}
