import { db } from './db';
import { requestRemoteSync } from '../app/remoteSyncSignal';
import type { Trip } from '../domain/reportTypes';

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
  return db.reportTrips.get(id);
}

export async function listReportTrips(): Promise<Trip[]> {
  return db.reportTrips.orderBy('createdAt').reverse().toArray();
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
