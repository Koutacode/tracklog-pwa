import type { DeletedEventTombstone } from '../db/db';
import type { Trip, TripEvent } from './reportTypes';
import type { AppEvent } from './types';
import { hasNewPendingReportSourceMutation, readReportSourceEvents } from './reportSourceEvents';
import { mergeIcMetadata, sameIcMetadata } from './icMetadata';

const SESSION_KEYS = ['expresswaySessionId', 'restSessionId', 'breakSessionId', 'loadSessionId', 'unloadSessionId', 'ferrySessionId', 'waitSessionId', 'workSessionId'];
const HIGHWAY_TYPES = new Set(['expressway', 'expressway_start', 'expressway_end']);

function sameTime(a: { ts: string }, b: { ts: string }) {
  return Number.isFinite(Date.parse(a.ts)) && Date.parse(a.ts) === Date.parse(b.ts);
}

function sameSession(saved: TripEvent, current: { type: string; extras?: Record<string, unknown> }) {
  return saved.type === current.type && SESSION_KEYS.some(key => (
    typeof saved.extras?.[key] === 'string' && !!saved.extras[key]
    && saved.extras[key] === current.extras?.[key]
  ));
}

function content(event: TripEvent | AppEvent) {
  const details = event as TripEvent;
  return JSON.stringify({ type: event.type, address: event.address, customer: details.customer,
    volume: details.volume, memo: details.memo, extras: event.extras });
}

/** Missing source rows are not permission to discard saved report evidence. */
export function canAutomaticallyReplaceReportSnapshot(
  saved: Trip,
  incoming: Trip,
  canonical: readonly AppEvent[],
  deletions: readonly DeletedEventTombstone[],
): boolean {
  const nextEvents = incoming.days.flatMap(day => day.events);
  const sourceEvents = readReportSourceEvents(saved);
  const updatedAt = Date.parse(saved.localUpdatedAt ?? saved.createdAt);
  return saved.days.flatMap(day => day.events).every(event => {
    const exact = nextEvents.filter(next => next.type === event.type && sameTime(next, event));
    const matched = exact.length ? exact : nextEvents.filter(next => sameSession(event, next));
    if (matched.length === 1) {
      if (HIGHWAY_TYPES.has(event.type) && typeof event.extras?.icName === 'string' && event.extras.icName.trim()) {
        // The read projection already checked whether a new IC has evidence to
        // replace this value. An older/partial writer must not undo it.
        return matched[0].extras?.icName === event.extras.icName
          && sameIcMetadata(mergeIcMetadata(event.extras, matched[0].extras), matched[0].extras);
      }
      return true;
    }
    if (deletions.some(deleted => deleted.eventType === event.type
      && !!deleted.eventTs && Date.parse(deleted.eventTs) === Date.parse(event.ts))) return true;
    const source = canonical.filter(current => (
      (current.type === event.type && sameTime(current, event)) || sameSession(event, current)
    ));
    if (source.length === 1) return true; // A complete source may legitimately change pairing projection.

    const identities = sourceEvents.filter(recorded => recorded.type === event.type && sameTime(recorded, event));
    if (identities.length > 0) {
      if (identities.length !== 1) return false;
      const editedById = canonical.filter(current => current.id === identities[0].id && current.syncStatus === 'pending'
        && (Date.parse(current.localUpdatedAt ?? '') > updatedAt || hasNewPendingReportSourceMutation(saved, event, current)));
      // Identity and a later write (or its direct predecessor) distinguish a
      // new edit from older pending rows and unrelated partially downloaded rows.
      return editedById.length === 1 && nextEvents.some(next => (
        next.type === editedById[0].type && sameTime(next, editedById[0])
      ));
    }

    // Legacy report events have no source ID. Allow an unambiguous pending
    // timestamp/type edit only with a later local write and matching content
    // or the same recorded time; otherwise retain the older complete report.
    const edited = canonical.filter(current => current.syncStatus === 'pending'
      && Number.isFinite(updatedAt) && Date.parse(current.localUpdatedAt ?? '') > updatedAt
      && ((current.type !== event.type && sameTime(current, event)) || content(current) === content(event)));
    return edited.length === 1 && nextEvents.some(next => next.type === edited[0].type && sameTime(next, edited[0]));
  });
}
