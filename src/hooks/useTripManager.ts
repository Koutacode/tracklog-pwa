import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getActiveTripId,
  getEventsByTripId,
  startTrip as dbStartTrip,
  endTrip as dbEndTrip,
  startRest as dbStartRest,
  endRest as dbEndRest,
  startLoad as dbStartLoad,
  endLoad as dbEndLoad,
  startUnload as dbStartUnload,
  endUnload as dbEndUnload,
  startBreak as dbStartBreak,
  endBreak as dbEndBreak,
  addRefuel as dbAddRefuel,
  addBoarding as dbAddBoarding,
  addDisembark as dbAddDisembark,
  addPointMark as dbAddPointMark,
  startExpressway as dbStartExpressway,
  endExpressway as dbEndExpressway,
  backfillMissingAddresses,
  clearPendingExpresswayEndDecision,
  reconcileBreakToRestThreshold,
} from '../db/repositories';
import { getGeoWithAddress } from '../services/geo';
import {
  enqueueExpresswayIcResolution,
  retryPendingExpresswayIcResolutions,
} from '../services/expresswayIcResolution';
import { cancelNativeExpresswayEndPrompt } from '../services/nativeExpresswayPrompt';
import type { AppEvent } from '../domain/types';
import { requestRouteTrackingSync } from '../app/routeTrackingSignal';

export type TripOperation =
  | 'trip-start'
  | 'trip-end'
  | 'rest-start'
  | 'rest-end'
  | 'load-start'
  | 'load-end'
  | 'unload-start'
  | 'unload-end'
  | 'break-start'
  | 'break-end'
  | 'expressway-start'
  | 'expressway-end'
  | 'refuel'
  | 'ferry-boarding'
  | 'ferry-disembark'
  | 'point-mark';

function getOperationErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return '操作に失敗しました';
}

export function useTripManager() {
  const [tripId, setTripId] = useState<string | null>(null);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [geoStatus, setGeoStatus] = useState<{ lat: number; lng: number; accuracy?: number; at: string; address?: string } | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [activeOperation, setActiveOperation] = useState<TripOperation | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const operationLockRef = useRef(false);

  const runOperation = useCallback(async <T,>(
    operation: TripOperation,
    task: () => Promise<T>,
  ): Promise<T | undefined> => {
    if (operationLockRef.current) return undefined;
    operationLockRef.current = true;
    setActiveOperation(operation);
    setOperationError(null);
    try {
      return await task();
    } catch (error) {
      setOperationError(getOperationErrorMessage(error));
      return undefined;
    } finally {
      operationLockRef.current = false;
      setActiveOperation(null);
    }
  }, []);

  const clearOperationError = useCallback(() => setOperationError(null), []);
  
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const active = await getActiveTripId();
      if (active) {
        const transitioned = await reconcileBreakToRestThreshold({ tripId: active });
        if (transitioned) requestRouteTrackingSync();
        const ev = await getEventsByTripId(active);
        setTripId(active);
        setEvents(ev);
      } else {
        setTripId(null);
        setEvents([]);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const captureGeoOnce = useCallback(async () => {
    try {
      setGeoError(null);
      const { geo, address } = await getGeoWithAddress();
      if (geo) {
        setGeoStatus({
          lat: geo.lat,
          lng: geo.lng,
          accuracy: geo.accuracy,
          at: new Date().toISOString(),
          address,
        });
      } else {
        setGeoError('位置情報が取得できませんでした。');
      }
      return { geo, address };
    } catch (e: any) {
      setGeoError(e?.message ?? '位置情報の取得に失敗しました');
      return { geo: undefined, address: undefined };
    }
  }, []);

  // Event handlers
  const handleStartTrip = useCallback(async (odoKm: number) => {
    return runOperation('trip-start', async () => {
      const occurredAt = new Date().toISOString();
      const { geo, address } = await captureGeoOnce();
      const { tripId: newTripId } = await dbStartTrip({ odoKm, geo, address, occurredAt });
      setTripId(newTripId);
      requestRouteTrackingSync();
      await refresh();
      return newTripId;
    });
  }, [captureGeoOnce, refresh, runOperation]);

  const handleEndTrip = useCallback(async (odoEndKm: number) => {
    if (!tripId) return;
    return runOperation('trip-end', async () => {
      const occurredAt = new Date().toISOString();
      const { geo, address } = await captureGeoOnce();
      const { event } = await dbEndTrip({ tripId, odoEndKm, geo, address, occurredAt });
      requestRouteTrackingSync();
      await refresh();
      return event;
    });
  }, [captureGeoOnce, refresh, runOperation, tripId]);

  const handleStartRest = useCallback(async (odoKm: number) => {
    if (!tripId) return;
    return runOperation('rest-start', async () => {
      const occurredAt = new Date().toISOString();
      const { geo, address } = await captureGeoOnce();
      const result = await dbStartRest({ tripId, odoKm, geo, address, occurredAt });
      requestRouteTrackingSync();
      await refresh();
      return result;
    });
  }, [captureGeoOnce, refresh, runOperation, tripId]);

  const handleEndRest = useCallback(async (restSessionId: string) => {
    if (!tripId) return;
    return runOperation('rest-end', async () => {
      const occurredAt = new Date().toISOString();
      const { geo, address } = await captureGeoOnce();
      const result = await dbEndRest({ tripId, restSessionId, dayClose: false, geo, address, occurredAt });
      requestRouteTrackingSync();
      await refresh();
      return result;
    });
  }, [captureGeoOnce, refresh, runOperation, tripId]);

  const handleToggleEvent = useCallback(async (
    type: 'load' | 'unload' | 'break' | 'expressway',
    action: 'start' | 'end',
  ) => {
    if (!tripId) return;
    return runOperation(`${type}-${action}` as TripOperation, async () => {
      const occurredAt = new Date().toISOString();
      const { geo, address } = await captureGeoOnce();

      if (type === 'load') {
        action === 'start'
          ? await dbStartLoad({ tripId, geo, address, occurredAt })
          : await dbEndLoad({ tripId, geo, address, occurredAt });
      } else if (type === 'unload') {
        action === 'start'
          ? await dbStartUnload({ tripId, geo, address, occurredAt })
          : await dbEndUnload({ tripId, geo, address, occurredAt });
      } else if (type === 'break') {
        action === 'start'
          ? await dbStartBreak({ tripId, geo, address, occurredAt })
          : await dbEndBreak({ tripId, geo, address, occurredAt });
      } else if (type === 'expressway') {
        if (action === 'start') {
          const { eventId } = await dbStartExpressway({ tripId, geo, address, occurredAt });
          enqueueExpresswayIcResolution({ eventId, geo });
        } else {
          const { eventId } = await dbEndExpressway({ tripId, geo, address, occurredAt });
          enqueueExpresswayIcResolution({ eventId, geo });
        }
        await cancelNativeExpresswayEndPrompt(tripId);
        await clearPendingExpresswayEndDecision(tripId);
      }
      if (type === 'break') requestRouteTrackingSync();
      await refresh();
      return true;
    });
  }, [captureGeoOnce, refresh, runOperation, tripId]);

  const handleAddRefuel = useCallback(async (liters: number) => {
    if (!tripId) return;
    return runOperation('refuel', async () => {
      const occurredAt = new Date().toISOString();
      const { geo, address } = await captureGeoOnce();
      await dbAddRefuel({ tripId, liters, geo, address, occurredAt });
      await refresh();
      return true;
    });
  }, [captureGeoOnce, refresh, runOperation, tripId]);

  const handleAddFerry = useCallback(async (action: 'boarding' | 'disembark') => {
    if (!tripId) return;
    return runOperation(`ferry-${action}`, async () => {
      const occurredAt = new Date().toISOString();
      const { geo, address } = await captureGeoOnce();
      if (action === 'boarding') {
        await dbAddBoarding({ tripId, geo, address, occurredAt });
      } else {
        await dbAddDisembark({ tripId, geo, address, occurredAt });
      }
      requestRouteTrackingSync();
      await refresh();
      return true;
    });
  }, [captureGeoOnce, refresh, runOperation, tripId]);

  const handleAddPointMark = useCallback(async (label: string) => {
    if (!tripId) return;
    return runOperation('point-mark', async () => {
      const occurredAt = new Date().toISOString();
      const { geo, address } = await captureGeoOnce();
      await dbAddPointMark({ tripId, geo, address, label, occurredAt });
      await refresh();
      return true;
    });
  }, [captureGeoOnce, refresh, runOperation, tripId]);

  // Lifecycle
  useEffect(() => {
    refresh();
    captureGeoOnce();
  }, [refresh, captureGeoOnce]);

  // Backfill logic
  useEffect(() => {
    if (!tripId) return;
    const runBackfill = () => {
      Promise.all([
        backfillMissingAddresses(12, 1),
        retryPendingExpresswayIcResolutions(4),
      ]).then(results => {
        if (results.some(Boolean)) refresh();
      }).catch(() => {
        // Network/API failures are retried by the next backfill cycle.
      });
    };
    runBackfill();
    const id = setInterval(runBackfill, 20000);
    return () => clearInterval(id);
  }, [tripId, refresh]);

  return {
    tripId,
    events,
    loading,
    geoStatus,
    geoError,
    activeOperation,
    operationInProgress: activeOperation != null,
    operationError,
    clearOperationError,
    refresh,
    captureGeoOnce,
    handleStartTrip,
    handleEndTrip,
    handleStartRest,
    handleEndRest,
    handleToggleEvent,
    handleAddRefuel,
    handleAddFerry,
    handleAddPointMark,
  };
}
