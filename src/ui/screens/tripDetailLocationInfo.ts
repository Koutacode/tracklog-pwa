import { formatReportMinute, type ProjectedReportTimelineEvent } from '../../domain/reportLogic';

export type TripDetailLocationInfo = {
  key: string;
  label: string;
  time: string;
  icName?: string;
  address?: string;
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
  work_start: '業務開始地点',
  work_end: '業務終了地点',
  expressway_start: '高速開始',
  expressway_end: '高速終了',
  expressway: '高速道路',
};

function getExtraString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function buildTripDetailLocationInfo(
  timeline: ProjectedReportTimelineEvent[],
): TripDetailLocationInfo[] {
  return timeline.flatMap(({ event, effectiveMinute }, index) => {
    const expressway = event.type === 'expressway_start'
      || event.type === 'expressway_end'
      || event.type === 'expressway';
    const icName = expressway ? getExtraString(event.extras?.icName) : undefined;
    if (!expressway && !event.address) return [];
    return [{
      key: `${event.type}-${event.ts}-${index}`,
      label: LOCATION_EVENT_LABELS[event.type] ?? '記録地点',
      time: formatReportMinute(effectiveMinute),
      icName,
      address: event.address,
      expressway,
    }];
  });
}
