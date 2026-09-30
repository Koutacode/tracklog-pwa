import type { Trip, TripEvent } from './reportTypes';
import type { AppEvent } from './types';

type SourceEvent = { id: string; type: string; ts: string; syncMutationId?: string };

/** Optional identity metadata; legacy/imported reports retain their existing checks. */
export function readReportSourceEvents(saved: Trip): SourceEvent[] {
  try {
    const raw = JSON.parse(saved.rawJson);
    if (raw.recordType !== 'app_trip_snapshot' || raw.sourceTripId !== saved.id || !Array.isArray(raw.sourceEvents)) return [];
    return raw.sourceEvents.filter((event: unknown): event is SourceEvent => (
      !!event && typeof event === 'object' && 'id' in event && typeof event.id === 'string' && !!event.id
      && 'type' in event && typeof event.type === 'string'
      && 'ts' in event && typeof event.ts === 'string' && Number.isFinite(Date.parse(event.ts))
    ));
  } catch {
    return [];
  }
}

export function hasNewPendingReportSourceMutation(trip: Trip, saved: TripEvent, current: AppEvent): boolean {
  if (current.syncStatus !== 'pending' || !current.syncMutationId) return false;
  const sources = readReportSourceEvents(trip).filter(event => (
    event.type === saved.type && Date.parse(event.ts) === Date.parse(saved.ts)
  ));
  return sources.length === 1 && sources[0].id === current.id
    && typeof sources[0].syncMutationId === 'string' && !!sources[0].syncMutationId
    && sources[0].syncMutationId === current.previousSyncMutationId
    && sources[0].syncMutationId !== current.syncMutationId;
}
