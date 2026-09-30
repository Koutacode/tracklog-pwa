import { db } from './db';
import { requestRemoteSync } from '../app/remoteSyncSignal';
import type { Trip } from '../domain/reportTypes';
import { projectReportTripForView } from '../domain/reportLogic';
import { projectRecordedReportBoundaries } from '../domain/reportRecordedBoundaries';
import { projectReportResolvedIc } from '../domain/reportResolvedIc';
import { canAutomaticallyReplaceReportSnapshot } from '../domain/reportSnapshotCompleteness';

const REPORT_VIEW_EVENT_TYPES = ['trip_start', 'trip_end', 'expressway_start', 'expressway_end', 'expressway'];

export async function saveReportTrip(trip: Trip): Promise<void> {
  await db.transaction('rw', db.reportTrips, db.deletedReportTombstones, async () => {
    const tombstone = await db.deletedReportTombstones.get(trip.id);
    await db.reportTrips.put({
      ...trip,
      ...(tombstone?.remoteChangeSeq
        ? { restoreFromChangeSeq: tombstone.remoteChangeSeq }
        : {}),
    });
    await db.deletedReportTombstones.delete(trip.id);
  });
  requestRemoteSync('report-save');
}

/** Refresh derived report data without undoing a user's report deletion. */
export async function saveReportTripSnapshot(trip: Trip): Promise<void> {
  const saved = await db.transaction('rw', db.reportTrips, db.events, db.deletedReportTombstones, db.deletedEventTombstones, async () => {
    // Keep this check in the write transaction so a concurrent deletion cannot
    // land between the check and the snapshot write.
    if (await db.deletedReportTombstones.get(trip.id)) return false;
    const existing = await db.reportTrips.get(trip.id);
    if (existing) {
      const [boundaries, deletions] = await Promise.all([
        db.events.where('tripId').equals(trip.id).toArray(),
        db.deletedEventTombstones.where('tripId').equals(trip.id).toArray(),
      ]);
      const protectedView = projectReportResolvedIc(projectRecordedReportBoundaries(existing, boundaries, deletions), boundaries);
      const protectedEnd = protectedView.days.flatMap(day => day.events).find(event => event.type === 'trip_end');
      const incomingEnd = trip.days.flatMap(day => day.events).find(event => event.type === 'trip_end');
      if ((protectedEnd && protectedEnd.ts !== incomingEnd?.ts)
        || (incomingEnd && deletions.some(deleted => deleted.eventType === 'trip_end'
          && !!deleted.eventTs && Date.parse(deleted.eventTs) === Date.parse(incomingEnd.ts)))) {
        // A partial/older sync is not evidence that a completed trip was
        // reopened or its recorded end changed. A newer local/remote boundary
        // or an explicit matching deletion must justify an automatic refresh.
        return false;
      }
      if (!canAutomaticallyReplaceReportSnapshot(protectedView, trip, boundaries, deletions)) return false;
    }
    await db.reportTrips.put(existing ? {
      ...existing,
      ...trip,
      label: existing.label || trip.label,
      jobs: existing.jobs,
      createdAt: existing.createdAt,
    } : trip);
    return true;
  });
  if (saved) requestRemoteSync('report-snapshot-save');
}

export async function getReportTrip(id: string): Promise<Trip | undefined> {
  return db.transaction('r', db.reportTrips, db.events, db.deletedEventTombstones, async () => {
    const trip = await db.reportTrips.get(id);
    if (!trip) return undefined;
    const [events, deletions] = await Promise.all([
      db.events.where('[tripId+type]').anyOf(REPORT_VIEW_EVENT_TYPES.map(type => [id, type])).toArray(),
      db.deletedEventTombstones.where('tripId').equals(id).toArray(),
    ]);
    return projectReportTripForView(projectReportResolvedIc(projectRecordedReportBoundaries(trip, events, deletions), events));
  });
}

export async function listReportTrips(): Promise<Trip[]> {
  return db.transaction('r', db.reportTrips, db.events, db.deletedEventTombstones, async () => {
    const trips = await db.reportTrips.orderBy('createdAt').reverse().toArray();
    if (trips.length === 0) return [];
    const [events, deletions] = await Promise.all([
      db.events.where('[tripId+type]').anyOf(trips.flatMap(trip => (
        REPORT_VIEW_EVENT_TYPES.map(type => [trip.id, type])
      ))).toArray(),
      db.deletedEventTombstones.where('tripId').anyOf(trips.map(trip => trip.id)).toArray(),
    ]);
    return trips.map(trip => {
      const recorded = events.filter(event => event.tripId === trip.id);
      return projectReportTripForView(projectReportResolvedIc(projectRecordedReportBoundaries(
        trip, recorded, deletions.filter(deleted => deleted.tripId === trip.id),
      ), recorded));
    });
  });
}

export async function deleteReportTrip(id: string): Promise<void> {
  const deletedAt = new Date().toISOString();
  await db.transaction('rw', db.reportTrips, db.deletedReportTombstones, async () => {
    const report = await db.reportTrips.get(id);
    await db.deletedReportTombstones.put({
      tripId: id,
      deletedAt,
      reason: 'user_deleted',
      remoteRevision: report?.remoteRevision,
      remoteChangeSeq: report?.remoteChangeSeq,
      ownerUserId: report?.ownerUserId,
      deviceId: report?.originDeviceId,
    });
    await db.reportTrips.delete(id);
  });
  requestRemoteSync('report-delete');
}
