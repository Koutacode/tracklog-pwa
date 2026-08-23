import { Capacitor } from '@capacitor/core';
import {
  getActiveTripId,
  getAutoExpresswayConfig,
  getBreakToRestConfirmationState,
  getEventsByTripId,
} from '../db/repositories';
import { getOpenBreakToRestThresholdTs } from '../domain/metrics';
import { applyNativeResidentLocationTrackingState } from './nativeResidentLocation';
import {
  buildNativeFastTrackingIntent,
  commitRouteTransitionThenApplyNativeState,
} from './nativeTrackingFastApplyPolicy';

function isAndroidNative() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export async function applyCurrentNativeTrackingStateFast(): Promise<void> {
  if (!isAndroidNative()) return;
  const [tripId, expresswayConfig] = await Promise.all([
    getActiveTripId(),
    getAutoExpresswayConfig(),
  ]);
  const events = tripId ? await getEventsByTripId(tripId) : [];
  const breakThreshold = getOpenBreakToRestThresholdTs(events);
  const confirmation = tripId && breakThreshold
    ? await getBreakToRestConfirmationState({ tripId })
    : null;
  const intent = buildNativeFastTrackingIntent({
    tripId,
    events,
    expresswayConfig,
    breakConfirmationStatus: confirmation?.status ?? null,
  });
  await applyNativeResidentLocationTrackingState(intent);
}

export async function commitRouteTransitionWithNativeFastApply<T>(
  commit: () => Promise<T>,
): Promise<T> {
  return commitRouteTransitionThenApplyNativeState({
    commit,
    applyNativeState: applyCurrentNativeTrackingStateFast,
  });
}
