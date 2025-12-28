import type { RestStartEvent, RestEndEvent, Segment, DayRun } from './types';

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
 * Compute day runs based on rest end boundaries marked with dayClose=true. Each
 * confirmed day run represents the distance from the previous boundary (or
 * trip start) to the day close boundary. A pending day run is added for
 * ongoing trips to indicate the next segment that has not yet been closed.
 */
export function computeDayRuns(params: {
  odoStart: number;
  restStarts: RestStartEvent[];
  restEnds: RestEndEvent[];
  odoEnd?: number;
}): DayRun[] {
  const rs = sortByTs(params.restStarts);
  const re = sortByTs(params.restEnds);
  // Map sessionId to odoKm for quick lookup.
  const startOdoBySession = new Map<string, number>();
  for (const r of rs) {
    startOdoBySession.set(r.extras.restSessionId, r.extras.odoKm);
  }
  // Extract boundaries (dayClose=true)
  const closes = re.filter(e => e.extras.dayClose);
  const boundaries: Array<{ dayIndex: number; boundaryOdo: number; ts: string }> = [];
  closes.forEach((e, idx) => {
    const dayIndex = e.extras.dayIndex ?? idx + 1;
    const boundaryOdo = startOdoBySession.get(e.extras.restSessionId);
    if (boundaryOdo != null) {
      boundaries.push({ dayIndex, boundaryOdo, ts: e.ts });
    }
  });
  boundaries.sort((a, b) => a.ts.localeCompare(b.ts));
  const days: DayRun[] = [];
  let prevOdo = params.odoStart;
  let prevDayIndex = 0;
  boundaries.forEach(b => {
    const km = b.boundaryOdo - prevOdo;
    days.push({
      dayIndex: b.dayIndex,
      fromLabel: prevDayIndex === 0 ? 'trip_start' : `day_${prevDayIndex}_close`,
      toLabel: `day_${b.dayIndex}_close`,
      km,
      closeOdo: b.boundaryOdo,
      status: 'confirmed',
    });
    prevOdo = b.boundaryOdo;
    prevDayIndex = b.dayIndex;
  });
  if (params.odoEnd != null) {
    const km = params.odoEnd - prevOdo;
    const dayIndex = prevDayIndex + 1;
    days.push({
      dayIndex,
      fromLabel: prevDayIndex === 0 ? 'trip_start' : `day_${prevDayIndex}_close`,
      toLabel: 'trip_end',
      km,
      closeOdo: params.odoEnd,
      status: 'confirmed',
    });
  } else {
    // For an ongoing trip, add a pending day run to show the next segment.
    if (prevDayIndex >= 0) {
      const dayIndex = prevDayIndex + 1;
      days.push({
        dayIndex,
        fromLabel: prevDayIndex === 0 ? 'trip_start' : `day_${prevDayIndex}_close`,
        toLabel: 'pending',
        km: 0,
        status: 'pending',
      });
    }
  }
  return days;
}
