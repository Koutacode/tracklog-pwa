import { deleteTrip } from '../db/repositories';
import { driverSupabase, SUPABASE_CONFIGURED } from './supabase';

function normalizeTripId(tripId: string) {
  return tripId.trim();
}

export async function deleteTripEverywhere(tripId: string): Promise<void> {
  const normalizedTripId = normalizeTripId(tripId);
  if (!normalizedTripId) {
    throw new Error('削除する運行IDが不明です');
  }

  if (SUPABASE_CONFIGURED && driverSupabase) {
    const { data } = await driverSupabase.auth.getSession();
    if (data.session) {
      const { error } = await driverSupabase.rpc('delete_tracklog_own_trip', {
        _trip_id: normalizedTripId,
      });
      if (error) {
        throw new Error(`クラウド履歴の削除に失敗しました: ${error.message}`);
      }
    }
  }

  await deleteTrip(normalizedTripId);
}
