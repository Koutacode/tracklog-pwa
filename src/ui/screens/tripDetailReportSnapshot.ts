import { buildReportTripFromAppEvents } from '../../domain/reportLogic';
import type { Trip } from '../../domain/reportTypes';
import type { AppEvent, DayRun } from '../../domain/types';

export type TripDetailReportSnapshotSource = {
  tripId: string;
  events: AppEvent[];
  dayRuns: DayRun[];
  fallbackLabel: string;
};

export function buildTripDetailReportSnapshotSignature(
  source: Pick<TripDetailReportSnapshotSource, 'tripId' | 'events' | 'dayRuns'>,
): string {
  return JSON.stringify(source);
}

export function buildTripDetailReportSnapshot(
  source: TripDetailReportSnapshotSource,
  existingLabel: string | undefined,
  currentTs: string,
): Trip {
  return buildReportTripFromAppEvents({
    tripId: source.tripId,
    events: source.events,
    dayRuns: source.dayRuns,
    label: existingLabel || source.fallbackLabel,
    currentTs,
  });
}

type RetryHandle = unknown;

export type TripDetailReportSnapshotPersistenceDependencies = {
  loadExistingLabel: (tripId: string) => Promise<string | undefined>;
  // The writer must atomically respect report tombstones; a deleted report is
  // an intentional no-op, not a failure that should trigger a retry.
  saveSnapshot: (snapshot: Trip) => Promise<void>;
  now: () => string;
  scheduleRetry: (callback: () => void, delayMs: number) => RetryHandle;
  cancelRetry: (handle: RetryHandle) => void;
  onPermanentFailure: () => void;
};

type PendingSnapshot = {
  signature: string;
  source: TripDetailReportSnapshotSource;
  retryCount: number;
};

export function createTripDetailReportSnapshotPersistence(
  dependencies: TripDetailReportSnapshotPersistenceDependencies,
  options: { retryDelayMs?: number; maxRetries?: number } = {},
) {
  const retryDelayMs = options.retryDelayMs ?? 1500;
  const maxRetries = options.maxRetries ?? 1;
  let latest: PendingSnapshot | null = null;
  let persistedSignature: string | null = null;
  let processing = false;
  let retryHandle: RetryHandle | null = null;
  let disposed = false;

  const clearRetry = () => {
    if (retryHandle === null) return;
    dependencies.cancelRetry(retryHandle);
    retryHandle = null;
  };

  const drain = async (): Promise<void> => {
    if (disposed || processing || retryHandle !== null || !latest) return;
    if (latest.signature === persistedSignature) return;

    const candidate = latest;
    processing = true;
    try {
      const existingLabel = await dependencies.loadExistingLabel(candidate.source.tripId);
      if (disposed) return;
      const snapshot = buildTripDetailReportSnapshot(
        candidate.source,
        existingLabel,
        dependencies.now(),
      );
      await dependencies.saveSnapshot(snapshot);
      if (!disposed) persistedSignature = candidate.signature;
    } catch {
      const isStillLatest = latest?.signature === candidate.signature;
      if (!disposed && isStillLatest && candidate.retryCount < maxRetries) {
        latest = { ...candidate, retryCount: candidate.retryCount + 1 };
        retryHandle = dependencies.scheduleRetry(() => {
          retryHandle = null;
          void drain();
        }, retryDelayMs);
      } else if (!disposed && isStillLatest) {
        dependencies.onPermanentFailure();
      }
    } finally {
      processing = false;
      if (
        !disposed
        && retryHandle === null
        && latest
        && latest.signature !== persistedSignature
        && latest.signature !== candidate.signature
      ) {
        void drain();
      }
    }
  };

  return {
    enqueue(source: TripDetailReportSnapshotSource) {
      if (disposed) return;
      const signature = buildTripDetailReportSnapshotSignature(source);
      if (signature === persistedSignature || signature === latest?.signature) return;
      clearRetry();
      latest = { signature, source, retryCount: 0 };
      void drain();
    },
    dispose() {
      disposed = true;
      clearRetry();
      latest = null;
    },
  };
}
