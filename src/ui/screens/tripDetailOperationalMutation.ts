export type TripDetailOperationalMutationDependencies<T> = {
  mutate: () => Promise<T>;
  reload: () => Promise<unknown>;
  requestRouteTrackingSync: () => void;
};

/**
 * Operational edits can change whether native route capture must run right now.
 * Commit first, reload the committed screen state, then wake the supervisor.
 * If reloading fails after commit, still wake tracking so native state is not
 * left stale until the periodic reconciliation.
 */
export async function commitTripDetailOperationalMutation<T>(
  dependencies: TripDetailOperationalMutationDependencies<T>,
): Promise<T> {
  const result = await dependencies.mutate();
  try {
    await dependencies.reload();
  } finally {
    dependencies.requestRouteTrackingSync();
  }
  return result;
}
