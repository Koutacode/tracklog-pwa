import { db } from './db';
import { requestRemoteSync } from '../app/remoteSyncSignal';
import type { Trip } from '../domain/reportTypes';
import { projectReportTripForView } from '../domain/reportLogic';

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

export async function getReportTrip(id: string): Promise<Trip | undefined> {
  const trip = await db.reportTrips.get(id);
  return trip ? projectReportTripForView(trip) : undefined;
}

export async function listReportTrips(): Promise<Trip[]> {
  const trips = await db.reportTrips.orderBy('createdAt').reverse().toArray();
  return trips.map(projectReportTripForView);
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
