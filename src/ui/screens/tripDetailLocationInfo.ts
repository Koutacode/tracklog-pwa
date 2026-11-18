import { formatReportMinute, type ProjectedReportTimelineEvent } from '../../domain/reportLogic';
import { getExpresswayIcDisplay, type ExpresswayIcDisplay } from '../../domain/expresswayIcDisplay';
import type { AutomaticBreakRestProjection } from '../../domain/metrics';
import type { AppEvent } from '../../domain/types';

export type TripDetailLocationInfo = {
  key: string;
  label: string;
  time: string;
  recordedTs?: string;
  icName?: string;
  icDisplay?: ExpresswayIcDisplay;
  address?: string;
  addressUnavailable: boolean;
  expressway: boolean;
};

const LOCATION_EVENT_LABELS: Record<string, string> = {
  trip_start: '運行開始地点',
  trip_end: '運行終了地点',
  load_start: '積込開始地点',
  load_end: '積込終了地点',
  unload_start: '荷卸開始地点',
  unload_end: '荷卸終了地点',
  break_start: '休憩開始地点',
  break_end: '休憩終了地点',
  rest_start: '休息開始地点',
  rest_end: '休息終了地点',
  boarding: 'フェリー乗船地点',
  disembark: 'フェリー下船地点',
  wait_start: '待機開始地点',
  wait_end: '待機終了地点',
  work_start: 'その他開始地点',
  work_end: 'その他終了地点',
  expressway_start: '高速開始',
  expressway_end: '高速終了',
  expressway: '高速道路',
};

// Explicit user-operation boundaries remain visible even when location lookup failed.
const OPERATION_BOUNDARY_TYPES: ReadonlySet<ProjectedReportTimelineEvent['event']['type']> = new Set([
  'load_start', 'load_end', 'unload_start', 'unload_end',
  'break_start', 'break_end', 'wait_start', 'wait_end', 'work_start', 'work_end',
  'rest_start', 'rest_end', 'boarding', 'disembark',
]);

function getExtraString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Keep the original break location as a reference for its two generated rows. */
export function buildBreakStartAddressReferences(projection: AutomaticBreakRestProjection<AppEvent>) {
  const references = new Map<AppEvent, string>();
  for (const { breakStart, breakEnd, restStart } of projection.sourcesByProjectedRest.values()) {
    const address = getExtraString(breakStart.address);
    if (!address || breakStart.tripId !== breakEnd.tripId || breakStart.tripId !== restStart.tripId) continue;
    references.set(breakEnd, address);
    references.set(restStart, address);
  }
  return references;
}

export function getEventLocationLabel(event: AppEvent, breakStartAddress?: string): string | undefined {
  const address = getExtraString(event.address);
  if (address) return address;
  const geo = event.geo;
  if (geo && Number.isFinite(geo.lat) && Math.abs(geo.lat) <= 90
    && Number.isFinite(geo.lng) && Math.abs(geo.lng) <= 180) {
    return '位置は記録済み（住所未取得）';
  }
  return breakStartAddress ? `休憩開始時の住所（参考）：${breakStartAddress}` : undefined;
}

export function buildTripDetailLocationInfo(
  timeline: ProjectedReportTimelineEvent[],
): TripDetailLocationInfo[] {
  return timeline.flatMap(({ event, effectiveMinute }, index) => {
    const recordedBoundary = event.type === 'trip_start' || event.type === 'trip_end';
    if (recordedBoundary && !Number.isFinite(Date.parse(event.ts))) return [];
    const recordedTs = recordedBoundary ? event.ts : undefined;
    const operationBoundary = OPERATION_BOUNDARY_TYPES.has(event.type);
    const address = recordedBoundary || operationBoundary ? getExtraString(event.address) : event.address;
    const expressway = event.type === 'expressway_start'
      || event.type === 'expressway_end'
      || event.type === 'expressway';
    const icName = expressway ? getExtraString(event.extras?.icName) : undefined;
    if (!recordedBoundary && !operationBoundary && !expressway && !address) return [];
    return [{
      key: `${event.type}-${event.ts}-${index}`,
      label: LOCATION_EVENT_LABELS[event.type] ?? '記録地点',
      // All location rows follow the daily report's rounding and minimum-duration projection.
      time: formatReportMinute(effectiveMinute),
      recordedTs,
      icName,
      icDisplay: expressway ? getExpresswayIcDisplay(event.extras) : undefined,
      address,
      addressUnavailable: (recordedBoundary || operationBoundary) && !address,
      expressway,
    }];
  });
}
