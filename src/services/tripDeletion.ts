import { deleteTrip } from '../db/repositories';
import { db } from '../db/db';
import { getDriverIdentity } from './remoteAuth';

function normalizeTripId(tripId: string) {
  return tripId.trim();
}

export async function deleteTripEverywhere(tripId: string): Promise<void> {
  const normalizedTripId = normalizeTripId(tripId);
  if (!normalizedTripId) {
    throw new Error('削除する運行IDが不明です');
  }

  const identity = await getDriverIdentity();
  await db.deletedTripTombstones.put({
    tripId: normalizedTripId,
    deviceId: identity.deviceId ?? undefined,
    deletedAt: new Date().toISOString(),
  });
  await deleteTrip(normalizedTripId);
}
