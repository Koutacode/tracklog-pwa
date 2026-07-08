import { deleteTrip } from '../db/repositories';
import { driverSupabase, SUPABASE_CONFIGURED } from './supabase';
import { deleteOwnTracklogTripViaFunction } from './tracklogPrivilegedApi';

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
      try {
        await deleteOwnTracklogTripViaFunction(normalizedTripId);
      } catch (error: any) {
        throw new Error(`クラウド履歴の削除に失敗しました: ${error?.message ?? error}`);
      }
    }
  }

  await deleteTrip(normalizedTripId);
}
