export function shouldShowDeviceSetupGate(input: {
  approved: boolean;
  setupReady: boolean;
  activeTripKnown: boolean;
  activeTripId: string | null;
}): boolean {
  return input.approved
    && !input.setupReady
    && input.activeTripKnown
    && !input.activeTripId;
}

export function didActiveTripEnd(input: {
  previousKnown: boolean;
  previousTripId: string | null;
  currentKnown: boolean;
  currentTripId: string | null;
}): boolean {
  return input.previousKnown
    && !!input.previousTripId
    && input.currentKnown
    && !input.currentTripId;
}
