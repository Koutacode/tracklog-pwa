import Dexie, { Table } from 'dexie';
import type { AppEvent, RoutePoint } from '../domain/types';
import type { Trip } from '../domain/reportTypes';
import { requestImmediateRemoteSync } from '../app/remoteSyncSignal';

export type MetaRow = {
  key: string;
  value: string;
  updatedAt: string;
};

/**
 * TrackLogDB encapsulates the IndexedDB schema using Dexie. It defines two
 * tables: events and meta. The events table stores all operation events
 * keyed by id with indexes on tripId, type and timestamp combinations for
 * efficient queries. The meta table stores key/value metadata such as the
 * currently active trip.
 */
export class TrackLogDB extends Dexie {
  events!: Table<AppEvent, string>;
  meta!: Table<MetaRow, string>;
  routePoints!: Table<RoutePoint, string>;
  reportTrips!: Table<Trip, string>;

  constructor() {
    super('tracklog_db');
    this.version(1).stores({
      events: 'id, tripId, type, ts, [tripId+ts], [tripId+type], [tripId+type+ts]',
      meta: 'key, updatedAt',
    });
    this.version(2).stores({
      events: 'id, tripId, type, ts, [tripId+ts], [tripId+type], [tripId+type+ts]',
      meta: 'key, updatedAt',
      routePoints: 'id, tripId, ts, [tripId+ts]',
    });
    this.version(3).stores({
      events: 'id, tripId, type, ts, [tripId+ts], [tripId+type], [tripId+type+ts]',
      meta: 'key, updatedAt',
      routePoints: 'id, tripId, ts, [tripId+ts]',
      reportTrips: 'id, createdAt',
    });
  }
}

export const db = new TrackLogDB();

function installRemoteSyncHooks() {
  const request = (reason: string) => {
    requestImmediateRemoteSync(reason);
  };

  db.events.hook('creating', () => {
    request('events-create');
  });
  db.events.hook('updating', () => {
    request('events-update');
    return undefined;
  });
  db.events.hook('deleting', () => {
    request('events-delete');
  });

  db.routePoints.hook('creating', () => {
    request('route-points-create');
  });
  db.routePoints.hook('updating', () => {
    request('route-points-update');
    return undefined;
  });
  db.routePoints.hook('deleting', () => {
    request('route-points-delete');
  });

  db.reportTrips.hook('creating', () => {
    request('report-create');
  });
  db.reportTrips.hook('updating', () => {
    request('report-update');
    return undefined;
  });
  db.reportTrips.hook('deleting', () => {
    request('report-delete');
  });
}

installRemoteSyncHooks();
