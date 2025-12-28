import type { RestStartEvent, Segment, DayRun } from './types';
import { DAY_MS, getJstDateInfo } from './jst';

function sortByTs<T extends { ts: string }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => a.ts.localeCompare(b.ts));
}

/**
 * Compute sequential segments between the trip start, rest starts and trip end.
 * Each segment represents the distance traveled between two odometer checkpoints.
 */
export function computeSegments(params: {
  odoStart: number;
  tripStartTs: string;
  restStarts: RestStartEvent[];
  tripEnd?: { odoEnd: number; tripEndTs: string };
}): Segment[] {
  const rs = sortByTs(params.restStarts);
  const points: Array<{
    label: string;
    odo: number;
    ts: string;
    restSessionId?: string;
  }> = [
    { label: 'trip_start', odo: params.odoStart, ts: params.tripStartTs },
    ...rs.map((r, i) => ({
      label: `rest_start_${i + 1}`,
      odo: r.extras.odoKm,
      ts: r.ts,
      restSessionId: r.extras.restSessionId,
    })),
    ...(params.tripEnd
      ? [
          {
            label: 'trip_end',
            odo: params.tripEnd.odoEnd,
            ts: params.tripEnd.tripEndTs,
          },
        ]
      : []),
  ];

  const segments: Segment[] = [];
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];
    const km = to.odo - from.odo;
    segments.push({
      index: i,
      fromLabel: from.label,
      toLabel: to.label,
      fromOdo: from.odo,
      toOdo: to.odo,
      km,
      valid: km >= 0,
      fromTs: from.ts,
      toTs: to.ts,
      restSessionIdTo: to.restSessionId,
    });
  }
  return segments;
}

/**
 * Compute total distance and last-leg distance. The last leg is defined as
 * the distance from the final rest start (if any) to the trip end. If no
 * rest start exists then the last leg equals the total distance.
 */
export function computeTotals(params: {
  odoStart: number;
  odoEnd: number;
  lastRestStartOdo?: number;
}): { totalKm: number; lastLegKm: number; valid: boolean } {
  const totalKm = params.odoEnd - params.odoStart;
  const lastLegKm = params.lastRestStartOdo != null ? params.odoEnd - params.lastRestStartOdo : totalKm;
  return { totalKm, lastLegKm, valid: totalKm >= 0 && lastLegKm >= 0 };
}

/**
 * Compute day runs using Japan Standard Time (24:00 boundary).
 * Distances are still derived from odometer checkpoints at trip start,
 * rest starts and trip end.
 */
export function computeDayRuns(params: {
  odoStart: number;
  tripStartTs: string;
  restStarts: RestStartEvent[];
  tripEnd?: { odoEnd: number; tripEndTs: string };
}): DayRun[] {
  const segments = computeSegments({
    odoStart: params.odoStart,
    tripStartTs: params.tripStartTs,
    restStarts: params.restStarts,
    tripEnd: params.tripEnd,
  });
  const startInfo = getJstDateInfo(params.tripStartTs);
  const startDayStamp = startInfo.dayStamp;

  const groups = new Map<number, DayRun>();
  for (const seg of segments) {
    if (!seg.toTs) continue;
    const info = getJstDateInfo(seg.toTs);
    const dayIndex = Math.floor((info.dayStamp - startDayStamp) / DAY_MS) + 1;
    const entry = groups.get(info.dayStamp);
    const closeLabel = seg.toLabel === 'trip_end' ? '運行終了' : '休息開始';
    if (entry) {
      entry.km += seg.km;
      entry.closeOdo = seg.toOdo;
      entry.closeLabel = closeLabel;
    } else {
      groups.set(info.dayStamp, {
        dayIndex,
        dateKey: info.dateKey,
        dateLabel: info.dateLabel,
        km: seg.km,
        closeOdo: seg.toOdo,
        closeLabel,
        status: 'confirmed',
      });
    }
  }

  if (groups.size === 0) {
    return [
      {
        dayIndex: 1,
        dateKey: startInfo.dateKey,
        dateLabel: startInfo.dateLabel,
        km: 0,
        status: params.tripEnd ? 'confirmed' : 'pending',
      },
    ];
  }

  const days = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, run]) => run);

  if (!params.tripEnd) {
    const last = days[days.length - 1];
    if (last) last.status = 'pending';
  }
  return days;
}
