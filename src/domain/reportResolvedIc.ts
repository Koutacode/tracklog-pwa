import type { AppEvent } from './types';
import type { Trip, TripEvent } from './reportTypes';
import { hasNewPendingReportSourceMutation } from './reportSourceEvents';

const EXPRESSWAY_TYPES = new Set(['expressway', 'expressway_start', 'expressway_end']);
const IC_FIELDS = [
  'icName', 'icDistanceM', 'icResolveStatus', 'icResolveAlgorithmVersion',
  'icResolvedManually', 'icResolveManualUpdatedAt', 'icResolveGeoSource',
  'icResolveGeoOffsetSeconds', 'icResolveRetryCount', 'icResolveNextRetryAt',
  'icResolveLastAttemptAt', 'icResolveError',
] as const;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isAppSnapshot(trip: Trip): boolean {
  try {
    const raw = JSON.parse(trip.rawJson);
    return raw?.recordType === 'app_trip_snapshot' && raw.sourceTripId === trip.id;
  } catch {
    return false;
  }
}

function sameSession(left: TripEvent, right: AppEvent): boolean {
  const saved = text(left.extras?.expresswaySessionId);
  const current = text(right.extras?.expresswaySessionId);
  return !saved || !current || saved === current;
}

function mayReplaceSavedIc(saved: TripEvent, current: AppEvent, trip: Trip): boolean {
  const newerRemote = !!current.ownerUserId && current.ownerUserId === trip.ownerUserId
    && current.remoteChangeSeq != null && trip.remoteChangeSeq != null
    && current.remoteChangeSeq > trip.remoteChangeSeq;
  const savedLocalAt = Date.parse(trip.localUpdatedAt ?? '');
  const currentLocalAt = Date.parse(current.localUpdatedAt ?? '');
  const newerLocal = (Number.isFinite(savedLocalAt) && Number.isFinite(currentLocalAt)
    && currentLocalAt > savedLocalAt) || hasNewPendingReportSourceMutation(trip, saved, current);
  if (saved.extras?.icResolvedManually === true) {
    const savedAt = Date.parse(text(saved.extras.icResolveManualUpdatedAt) ?? '');
    const currentAt = Date.parse(text(current.extras?.icResolveManualUpdatedAt) ?? '');
    const sameManualValue = current.extras?.icResolvedManually === true
      && text(current.extras.icName) === text(saved.extras.icName)
      && (!Number.isFinite(savedAt) || (Number.isFinite(currentAt) && currentAt >= savedAt));
    const newerManual = current.extras?.icResolvedManually === true
      && Number.isFinite(currentAt) && Number.isFinite(savedAt) && currentAt > savedAt;
    // An incomplete/stale sync can contain the pre-edit automatic IC. Keep the
    // report's manual correction unless a newer mutation is actually proven.
    if (!sameManualValue && !newerManual && !newerRemote && !newerLocal) return false;
  } else if (
    text(saved.extras?.icName)
    && (saved.extras?.icResolveStatus == null || saved.extras.icResolveStatus === 'resolved')
    && text(saved.extras?.icName) !== text(current.extras?.icName)
    && !newerRemote && !newerLocal
  ) {
    // Same-algorithm canonical rows may also be stale after partial download.
    // Existing resolved names need mutation evidence before replacement.
    return false;
  }
  const savedVersion = Number(saved.extras?.icResolveAlgorithmVersion ?? 0);
  const currentVersion = Number(current.extras?.icResolveAlgorithmVersion ?? 0);
  const stableSavedName = text(saved.extras?.icName)
    && (saved.extras?.icResolvedManually === true
      || saved.extras?.icResolveStatus == null || saved.extras.icResolveStatus === 'resolved');
  return !stableSavedName || current.extras?.icResolvedManually === true || currentVersion >= savedVersion;
}

/**
 * Refresh resolved IC metadata in an app-generated report from uniquely
 * matching local event rows. This is a read projection: no saved report, raw
 * JSON, event timestamp, address, location, or unrelated extras are rewritten.
 */
export function projectReportResolvedIc(trip: Trip, canonicalEvents: readonly AppEvent[]): Trip {
  if (!isAppSnapshot(trip)) return trip;
  const candidates = canonicalEvents.filter(event => (
    event.tripId === trip.id && EXPRESSWAY_TYPES.has(event.type)
    && (!event.ownerUserId || !trip.ownerUserId || event.ownerUserId === trip.ownerUserId)
  ));
  let changed = false;
  const days = trip.days.map(day => ({
    ...day,
    events: day.events.map(saved => {
      if (!EXPRESSWAY_TYPES.has(saved.type)) return saved;
      const matching = candidates.filter(current => current.type === saved.type && sameSession(saved, current));
      const savedMs = Date.parse(saved.ts);
      let exact = matching.filter(current => Number.isFinite(savedMs) && Date.parse(current.ts) === savedMs);
      if (exact.length === 0) {
        const session = text(saved.extras?.expresswaySessionId);
        exact = session ? matching.filter(current => text(current.extras?.expresswaySessionId) === session) : [];
      }
      if (exact.length !== 1) return saved; // Missing/ambiguous rows cannot alter saved evidence.
      const current = exact[0];
      const status = current.extras?.icResolveStatus;
      if (!text(current.extras?.icName) || (status != null && status !== 'resolved')) return saved;
      if (!mayReplaceSavedIc(saved, current, trip)) return saved;
      const extras = { ...saved.extras };
      for (const key of IC_FIELDS) {
        delete extras[key];
        if (current.extras && Object.prototype.hasOwnProperty.call(current.extras, key)) {
          extras[key] = current.extras[key];
        }
      }
      extras.icResolveStatus = 'resolved';
      if (JSON.stringify(extras) === JSON.stringify(saved.extras)) return saved;
      changed = true;
      return { ...saved, extras };
    }),
  }));
  return changed ? { ...trip, days } : trip;
}
