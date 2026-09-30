import type { DeletedEventTombstone } from '../db/db';
import { getJstDateInfo } from './jst';
import type { AppEvent } from './types';
import type { DayRecord, Trip, TripEvent } from './reportTypes';

function isAppSnapshot(trip: Trip): boolean {
  try {
    const raw = JSON.parse(trip.rawJson);
    return raw?.recordType === 'app_trip_snapshot' && raw.sourceTripId === trip.id;
  } catch {
    return false;
  }
}

function isDeletedBoundary(event: TripEvent, deletions: readonly DeletedEventTombstone[]) {
  return deletions.some(deleted => deleted.eventType === event.type
    && !!deleted.eventTs && Date.parse(deleted.eventTs) === Date.parse(event.ts));
}

/** Overlay recorded boundaries on a derived report without rewriting a stored snapshot. */
export function projectRecordedReportBoundaries(
  trip: Trip,
  events: readonly AppEvent[],
  deletions: readonly DeletedEventTombstone[],
): Trip {
  if (!isAppSnapshot(trip)) return trip;
  const days = trip.days.map(day => ({
    ...day,
    events: day.events.filter(event => (
      (event.type !== 'trip_start' && event.type !== 'trip_end')
      || !isDeletedBoundary(event, deletions)
    )),
  }));
  const candidates = events.filter(event => (
    event.tripId === trip.id
    && (!event.ownerUserId || !trip.ownerUserId || event.ownerUserId === trip.ownerUserId)
    &&
    (event.type === 'trip_start' || event.type === 'trip_end')
    && Number.isFinite(Date.parse(event.ts))
    && !deletions.some(deleted => deleted.eventId === event.id)
  ));
  for (const type of ['trip_start', 'trip_end'] as const) {
    const recorded = candidates.filter(event => event.type === type)
      .sort((a, b) => type === 'trip_start'
        ? Date.parse(a.ts) - Date.parse(b.ts)
        : Date.parse(b.ts) - Date.parse(a.ts))[0];
    if (!recorded) continue; // An incomplete download must not remove saved evidence.
    const saved = days.flatMap(day => day.events).find(event => event.type === type);
    const newerRemote = !!recorded.ownerUserId && recorded.ownerUserId === trip.ownerUserId
      && recorded.remoteChangeSeq != null && trip.remoteChangeSeq != null
      && recorded.remoteChangeSeq > trip.remoteChangeSeq;
    if (saved && saved.ts !== recorded.ts && recorded.syncStatus === 'synced' && !newerRemote) continue;
    for (const day of days) day.events = day.events.filter(event => event.type !== type);
    const dateKey = getJstDateInfo(recorded.ts).dateKey;
    let day = days.find(candidate => candidate.dateKey === dateKey);
    if (!day) {
      // Add only the day proven by the boundary, never an inferred end time.
      day = {
        dayIndex: 0, dateKey, events: [], km: 0, odoStart: 0, odoEnd: 0,
        isFirstDay: false, tripStartMin: null, restStartMin: null, restPlace: '',
      } satisfies DayRecord;
      days.push(day);
    }
    day.events.push({
      type, ts: recorded.ts,
      ...(recorded.address ? { address: recorded.address } : {}),
      ...(recorded.extras ? { extras: { ...recorded.extras } } : {}),
    });
  }
  days.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  return {
    ...trip,
    days: days.map((day, index) => ({
      ...day,
      dayIndex: index + 1,
      isFirstDay: index === 0,
      events: [...day.events].sort((a, b) => a.ts.localeCompare(b.ts)),
    })),
  };
}
