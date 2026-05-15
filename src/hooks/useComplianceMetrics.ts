import { useMemo, useState, useEffect } from 'react';
import { buildTripViewModel } from '../state/selectors';
import { buildReportTripFromAppEvents, computeTripDayMetrics } from '../domain/reportLogic';
import { computeLiveDriveStatus } from '../domain/liveDriveStatus';
import type { AppEvent } from '../domain/types';

export function useComplianceMetrics(tripId: string | null, events: AppEvent[]) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!tripId) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [tripId]);

  const metricsMinute = Math.floor(now / 60000);
  const metricsNowIso = useMemo(() => new Date(metricsMinute * 60000).toISOString(), [metricsMinute]);

  const liveVm = useMemo(() => {
    if (!tripId) return null;
    const hasTripStart = events.some(event => event.tripId === tripId && event.type === 'trip_start');
    if (!hasTripStart) return null;
    return buildTripViewModel(tripId, events);
  }, [tripId, events]);

  const liveReportTrip = useMemo(() => {
    if (!tripId || !liveVm) return null;
    return buildReportTripFromAppEvents({
      tripId,
      events,
      dayRuns: liveVm.dayRuns,
    });
  }, [tripId, events, liveVm]);

  const liveMetricsList = useMemo(
    () => (liveReportTrip ? computeTripDayMetrics(liveReportTrip, { currentTs: metricsNowIso }) : []),
    [liveReportTrip, metricsNowIso],
  );

  const activeDayMetrics = liveMetricsList[liveMetricsList.length - 1] ?? null;
  const liveDrive = useMemo(() => computeLiveDriveStatus(events, metricsNowIso), [events, metricsNowIso]);

  // Derive "driving segments" for the user request
  const drivingSegments = useMemo(() => {
    if (!liveVm) return [];
    // Extract drive time between major events (rest/break)
    // This is a simplified version, ideally we'd use reportLogic or metrics
    return liveVm.timeline.filter(item => item.title === '運転');
  }, [liveVm]);

  return {
    now,
    liveVm,
    liveReportTrip,
    activeDayMetrics,
    liveDrive,
    drivingSegments,
  };
}
