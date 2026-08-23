import type { AppEvent } from '../domain/types';
import { getOpenBreakToRestThresholdTs } from '../domain/metrics';
import { resolveBreakToRestRoutePauseAt } from '../domain/breakToRestConfirmation';
import {
  EXPRESSWAY_TOGGLE_DEFINITION,
  PERSISTED_BASIC_TOGGLE_DEFINITIONS,
  findOpenToggleStart,
} from '../domain/togglePairing';
import type {
  NativeResidentExpresswayConfig,
  NativeResidentLocationTrackingIntent,
} from './nativeResidentLocation';

const [REST_TOGGLE_DEFINITION, , , , FERRY_TOGGLE_DEFINITION] =
  PERSISTED_BASIC_TOGGLE_DEFINITIONS;

export function buildNativeFastTrackingIntent(input: {
  tripId: string | null;
  events: readonly AppEvent[];
  expresswayConfig: NativeResidentExpresswayConfig;
  breakConfirmationStatus: 'pending' | 'approved' | 'declined' | null;
}): NativeResidentLocationTrackingIntent {
  const tripId = input.tripId?.trim() ?? '';
  if (!tripId) {
    return {
      approved: true,
      setupComplete: true,
      activeTripId: null,
      expresswayOpen: false,
      expresswayConfig: input.expresswayConfig,
      routePauseAt: null,
    };
  }
  const hasOpenRest = findOpenToggleStart(input.events, REST_TOGGLE_DEFINITION) !== null;
  const hasOpenFerry = findOpenToggleStart(input.events, FERRY_TOGGLE_DEFINITION) !== null;
  const expresswayOpen = findOpenToggleStart(
    input.events,
    EXPRESSWAY_TOGGLE_DEFINITION,
  ) !== null;
  const breakThreshold = getOpenBreakToRestThresholdTs(input.events);
  return {
    // The native fast method intentionally ignores these enrollment fields; keeping them in this
    // shared shape preserves compatibility with the full reconcile request.
    approved: true,
    setupComplete: true,
    activeTripId: hasOpenRest || hasOpenFerry ? null : tripId,
    expresswayOpen,
    expresswayConfig: input.expresswayConfig,
    routePauseAt: hasOpenRest || hasOpenFerry
      ? null
      : resolveBreakToRestRoutePauseAt(
        breakThreshold,
        input.breakConfirmationStatus,
      ),
  };
}

/** Dexie must commit before the awaited native fast apply begins. */
export async function commitRouteTransitionThenApplyNativeState<T>(input: {
  commit: () => Promise<T>;
  applyNativeState: () => Promise<unknown>;
}): Promise<T> {
  const result = await input.commit();
  await input.applyNativeState();
  return result;
}
