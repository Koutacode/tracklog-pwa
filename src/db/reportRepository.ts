import { db } from './db';
import type { Trip } from '../domain/reportTypes';

export async function saveReportTrip(trip: Trip): Promise<void> {
  await db.reportTrips.put(trip);
}

export async function getReportTrip(id: string): Promise<Trip | undefined> {
  return db.reportTrips.get(id);
}

export async function listReportTrips(): Promise<Trip[]> {
  return db.reportTrips.orderBy('createdAt').reverse().toArray();
}

export async function deleteReportTrip(id: string): Promise<void> {
  await db.reportTrips.delete(id);
}

export async function getReportTripsByMonth(month: string): Promise<Trip[]> {
  const all = await db.reportTrips.toArray();
  return all.filter(t => t.days.some(d => d.dateKey.startsWith(month)));
}
