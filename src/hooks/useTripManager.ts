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
  updateExpresswayResolved,
  clearPendingExpresswayEndDecision,
} from '../db/repositories';
import { getGeoWithAddress } from '../services/geo';
import { resolveNearestIC } from '../services/icResolver';
import { cancelNativeExpresswayEndPrompt } from '../services/nativeExpresswayPrompt';
import type { AppEvent, Geo } from '../domain/types';

export function useTripManager() {
  const [tripId, setTripId] = useState<string | null>(null);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [geoStatus, setGeoStatus] = useState<{ lat: number; lng: number; accuracy?: number; at: string; address?: string } | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const active = await getActiveTripId();
      setTripId(active);
      if (active) {
        const ev = await getEventsByTripId(active);
        setEvents(ev);
      } else {
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
  const handleStartTrip = async (odoKm: number) => {
    setLoading(true);
    try {
      const { geo, address } = await captureGeoOnce();
      const { tripId: newTripId } = await dbStartTrip({ odoKm, geo, address });
      setTripId(newTripId);
      await refresh();
    } finally {
      setLoading(false);
    }
  };

  const handleEndTrip = async (odoEndKm: number) => {
    if (!tripId) return;
    setLoading(true);
    try {
      const { geo, address } = await captureGeoOnce();
      const { event } = await dbEndTrip({ tripId, odoEndKm, geo, address });
      await refresh();
      return event;
    } finally {
      setLoading(false);
    }
  };

  const handleStartRest = async (odoKm: number) => {
    if (!tripId) return;
    const { geo, address } = await captureGeoOnce();
    await dbStartRest({ tripId, odoKm, geo, address });
    await refresh();
  };

  const handleEndRest = async (restSessionId: string) => {
    if (!tripId) return;
    const { geo, address } = await captureGeoOnce();
    await dbEndRest({ tripId, restSessionId, dayClose: false, geo, address });
    await refresh();
  };

  const handleToggleEvent = async (type: 'load' | 'unload' | 'break' | 'expressway', action: 'start' | 'end') => {
    if (!tripId) return;
    const { geo, address } = await captureGeoOnce();
    
    if (type === 'load') {
      action === 'start' ? await dbStartLoad({ tripId, geo, address }) : await dbEndLoad({ tripId, geo, address });
    } else if (type === 'unload') {
      action === 'start' ? await dbStartUnload({ tripId, geo, address }) : await dbEndUnload({ tripId, geo, address });
    } else if (type === 'break') {
      action === 'start' ? await dbStartBreak({ tripId, geo, address }) : await dbEndBreak({ tripId, geo, address });
    } else if (type === 'expressway') {
      if (action === 'start') {
        const { eventId } = await dbStartExpressway({ tripId, geo, address });
        if (navigator.onLine && geo) {
          const result = await resolveNearestIC(geo.lat, geo.lng);
          if (result) {
            await updateExpresswayResolved({ eventId, status: 'resolved', icName: result.icName, icDistanceM: result.distanceM });
          }
        }
      } else {
        await dbEndExpressway({ tripId, geo, address });
      }
      await cancelNativeExpresswayEndPrompt(tripId);
      await clearPendingExpresswayEndDecision(tripId);
    }
    await refresh();
  };

  const handleAddRefuel = async (liters: number) => {
    if (!tripId) return;
    const { geo, address } = await captureGeoOnce();
    await dbAddRefuel({ tripId, liters, geo, address });
    await refresh();
  };

  const handleAddFerry = async (action: 'boarding' | 'disembark') => {
    if (!tripId) return;
    const { geo, address } = await captureGeoOnce();
    if (action === 'boarding') {
      await dbAddBoarding({ tripId, geo, address });
    } else {
      await dbAddDisembark({ tripId, geo, address });
    }
    await refresh();
  };

  const handleAddPointMark = async (label: string) => {
    if (!tripId) return;
    const { geo, address } = await captureGeoOnce();
    await dbAddPointMark({ tripId, geo, address, label });
    await refresh();
  };

  // Lifecycle
  useEffect(() => {
    refresh();
    captureGeoOnce();
  }, [refresh, captureGeoOnce]);

  // Backfill logic
  useEffect(() => {
    if (!tripId) return;
    const id = setInterval(() => {
      backfillMissingAddresses(12, 1).then(updated => {
        if (updated) refresh();
      });
    }, 20000);
    return () => clearInterval(id);
  }, [tripId, refresh]);

  return {
    tripId,
    events,
    loading,
    geoStatus,
    geoError,
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
