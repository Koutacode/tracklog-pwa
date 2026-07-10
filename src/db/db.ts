import Dexie, { Table } from 'dexie';
import type { AppEvent, RoutePoint } from '../domain/types';
import type { Trip } from '../domain/reportTypes';
import { requestImmediateRemoteSync } from '../app/remoteSyncSignal';

export type MetaRow = {
  key: string;
  value: string;
  updatedAt: string;
};

export type DeletedEventTombstone = {
  eventId: string;
  tripId: string;
  eventType?: string;
  eventTs?: string;
  deletedAt: string;
  syncedAt?: string;
  remoteRevision?: number;
  remoteChangeSeq?: number;
  localRevision?: number;
  syncMutationId?: string;
  __remoteSyncApply?: boolean;
  ownerUserId?: string;
};

export type DeletedTripTombstone = {
  tripId: string;
  deviceId?: string;
  deletedAt: string;
  syncedAt?: string;
  remoteRevision?: number;
  remoteChangeSeq?: number;
  localRevision?: number;
  syncMutationId?: string;
  __remoteSyncApply?: boolean;
  ownerUserId?: string;
};

export type DeletedReportTombstone = {
  tripId: string;
  deviceId?: string;
  reason?: string;
  deletedAt: string;
  syncedAt?: string;
  remoteRevision?: number;
  remoteChangeSeq?: number;
  localRevision?: number;
  syncMutationId?: string;
  __remoteSyncApply?: boolean;
  ownerUserId?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

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
  deletedEventTombstones!: Table<DeletedEventTombstone, string>;
  deletedTripTombstones!: Table<DeletedTripTombstone, string>;
  deletedReportTombstones!: Table<DeletedReportTombstone, string>;

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
    this.version(4).stores({
      events: 'id, tripId, type, ts, [tripId+ts], [tripId+type], [tripId+type+ts]',
      meta: 'key, updatedAt',
      routePoints: 'id, tripId, ts, [tripId+ts]',
      reportTrips: 'id, createdAt',
      deletedEventTombstones: 'eventId, tripId, deletedAt',
    });
    this.version(5).stores({
      events: 'id, tripId, type, ts, syncStatus, localUpdatedAt, [tripId+ts], [tripId+type], [tripId+type+ts]',
      meta: 'key, updatedAt',
      routePoints: 'id, tripId, ts, updatedAt, syncStatus, [tripId+ts]',
      reportTrips: 'id, createdAt, syncStatus, localUpdatedAt',
      deletedEventTombstones: 'eventId, tripId, deletedAt, syncedAt',
      deletedTripTombstones: 'tripId, deletedAt, syncedAt',
      deletedReportTombstones: 'tripId, deletedAt, syncedAt',
    }).upgrade(async transaction => {
      const metaTable = transaction.table<MetaRow, string>('meta');
      const eventTable = transaction.table<AppEvent, string>('events');
      const routePointTable = transaction.table<RoutePoint, string>('routePoints');
      const reportTable = transaction.table<Trip, string>('reportTrips');
      const eventTombstoneTable = transaction.table<DeletedEventTombstone, string>('deletedEventTombstones');
      const watermark = (await metaTable.get('remoteRoutePointsUploadedThrough'))?.value ?? null;
      await eventTable.toCollection().modify(event => {
        if (event.syncStatus !== 'pending') return;
        event.localRevision = Math.max(1, event.localRevision ?? 1);
        event.syncMutationId = event.syncMutationId ?? newMutationId();
        event.localUpdatedAt = event.localUpdatedAt ?? nowIso();
      });
      await routePointTable.toCollection().modify(point => {
        if (!point.syncStatus) {
          const changedAt = point.updatedAt ?? point.ts;
          point.syncStatus = watermark && changedAt <= watermark ? 'synced' : 'pending';
        }
        if (point.syncStatus === 'pending') {
          point.localRevision = Math.max(1, point.localRevision ?? 1);
          point.syncMutationId = point.syncMutationId ?? newMutationId();
        }
      });
      await reportTable.toCollection().modify(report => {
        report.syncStatus = report.syncStatus ?? 'synced';
        if (report.syncStatus === 'pending') {
          report.localRevision = Math.max(1, report.localRevision ?? 1);
          report.syncMutationId = report.syncMutationId ?? newMutationId();
          report.localUpdatedAt = report.localUpdatedAt ?? nowIso();
        }
      });
      await eventTombstoneTable.toCollection().modify(tombstone => {
        if (tombstone.syncedAt) return;
        tombstone.localRevision = Math.max(1, tombstone.localRevision ?? 1);
        tombstone.syncMutationId = tombstone.syncMutationId ?? newMutationId();
      });
    });
  }
}

export const db = new TrackLogDB();

export function createSyncMutationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function newMutationId(): string {
  return createSyncMutationId();
}

function consumeRemoteMarker(value: { __remoteSyncApply?: boolean }) {
  if (!value.__remoteSyncApply) return false;
  delete value.__remoteSyncApply;
  return true;
}

function consumeRemoteUpdate(changes: Object): Record<string, unknown> | null {
  const typed = changes as Record<string, unknown>;
  if (typed.__remoteSyncApply !== true) return null;
  return { ...typed, __remoteSyncApply: undefined };
}

function installRemoteSyncHooks() {
  const request = (reason: string) => {
    requestImmediateRemoteSync(reason);
  };

  db.events.hook('creating', (_primKey, obj) => {
    if (consumeRemoteMarker(obj)) return;
    obj.syncStatus = 'pending';
    obj.localUpdatedAt = nowIso();
    obj.localRevision = Math.max(1, obj.localRevision ?? 1);
    obj.syncMutationId = obj.syncMutationId ?? newMutationId();
    request('events-create');
  });
  db.events.hook('updating', (changes, _primKey, obj) => {
    const remoteChanges = consumeRemoteUpdate(changes);
    if (remoteChanges) return remoteChanges;
    request('events-update');
    return {
      syncStatus: 'pending',
      localUpdatedAt: nowIso(),
      localRevision: (obj.localRevision ?? 0) + 1,
      syncMutationId: newMutationId(),
    };
  });
  db.events.hook('deleting', () => {
    request('events-delete');
  });

  db.routePoints.hook('creating', (_primKey, obj) => {
    if (consumeRemoteMarker(obj)) return;
    obj.updatedAt = obj.updatedAt ?? nowIso();
    obj.syncStatus = 'pending';
    obj.localRevision = Math.max(1, obj.localRevision ?? 1);
    obj.syncMutationId = obj.syncMutationId ?? newMutationId();
    request('route-points-create');
  });
  db.routePoints.hook('updating', (changes, _primKey, obj) => {
    const remoteChanges = consumeRemoteUpdate(changes);
    if (remoteChanges) return remoteChanges;
    request('route-points-update');
    return {
      updatedAt: nowIso(),
      syncStatus: 'pending',
      localRevision: (obj.localRevision ?? 0) + 1,
      syncMutationId: newMutationId(),
    };
  });
  db.routePoints.hook('deleting', () => {
    request('route-points-delete');
  });

  db.reportTrips.hook('creating', (_primKey, obj) => {
    if (consumeRemoteMarker(obj)) return;
    obj.syncStatus = 'pending';
    obj.localUpdatedAt = nowIso();
    obj.localRevision = Math.max(1, obj.localRevision ?? 1);
    obj.syncMutationId = obj.syncMutationId ?? newMutationId();
    request('report-create');
  });
  db.reportTrips.hook('updating', (changes, _primKey, obj) => {
    const remoteChanges = consumeRemoteUpdate(changes);
    if (remoteChanges) return remoteChanges;
    request('report-update');
    return {
      syncStatus: 'pending',
      localUpdatedAt: nowIso(),
      localRevision: (obj.localRevision ?? 0) + 1,
      syncMutationId: newMutationId(),
    };
  });
  db.reportTrips.hook('deleting', () => {
    request('report-delete');
  });

  db.deletedEventTombstones.hook('creating', (_primKey, obj) => {
    if (consumeRemoteMarker(obj)) return;
    obj.localRevision = Math.max(1, obj.localRevision ?? 1);
    obj.syncMutationId = obj.syncMutationId ?? newMutationId();
    request('event-tombstone-create');
  });
  db.deletedEventTombstones.hook('updating', (changes, _primKey, obj) => {
    const remoteChanges = consumeRemoteUpdate(changes);
    if (remoteChanges) return remoteChanges;
    request('event-tombstone-update');
    return { localRevision: (obj.localRevision ?? 0) + 1, syncMutationId: newMutationId() };
  });

  db.deletedTripTombstones.hook('creating', (_primKey, obj) => {
    if (consumeRemoteMarker(obj)) return;
    obj.localRevision = Math.max(1, obj.localRevision ?? 1);
    obj.syncMutationId = obj.syncMutationId ?? newMutationId();
    request('trip-tombstone-create');
  });
  db.deletedTripTombstones.hook('updating', (changes, _primKey, obj) => {
    const remoteChanges = consumeRemoteUpdate(changes);
    if (remoteChanges) return remoteChanges;
    request('trip-tombstone-update');
    return { localRevision: (obj.localRevision ?? 0) + 1, syncMutationId: newMutationId() };
  });

  db.deletedReportTombstones.hook('creating', (_primKey, obj) => {
    if (consumeRemoteMarker(obj)) return;
    obj.localRevision = Math.max(1, obj.localRevision ?? 1);
    obj.syncMutationId = obj.syncMutationId ?? newMutationId();
    request('report-tombstone-create');
  });
  db.deletedReportTombstones.hook('updating', (changes, _primKey, obj) => {
    const remoteChanges = consumeRemoteUpdate(changes);
    if (remoteChanges) return remoteChanges;
    request('report-tombstone-update');
    return { localRevision: (obj.localRevision ?? 0) + 1, syncMutationId: newMutationId() };
  });
}

installRemoteSyncHooks();
