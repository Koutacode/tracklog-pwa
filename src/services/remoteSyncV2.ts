import { createSyncMutationId, db } from '../db/db';
import { listTrips } from '../db/repositories';
import type { Trip } from '../domain/reportTypes';
import type {
  DriverIdentity,
  RemoteDeletedEventTombstone,
  RemoteDeletedReportTombstone,
  RemoteDeletedTripTombstone,
  RemoteReportSnapshot,
  RemoteRoutePoint,
  RemoteTripEvent,
  RemoteTripHeader,
} from '../domain/remoteTypes';
import type { AppEvent, EventType, RoutePoint } from '../domain/types';
import {
  normalizeRoutePointAccuracy,
  normalizeRoutePointHeading,
  normalizeRoutePointSpeed,
} from '../domain/routePointTelemetry';
import {
  isMissingParentReportConflict,
  shouldConfirmMissingParentReport,
  type MissingParentCandidate,
} from '../domain/reportSyncConflict';
import { withRemoteSyncSignalsSuppressed } from '../app/remoteSyncSignal';
import { driverSupabase } from './supabase';

type SyncEntity =
  | 'trip'
  | 'event'
  | 'routePoint'
  | 'report'
  | 'tripDelete'
  | 'eventDelete'
  | 'reportDelete';

type SyncMutation = {
  mutationId: string;
  entityType: SyncEntity;
  entityId: string;
  operation: 'upsert' | 'delete';
  baseRevision?: number | null;
  payload?: Record<string, unknown>;
};

type MutationAck = {
  mutationId: string;
  entityType: SyncEntity;
  entityId: string;
  status: 'applied' | 'duplicate' | 'conflict' | 'rejected' | 'deleted';
  revision?: number;
  changeSeq?: number;
  message?: string;
  code?: 'revision_conflict' | 'report_tombstone_conflict' | 'active_trip_conflict' | 'entity_deleted' | 'missing_parent' | 'conflict';
  currentRow?: Record<string, unknown>;
};

type SyncChanges = {
  trips: RemoteTripHeader[];
  events: RemoteTripEvent[];
  routePoints: RemoteRoutePoint[];
  reports: RemoteReportSnapshot[];
  deletedTrips: RemoteDeletedTripTombstone[];
  deletedEvents: RemoteDeletedEventTombstone[];
  deletedReports: RemoteDeletedReportTombstone[];
};

type SyncResponse = {
  protocolVersion: number;
  cursor: number;
  hasMore: boolean;
  acks: MutationAck[];
  changes: SyncChanges;
};

type MutationSnapshot = {
  entityType: SyncEntity;
  entityId: string;
  tripId?: string;
  sourceEntityId?: string;
  localRevision?: number;
  syncMutationId?: string;
  localUpdatedAt?: string;
};

type PreparedBatch = {
  mutations: SyncMutation[];
  snapshots: Map<string, MutationSnapshot>;
  hasPending: boolean;
};

const MAX_MUTATIONS_PER_REQUEST = 420;
const MAX_SYNC_ROUNDS = 64;
const HEADER_START_PREFIX = 'header-sync-trip-start-';
const HEADER_END_PREFIX = 'header-sync-trip-end-';
const EVENT_ANCHOR_PREFIX = 'event-anchor-';
const KNOWN_EVENT_TYPES: Set<EventType> = new Set([
  'trip_start', 'trip_end', 'rest_start', 'rest_end', 'break_start', 'break_end',
  'load_start', 'load_end', 'unload_start', 'unload_end', 'refuel', 'boarding',
  'disembark', 'expressway', 'expressway_start', 'expressway_end', 'point_mark',
]);
const SYNC_METADATA_KEYS = new Set([
  'syncStatus', 'localUpdatedAt', 'localRevision', 'syncMutationId', '__remoteSyncApply',
  'ownerUserId', 'originDeviceId', 'remoteRevision', 'remoteChangeSeq', 'restoreFromChangeSeq',
]);
const SYNC_MUTATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function nowIso() {
  return new Date().toISOString();
}

function metaKey(name: string, userId: string) {
  return `${name}:${userId}`;
}

function tripRevisionKey(userId: string, tripId: string) {
  return `${metaKey('remoteSyncV2TripRevision', userId)}:${tripId}`;
}

function tripHeaderAppliedKey(userId: string, tripId: string) {
  return `${metaKey('remoteSyncV2HeaderApplied', userId)}:${tripId}`;
}

function conflictBackupKey(userId: string, entityType: SyncEntity, entityId: string) {
  return `${metaKey('remoteSyncV2ConflictBackup', userId)}:${entityType}:${entityId}`;
}

function orphanReportBackupKey(userId: string, reportId: string, mutationId: string) {
  return `${metaKey('remoteSyncV2OrphanReportBackup', userId)}:${reportId}:${mutationId}`;
}

function missingParentCandidateKey(userId: string, reportId: string) {
  return `${metaKey('remoteSyncV2MissingParentReport', userId)}:${reportId}`;
}

function snapshotKey(entityType: SyncEntity, entityId: string) {
  return `${entityType}:${entityId}`;
}

function finiteInteger(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function optionalRevision(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function strictIso(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`同期データの${field}が不正です`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`同期データの${field}が不正です`);
  return new Date(parsed).toISOString();
}

function strictText(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`同期データの${field}が不正です`);
  return normalized;
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return { ...(value as Record<string, unknown>) };
}

function localMutationId(
  row: { syncMutationId?: string; localRevision?: number },
  entityType: SyncEntity,
  entityId: string,
) {
  const mutationId = row.syncMutationId?.trim() ?? '';
  if (!SYNC_MUTATION_ID_PATTERN.test(mutationId)) {
    throw new Error(`同期IDが不正です: ${entityType}:${entityId}`);
  }
  return mutationId;
}

async function headerMutationId(userId: string, tripId: string, sourceMutationId: string) {
  const key = `${metaKey('remoteSyncV2HeaderMutation', userId)}:${tripId}`;
  const current = await getMeta(key);
  if (current) {
    try {
      const parsed = JSON.parse(current) as { sourceMutationId?: unknown; mutationId?: unknown };
      if (parsed.sourceMutationId === sourceMutationId
        && typeof parsed.mutationId === 'string'
        && SYNC_MUTATION_ID_PATTERN.test(parsed.mutationId)) {
        return parsed.mutationId;
      }
    } catch {
      // Replace invalid legacy metadata below.
    }
  }
  const mutationId = createSyncMutationId();
  await db.meta.put({
    key,
    value: JSON.stringify({ sourceMutationId, mutationId }),
    updatedAt: nowIso(),
  });
  return mutationId;
}

async function repairOutboxMutationIds() {
  await db.transaction('rw', [
    db.events, db.routePoints, db.reportTrips, db.deletedEventTombstones,
    db.deletedTripTombstones, db.deletedReportTombstones,
  ], async () => {
    const repairRows = async <T extends { syncMutationId?: string; localRevision?: number }>(
      rows: T[],
      update: (row: T, changes: Record<string, unknown>) => Promise<unknown>,
    ) => {
      for (const row of rows) {
        if (SYNC_MUTATION_ID_PATTERN.test(row.syncMutationId?.trim() ?? '')) continue;
        await update(row, {
          __remoteSyncApply: true,
          syncMutationId: createSyncMutationId(),
          localRevision: Math.max(1, row.localRevision ?? 1),
        });
      }
    };
    await repairRows(
      await db.events.where('syncStatus').equals('pending').toArray(),
      (row, changes) => db.events.update((row as AppEvent).id, changes),
    );
    await repairRows(
      await db.routePoints.where('syncStatus').equals('pending').toArray(),
      (row, changes) => db.routePoints.update((row as RoutePoint).id, changes),
    );
    await repairRows(
      await db.reportTrips.where('syncStatus').equals('pending').toArray(),
      (row, changes) => db.reportTrips.update((row as Trip).id, changes as Partial<Trip>),
    );
    await repairRows(
      await db.deletedEventTombstones.filter(row => !row.syncedAt).toArray(),
      (row, changes) => db.deletedEventTombstones.update((row as { eventId: string }).eventId, changes),
    );
    await repairRows(
      await db.deletedTripTombstones.filter(row => !row.syncedAt).toArray(),
      (row, changes) => db.deletedTripTombstones.update((row as { tripId: string }).tripId, changes),
    );
    await repairRows(
      await db.deletedReportTombstones.filter(row => !row.syncedAt).toArray(),
      (row, changes) => db.deletedReportTombstones.update((row as { tripId: string }).tripId, changes),
    );
  });
}

function belongsToUser(row: { ownerUserId?: string }, userId: string) {
  return !row.ownerUserId || row.ownerUserId === userId;
}

async function getMeta(key: string): Promise<string | null> {
  return (await db.meta.get(key))?.value ?? null;
}

function sanitizeReportPayload(report: Trip): unknown {
  return JSON.parse(JSON.stringify(report, (key, value) => SYNC_METADATA_KEYS.has(key) ? undefined : value));
}

function parseMissingParentCandidate(value: string | null): MissingParentCandidate | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<MissingParentCandidate>;
    if (typeof parsed.mutationId !== 'string' || typeof parsed.firstSeenAt !== 'string') return null;
    return { mutationId: parsed.mutationId, firstSeenAt: parsed.firstSeenAt };
  } catch {
    return null;
  }
}

function eventPayload(event: AppEvent): Record<string, unknown> {
  return {
    trip_id: event.tripId,
    type: event.type,
    ts: event.ts,
    address: event.address ?? null,
    geo: event.geo ? { ...event.geo } : null,
    extras: event.extras ? JSON.parse(JSON.stringify(event.extras)) : null,
  };
}

function routePointPayload(point: RoutePoint): Record<string, unknown> {
  return {
    trip_id: point.tripId,
    ts: point.ts,
    lat: point.lat,
    lng: point.lng,
    accuracy: normalizeRoutePointAccuracy(point.accuracy),
    speed: normalizeRoutePointSpeed(point.speed),
    heading: normalizeRoutePointHeading(point.heading),
    source: point.source ?? null,
  };
}

async function prepareMutations(userId: string): Promise<PreparedBatch> {
  const [events, routePoints, reports, eventDeletes, tripDeletes, reportDeletes, trips] = await Promise.all([
    db.events.where('syncStatus').equals('pending').sortBy('ts'),
    db.routePoints.where('syncStatus').equals('pending').sortBy('updatedAt'),
    db.reportTrips.where('syncStatus').equals('pending').sortBy('createdAt'),
    db.deletedEventTombstones.filter(item => !item.syncedAt && belongsToUser(item, userId)).sortBy('deletedAt'),
    db.deletedTripTombstones.filter(item => !item.syncedAt && belongsToUser(item, userId)).sortBy('deletedAt'),
    db.deletedReportTombstones.filter(item => !item.syncedAt && belongsToUser(item, userId)).sortBy('deletedAt'),
    listTrips(),
  ]);
  const pendingEvents = events.filter(item => belongsToUser(item, userId));
  const pendingRoutePoints = routePoints.filter(item => belongsToUser(item, userId));
  const pendingReports = reports.filter(item => belongsToUser(item, userId));
  const mutations: SyncMutation[] = [];
  const snapshots = new Map<string, MutationSnapshot>();
  const includedHeaderTrips = new Set<string>();
  const tripById = new Map(trips.map(item => [item.tripId, item]));

  const push = (mutation: SyncMutation, snapshot?: MutationSnapshot) => {
    if (mutations.length >= MAX_MUTATIONS_PER_REQUEST) return false;
    mutations.push(mutation);
    if (snapshot) snapshots.set(snapshotKey(mutation.entityType, mutation.entityId), snapshot);
    return true;
  };

  for (const item of tripDeletes) {
    const mutationId = localMutationId(item, 'tripDelete', item.tripId);
    const storedTripRevision = optionalRevision(await getMeta(tripRevisionKey(userId, item.tripId)));
    const baseRevision = item.remoteRevision ?? storedTripRevision;
    if (!push({
      mutationId,
      entityType: 'tripDelete',
      entityId: item.tripId,
      operation: 'delete',
      ...(baseRevision ? { baseRevision } : {}),
      payload: { deleted_at: item.deletedAt },
    }, {
      entityType: 'tripDelete', entityId: item.tripId, tripId: item.tripId,
      localRevision: item.localRevision, syncMutationId: mutationId,
      localUpdatedAt: item.deletedAt,
    })) break;
  }
  for (const item of eventDeletes) {
    const mutationId = localMutationId(item, 'eventDelete', item.eventId);
    if (!push({
      mutationId,
      entityType: 'eventDelete',
      entityId: item.eventId,
      operation: 'delete',
      ...(item.remoteRevision ? { baseRevision: item.remoteRevision } : {}),
      payload: {
        trip_id: item.tripId,
        event_type: item.eventType ?? null,
        event_ts: item.eventTs ?? null,
        deleted_at: item.deletedAt,
      },
    }, {
      entityType: 'eventDelete', entityId: item.eventId, tripId: item.tripId,
      localRevision: item.localRevision, syncMutationId: mutationId,
      localUpdatedAt: item.deletedAt,
    })) break;
  }
  for (const item of reportDeletes) {
    const mutationId = localMutationId(item, 'reportDelete', item.tripId);
    if (!push({
      mutationId,
      entityType: 'reportDelete',
      entityId: item.tripId,
      operation: 'delete',
      ...(item.remoteRevision ? { baseRevision: item.remoteRevision } : {}),
      payload: { deleted_at: item.deletedAt },
    }, {
      entityType: 'reportDelete', entityId: item.tripId, tripId: item.tripId,
      localRevision: item.localRevision, syncMutationId: mutationId,
      localUpdatedAt: item.deletedAt,
    })) break;
  }

  const boundaryByTrip = new Map<string, AppEvent>();
  for (const event of pendingEvents) {
    if (event.type !== 'trip_start' && event.type !== 'trip_end') continue;
    const previous = boundaryByTrip.get(event.tripId);
    if (!previous || event.ts > previous.ts) boundaryByTrip.set(event.tripId, event);
  }
  for (const [tripId, boundary] of boundaryByTrip) {
    const trip = tripById.get(tripId);
    if (!trip) continue;
    const baseRevision = optionalRevision(await getMeta(tripRevisionKey(userId, tripId)));
    const sourceMutationId = localMutationId(boundary, 'event', boundary.id);
    if (await getMeta(tripHeaderAppliedKey(userId, tripId)) === sourceMutationId) continue;
    const mutationId = await headerMutationId(userId, tripId, sourceMutationId);
    if (!push({
      mutationId,
      entityType: 'trip',
      entityId: tripId,
      operation: 'upsert',
      ...(baseRevision ? { baseRevision } : {}),
      payload: {
        start_ts: trip.startTs,
        end_ts: trip.endTs ?? null,
        odo_start: trip.odoStart,
        odo_end: trip.odoEnd ?? null,
        total_km: trip.totalKm ?? null,
        last_leg_km: trip.lastLegKm ?? null,
        status: trip.status,
      },
    }, {
      entityType: 'trip',
      entityId: tripId,
      tripId,
      sourceEntityId: boundary.id,
      localRevision: boundary.localRevision,
      syncMutationId: sourceMutationId,
      localUpdatedAt: boundary.localUpdatedAt ?? boundary.ts,
    })) break;
    includedHeaderTrips.add(tripId);
  }

  const knownHeaderCache = new Map<string, boolean>();
  const knownHeader = async (tripId: string) => {
    if (includedHeaderTrips.has(tripId)) return true;
    if (knownHeaderCache.has(tripId)) return knownHeaderCache.get(tripId)!;
    const known = !!optionalRevision(await getMeta(tripRevisionKey(userId, tripId)));
    knownHeaderCache.set(tripId, known);
    return known;
  };

  for (const event of pendingEvents) {
    if (includedHeaderTrips.has(event.tripId)) continue;
    if (!(await knownHeader(event.tripId))) continue;
    const mutationId = localMutationId(event, 'event', event.id);
    if (!push({
      mutationId,
      entityType: 'event',
      entityId: event.id,
      operation: 'upsert',
      ...(event.remoteRevision ? { baseRevision: event.remoteRevision } : {}),
      payload: eventPayload(event),
    }, {
      entityType: 'event', entityId: event.id, tripId: event.tripId,
      localRevision: event.localRevision, syncMutationId: mutationId,
      localUpdatedAt: event.localUpdatedAt ?? event.ts,
    })) break;
  }
  for (const point of pendingRoutePoints) {
    if (includedHeaderTrips.has(point.tripId)) continue;
    if (!(await knownHeader(point.tripId))) continue;
    const mutationId = localMutationId(point, 'routePoint', point.id);
    if (!push({
      mutationId,
      entityType: 'routePoint',
      entityId: point.id,
      operation: 'upsert',
      ...(point.remoteRevision ? { baseRevision: point.remoteRevision } : {}),
      payload: routePointPayload(point),
    }, {
      entityType: 'routePoint', entityId: point.id, tripId: point.tripId,
      localRevision: point.localRevision, syncMutationId: mutationId,
      localUpdatedAt: point.updatedAt ?? point.ts,
    })) break;
  }
  for (const report of pendingReports) {
    if (includedHeaderTrips.has(report.id)) continue;
    const mutationId = localMutationId(report, 'report', report.id);
    if (!push({
      mutationId,
      entityType: 'report',
      entityId: report.id,
      operation: 'upsert',
      ...(report.remoteRevision ? { baseRevision: report.remoteRevision } : {}),
      payload: {
        trip_id: report.id,
        created_at: report.createdAt,
        label: report.label,
        payload_json: sanitizeReportPayload(report),
        restore: true,
        restore_from_change_seq: report.restoreFromChangeSeq ?? null,
      },
    }, {
      entityType: 'report', entityId: report.id, tripId: report.id,
      localRevision: report.localRevision, syncMutationId: mutationId,
      localUpdatedAt: report.localUpdatedAt ?? report.createdAt,
    })) break;
  }

  return {
    mutations,
    snapshots,
    hasPending:
      tripDeletes.length + eventDeletes.length + reportDeletes.length + pendingEvents.length +
      pendingRoutePoints.length + pendingReports.length > 0,
  };
}

function parseResponse(raw: unknown): SyncResponse {
  const envelope = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  if (envelope.ok === false) throw new Error(typeof envelope.error === 'string' ? envelope.error : '同期サーバーでエラーが発生しました');
  const value = envelope.data && typeof envelope.data === 'object'
    ? envelope.data as Record<string, unknown>
    : envelope;
  if (Number(value.protocolVersion) !== 2) throw new Error('同期サーバーのバージョンが一致しません');
  const rawChanges = value.changes && typeof value.changes === 'object'
    ? value.changes as Record<string, unknown>
    : {};
  const array = <T>(key: string): T[] => Array.isArray(rawChanges[key]) ? rawChanges[key] as T[] : [];
  return {
    protocolVersion: 2,
    cursor: finiteInteger(value.cursor),
    hasMore: value.hasMore === true,
    acks: Array.isArray(value.acks) ? value.acks as MutationAck[] : [],
    changes: {
      trips: array<RemoteTripHeader>('trips'),
      events: array<RemoteTripEvent>('events'),
      routePoints: array<RemoteRoutePoint>('routePoints'),
      reports: array<RemoteReportSnapshot>('reports'),
      deletedTrips: array<RemoteDeletedTripTombstone>('deletedTrips'),
      deletedEvents: array<RemoteDeletedEventTombstone>('deletedEvents'),
      deletedReports: array<RemoteDeletedReportTombstone>('deletedReports'),
    },
  };
}

function normalizeRemoteEvent(row: RemoteTripEvent): AppEvent {
  const id = strictText(row.id, 'event.id');
  const tripId = strictText(row.trip_id, 'event.trip_id');
  const type = strictText(row.type, 'event.type') as EventType;
  if (!KNOWN_EVENT_TYPES.has(type)) throw new Error(`未対応の同期イベントです: ${type}`);
  const geo = objectOrUndefined(row.geo);
  let normalizedGeo: AppEvent['geo'];
  if (geo) {
    const lat = Number(geo.lat);
    const lng = Number(geo.lng);
    const accuracy = Number(geo.accuracy);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw new Error(`同期イベント${id}の位置情報が不正です`);
    }
    normalizedGeo = { lat, lng, ...(Number.isFinite(accuracy) ? { accuracy } : {}) };
  }
  return {
    id,
    tripId,
    type,
    ts: strictIso(row.ts, 'event.ts'),
    ...(row.address?.trim() ? { address: row.address.trim() } : {}),
    ...(normalizedGeo ? { geo: normalizedGeo } : {}),
    ...(objectOrUndefined(row.extras) ? { extras: objectOrUndefined(row.extras) } : {}),
    syncStatus: 'synced',
    localUpdatedAt: strictIso(row.updated_at, 'event.updated_at'),
    ownerUserId: strictText(row.owner_user_id, 'event.owner_user_id'),
    originDeviceId: strictText(row.device_id, 'event.device_id'),
    remoteRevision: Math.max(1, finiteInteger(row.revision, 1)),
    remoteChangeSeq: finiteInteger(row.change_seq),
    __remoteSyncApply: true,
  };
}

function normalizeRemoteRoutePoint(row: RemoteRoutePoint): RoutePoint {
  const id = strictText(row.id, 'routePoint.id');
  const lat = Number(row.lat);
  const lng = Number(row.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new Error(`同期位置点${id}の座標が不正です`);
  }
  const source = row.source === 'foreground' || row.source === 'background' || row.source === 'event'
    ? row.source
    : undefined;
  const accuracy = normalizeRoutePointAccuracy(row.accuracy);
  const speed = normalizeRoutePointSpeed(row.speed);
  const heading = normalizeRoutePointHeading(row.heading);
  return {
    id,
    tripId: strictText(row.trip_id, 'routePoint.trip_id'),
    ts: strictIso(row.ts, 'routePoint.ts'),
    updatedAt: strictIso(row.updated_at, 'routePoint.updated_at'),
    syncStatus: 'synced',
    lat,
    lng,
    ...(accuracy != null ? { accuracy } : {}),
    ...(speed != null ? { speed } : {}),
    ...(heading != null ? { heading } : {}),
    ...(source ? { source } : {}),
    ownerUserId: strictText(row.owner_user_id, 'routePoint.owner_user_id'),
    originDeviceId: strictText(row.device_id, 'routePoint.device_id'),
    remoteRevision: Math.max(1, finiteInteger(row.revision, 1)),
    remoteChangeSeq: finiteInteger(row.change_seq),
    __remoteSyncApply: true,
  };
}

function normalizeRemoteReport(row: RemoteReportSnapshot): Trip {
  if (!row.payload_json || typeof row.payload_json !== 'object' || Array.isArray(row.payload_json)) {
    throw new Error(`同期日報${row.trip_id}の内容が不正です`);
  }
  const report = row.payload_json as Trip;
  const id = strictText(report.id, 'report.id');
  if (id !== strictText(row.trip_id, 'report.trip_id') || !Array.isArray(report.days) || !Array.isArray(report.jobs)) {
    throw new Error(`同期日報${row.trip_id}の構造が不正です`);
  }
  return {
    ...report,
    id,
    createdAt: strictIso(report.createdAt, 'report.createdAt'),
    syncStatus: 'synced',
    localUpdatedAt: strictIso(row.updated_at, 'report.updated_at'),
    ownerUserId: strictText(row.owner_user_id, 'report.owner_user_id'),
    originDeviceId: strictText(row.device_id, 'report.device_id'),
    remoteRevision: Math.max(1, finiteInteger(row.revision, 1)),
    remoteChangeSeq: finiteInteger(row.change_seq),
    restoreFromChangeSeq: undefined,
    __remoteSyncApply: true,
  };
}

function normalizeRemoteDeletedReport(row: RemoteDeletedReportTombstone, userId: string) {
  const tripId = strictText(row.trip_id, 'deletedReport.trip_id');
  const ownerUserId = strictText(row.owner_user_id, 'deletedReport.owner_user_id');
  if (ownerUserId !== userId) throw new Error('別アカウントの日報削除情報を受信しました');
  return {
    tripId,
    deviceId: strictText(row.device_id, 'deletedReport.device_id'),
    reason: typeof row.reason === 'string' ? row.reason : 'invalidated',
    deletedAt: strictIso(row.deleted_at, 'deletedReport.deleted_at'),
    syncedAt: nowIso(),
    remoteRevision: Math.max(1, finiteInteger(row.revision, 1)),
    remoteChangeSeq: finiteInteger(row.change_seq),
    ownerUserId,
    __remoteSyncApply: true as const,
  };
}

function hasResolvedIc(event: AppEvent | undefined) {
  return typeof event?.extras?.icName === 'string' && event.extras.icName.trim().length > 0;
}

function snapshotMatches(
  current: { localRevision?: number; syncMutationId?: string },
  snapshot: MutationSnapshot | undefined,
) {
  if (!snapshot) return false;
  const currentMutationId = current.syncMutationId || snapshot.syncMutationId;
  return current.localRevision === snapshot.localRevision && currentMutationId === snapshot.syncMutationId;
}

function isRevisionConflict(ack: MutationAck) {
  if (ack.status !== 'conflict') return false;
  if (ack.code === 'revision_conflict' || ack.code === 'report_tombstone_conflict') return true;
  return ack.message === 'A newer cloud revision already exists'
    || ack.message === 'Report was invalidated by a newer change';
}

function currentRowOwner(row: Record<string, unknown>, userId: string) {
  const owner = strictText(row.owner_user_id, 'conflict.owner_user_id');
  if (owner !== userId) throw new Error('別アカウントの競合情報を受信しました');
}

function shouldKeepLocalAfterConflict(
  ack: MutationAck,
  current: { localRevision?: number; syncMutationId?: string; localUpdatedAt?: string } | undefined,
  snapshot: MutationSnapshot | undefined,
) {
  // Deletes remain delete-wins. Upserts only retry when the user changed the
  // row after this request was prepared; the same stale payload is never
  // rebased automatically over a newer cloud revision.
  if (ack.entityType === 'tripDelete'
    || ack.entityType === 'eventDelete'
    || ack.entityType === 'reportDelete') return true;
  return !!current && !snapshotMatches(current, snapshot);
}

async function storeConflictBackup(
  userId: string,
  ack: MutationAck,
  localRow: unknown,
  snapshot: MutationSnapshot | undefined,
) {
  await db.meta.put({
    key: conflictBackupKey(userId, ack.entityType, ack.entityId),
    value: JSON.stringify({
      savedAt: nowIso(),
      entityType: ack.entityType,
      entityId: ack.entityId,
      code: ack.code,
      message: ack.message,
      snapshot,
      localRow,
    }),
    updatedAt: nowIso(),
  });
}

async function applySuccessfulAcks(acks: MutationAck[], prepared: PreparedBatch, userId: string) {
  const successful = acks.filter(item => item.status === 'applied' || item.status === 'duplicate');
  if (successful.length === 0) return;
  await db.transaction('rw', [
    db.events, db.routePoints, db.reportTrips, db.deletedEventTombstones,
    db.deletedTripTombstones, db.deletedReportTombstones, db.meta,
  ], async () => {
    for (const ack of successful) {
      const snapshot = prepared.snapshots.get(snapshotKey(ack.entityType, ack.entityId));
      const remoteMetadata = {
        __remoteSyncApply: true as const,
        ownerUserId: userId,
        ...(ack.revision != null ? { remoteRevision: ack.revision } : {}),
        ...(ack.changeSeq != null ? { remoteChangeSeq: ack.changeSeq } : {}),
      };
      if (ack.entityType === 'trip') {
        if (ack.revision != null) {
          await db.meta.put({ key: tripRevisionKey(userId, ack.entityId), value: `${ack.revision}`, updatedAt: nowIso() });
        }
        if (snapshot?.syncMutationId) {
          await db.meta.put({
            key: tripHeaderAppliedKey(userId, ack.entityId),
            value: snapshot.syncMutationId,
            updatedAt: nowIso(),
          });
        }
        continue;
      }
      if (ack.entityType === 'event') {
        const current = await db.events.get(ack.entityId);
        if (current && snapshotMatches(current, snapshot)) await db.events.update(ack.entityId, { ...remoteMetadata, syncStatus: 'synced' });
      } else if (ack.entityType === 'routePoint') {
        const current = await db.routePoints.get(ack.entityId);
        if (current && snapshotMatches(current, snapshot)) await db.routePoints.update(ack.entityId, { ...remoteMetadata, syncStatus: 'synced' });
      } else if (ack.entityType === 'report') {
        const current = await db.reportTrips.get(ack.entityId);
        if (current && snapshotMatches(current, snapshot)) {
          await db.reportTrips.update(ack.entityId, {
            ...remoteMetadata,
            syncStatus: 'synced',
            restoreFromChangeSeq: undefined,
          });
          await db.deletedReportTombstones.delete(ack.entityId);
        }
        await db.meta.delete(missingParentCandidateKey(userId, ack.entityId));
      } else if (ack.entityType === 'eventDelete') {
        const current = await db.deletedEventTombstones.get(ack.entityId);
        if (current && snapshotMatches(current, snapshot)) await db.deletedEventTombstones.update(ack.entityId, { ...remoteMetadata, syncedAt: nowIso() });
      } else if (ack.entityType === 'tripDelete') {
        const current = await db.deletedTripTombstones.get(ack.entityId);
        if (current && snapshotMatches(current, snapshot)) await db.deletedTripTombstones.update(ack.entityId, { ...remoteMetadata, syncedAt: nowIso() });
      } else if (ack.entityType === 'reportDelete') {
        const current = await db.deletedReportTombstones.get(ack.entityId);
        if (current && snapshotMatches(current, snapshot)) await db.deletedReportTombstones.update(ack.entityId, { ...remoteMetadata, syncedAt: nowIso() });
      }
    }
  });
}

async function deleteLocalTripInTransaction(tripId: string) {
  await db.events.where('tripId').equals(tripId).delete();
  await db.routePoints.where('tripId').equals(tripId).delete();
  await db.reportTrips.delete(tripId);
  const active = await db.meta.get('activeTripId');
  if (active?.value === tripId) await db.meta.delete('activeTripId');
}

async function applyChanges(
  response: SyncResponse,
  prepared: PreparedBatch,
  userId: string,
  cursorKey: string,
) {
  const remoteEvents = response.changes.events.map(normalizeRemoteEvent);
  const remoteRoutePoints = response.changes.routePoints.map(normalizeRemoteRoutePoint);
  const remoteReports = response.changes.reports.map(normalizeRemoteReport);
  const remoteDeletedReports = response.changes.deletedReports
    .map(row => normalizeRemoteDeletedReport(row, userId));
  const deletedReportByTrip = new Map(remoteDeletedReports.map(row => [row.tripId, row]));
  const revisionConflicts = response.acks.filter(isRevisionConflict);
  const missingParentReportConflicts = response.acks.filter(isMissingParentReportConflict);
  let deferredMissingParent = false;

  await withRemoteSyncSignalsSuppressed(async () => {
    await db.transaction('rw', [
      db.events, db.routePoints, db.reportTrips, db.deletedEventTombstones,
      db.deletedTripTombstones, db.deletedReportTombstones, db.meta,
    ], async () => {
      const deleteReportUnlessPending = async (
        tripId: string,
        options?: { snapshot?: MutationSnapshot; deleteMatchingSnapshot?: boolean },
      ) => {
        const local = await db.reportTrips.get(tripId);
        const pendingWasRecreated = local?.syncStatus === 'pending'
          && (!options?.deleteMatchingSnapshot || !snapshotMatches(local, options.snapshot));
        if (!pendingWasRecreated) {
          await db.reportTrips.delete(tripId);
          return;
        }
        const tombstone = deletedReportByTrip.get(tripId);
        if (tombstone && tombstone.remoteChangeSeq > 0) {
          await db.reportTrips.update(tripId, {
            __remoteSyncApply: true,
            remoteRevision: tombstone.remoteRevision,
            remoteChangeSeq: tombstone.remoteChangeSeq,
            restoreFromChangeSeq: tombstone.remoteChangeSeq,
          });
        }
      };

      for (const ack of missingParentReportConflicts) {
        const snapshot = prepared.snapshots.get(snapshotKey(ack.entityType, ack.entityId));
        const local = await db.reportTrips.get(ack.entityId);
        if (!local || !snapshotMatches(local, snapshot)) continue;
        const candidateKey = missingParentCandidateKey(userId, local.id);
        const mutationId = local.syncMutationId ?? ack.mutationId;
        const candidate = parseMissingParentCandidate((await db.meta.get(candidateKey))?.value ?? null);
        const nowMs = Date.now();
        const savedAt = new Date(nowMs).toISOString();
        if (!shouldConfirmMissingParentReport(candidate, mutationId, nowMs)) {
          const firstSeenAt = candidate?.mutationId === mutationId
            && Number.isFinite(Date.parse(candidate.firstSeenAt))
            ? candidate.firstSeenAt
            : savedAt;
          await db.meta.put({
            key: candidateKey,
            value: JSON.stringify({ mutationId, firstSeenAt }),
            updatedAt: savedAt,
          });
          deferredMissingParent = true;
          continue;
        }
        await db.meta.put({
          key: orphanReportBackupKey(userId, local.id, mutationId),
          value: JSON.stringify({
            savedAt,
            reason: 'server_confirmed_missing_trip_header',
            message: ack.message,
            snapshot,
            report: local,
          }),
          updatedAt: savedAt,
        });
        await db.reportTrips.update(local.id, {
          __remoteSyncApply: true,
          syncStatus: 'error',
        });
        await db.meta.delete(candidateKey);
      }

      for (const ack of revisionConflicts) {
        const row = ack.currentRow;
        const revision = optionalRevision(ack.revision ?? row?.revision);
        const changeSeq = finiteInteger(ack.changeSeq ?? row?.change_seq);
        const snapshot = prepared.snapshots.get(snapshotKey(ack.entityType, ack.entityId));
        if (row) currentRowOwner(row, userId);

        if (ack.entityType === 'trip') {
          const local = snapshot?.sourceEntityId
            ? await db.events.get(snapshot.sourceEntityId)
            : undefined;
          if (revision) {
            await db.meta.put({
              key: tripRevisionKey(userId, ack.entityId),
              value: `${revision}`,
              updatedAt: nowIso(),
            });
          }
          if (shouldKeepLocalAfterConflict(ack, local, snapshot)) continue;
          if (local) {
            await storeConflictBackup(userId, ack, local, snapshot);
            await db.events.delete(local.id);
          }
          await db.meta.delete(tripHeaderAppliedKey(userId, ack.entityId));
          if (row) {
            const startTs = strictIso(row.start_ts, 'trip.start_ts');
            const endTs = row.end_ts ? strictIso(row.end_ts, 'trip.end_ts') : null;
            const existing = await db.events.where('tripId').equals(ack.entityId).toArray();
            if (!existing.some(item => item.type === 'trip_start')) {
              await db.events.put({
                id: `${HEADER_START_PREFIX}${ack.entityId}`,
                tripId: ack.entityId,
                type: 'trip_start',
                ts: startTs,
                syncStatus: 'synced',
                ownerUserId: userId,
                originDeviceId: strictText(row.device_id, 'trip.device_id'),
                extras: { odoKm: row.odo_start },
                __remoteSyncApply: true,
              });
            }
            if (endTs && !existing.some(item => item.type === 'trip_end')) {
              await db.events.put({
                id: `${HEADER_END_PREFIX}${ack.entityId}`,
                tripId: ack.entityId,
                type: 'trip_end',
                ts: endTs,
                syncStatus: 'synced',
                ownerUserId: userId,
                originDeviceId: strictText(row.device_id, 'trip.device_id'),
                extras: {
                  odoKm: row.odo_end ?? 0,
                  totalKm: row.total_km ?? 0,
                  lastLegKm: row.last_leg_km ?? 0,
                },
                __remoteSyncApply: true,
              });
            } else if (!endTs) {
              await db.events.delete(`${HEADER_END_PREFIX}${ack.entityId}`);
            }
          } else if (local) {
            await db.events.put({ ...local, syncStatus: 'error', __remoteSyncApply: true });
          }
          continue;
        }
        if (ack.entityType === 'tripDelete') {
          const local = await db.deletedTripTombstones.get(ack.entityId);
          if (local && revision) {
            await db.deletedTripTombstones.update(ack.entityId, {
              __remoteSyncApply: true,
              remoteRevision: revision,
              remoteChangeSeq: changeSeq,
            });
          }
          if (revision) {
            await db.meta.put({
              key: tripRevisionKey(userId, ack.entityId),
              value: `${revision}`,
              updatedAt: nowIso(),
            });
          }
          continue;
        }
        if (ack.entityType === 'eventDelete') {
          const local = await db.deletedEventTombstones.get(ack.entityId);
          if (local && revision) {
            await db.deletedEventTombstones.update(ack.entityId, {
              __remoteSyncApply: true,
              remoteRevision: revision,
              remoteChangeSeq: changeSeq,
            });
          }
          continue;
        }
        if (ack.entityType === 'reportDelete') {
          const local = await db.deletedReportTombstones.get(ack.entityId);
          if (local && revision) {
            await db.deletedReportTombstones.update(ack.entityId, {
              __remoteSyncApply: true,
              remoteRevision: revision,
              remoteChangeSeq: changeSeq,
            });
          }
          continue;
        }

        if (ack.entityType === 'event') {
          const local = await db.events.get(ack.entityId);
          const keepLocal = shouldKeepLocalAfterConflict(ack, local, snapshot);
          if (keepLocal) {
            if (local && revision) {
              await db.events.update(ack.entityId, {
                __remoteSyncApply: true,
                remoteRevision: revision,
                remoteChangeSeq: changeSeq,
              });
            }
          } else if (row) {
            if (local) await storeConflictBackup(userId, ack, local, snapshot);
            await db.events.put(normalizeRemoteEvent(row as unknown as RemoteTripEvent));
          } else if (local) {
            await storeConflictBackup(userId, ack, local, snapshot);
            await db.events.update(ack.entityId, { __remoteSyncApply: true, syncStatus: 'error' });
          }
          continue;
        }
        if (ack.entityType === 'routePoint') {
          const local = await db.routePoints.get(ack.entityId);
          if (shouldKeepLocalAfterConflict(ack, local, snapshot)) {
            if (local && revision) {
              await db.routePoints.update(ack.entityId, {
                __remoteSyncApply: true,
                remoteRevision: revision,
                remoteChangeSeq: changeSeq,
              });
            }
          } else if (row) {
            if (local) await storeConflictBackup(userId, ack, local, snapshot);
            await db.routePoints.put(normalizeRemoteRoutePoint(row as unknown as RemoteRoutePoint));
          } else if (local) {
            await storeConflictBackup(userId, ack, local, snapshot);
            await db.routePoints.update(ack.entityId, { __remoteSyncApply: true, syncStatus: 'error' });
          }
          continue;
        }
        if (ack.entityType === 'report') {
          await db.meta.delete(missingParentCandidateKey(userId, ack.entityId));
          const local = await db.reportTrips.get(ack.entityId);
          const isTombstone = ack.code === 'report_tombstone_conflict'
            || (!!row && !('payload_json' in row) && 'deleted_at' in row);
          if (isTombstone) {
            if (local && changeSeq > 0) {
              await db.reportTrips.update(ack.entityId, {
                __remoteSyncApply: true,
                remoteRevision: revision,
                remoteChangeSeq: changeSeq,
                restoreFromChangeSeq: changeSeq,
              });
            }
            if (row && changeSeq > 0) {
              await db.deletedReportTombstones.put({
                tripId: ack.entityId,
                deviceId: typeof row.device_id === 'string' ? row.device_id : undefined,
                reason: typeof row.reason === 'string' ? row.reason : 'invalidated',
                deletedAt: strictIso(row.deleted_at, 'reportTombstone.deleted_at'),
                syncedAt: nowIso(),
                remoteRevision: revision,
                remoteChangeSeq: changeSeq,
                ownerUserId: userId,
                __remoteSyncApply: true,
              });
            }
          } else if (shouldKeepLocalAfterConflict(ack, local, snapshot)) {
            if (local && revision) {
              await db.reportTrips.update(ack.entityId, {
                __remoteSyncApply: true,
                remoteRevision: revision,
                remoteChangeSeq: changeSeq,
              });
            }
          } else if (row) {
            if (local) await storeConflictBackup(userId, ack, local, snapshot);
            await db.reportTrips.put(normalizeRemoteReport(row as unknown as RemoteReportSnapshot));
            await db.deletedReportTombstones.delete(ack.entityId);
          } else if (local) {
            await storeConflictBackup(userId, ack, local, snapshot);
            await db.reportTrips.update(ack.entityId, { __remoteSyncApply: true, syncStatus: 'error' });
          }
        }
      }

      for (const header of response.changes.trips) {
        const tripId = strictText(header.trip_id, 'trip.trip_id');
        const ownerUserId = strictText(header.owner_user_id, 'trip.owner_user_id');
        if (ownerUserId !== userId) throw new Error('別アカウントの運行データを受信しました');
        const startTs = strictIso(header.start_ts, 'trip.start_ts');
        const endTs = header.end_ts ? strictIso(header.end_ts, 'trip.end_ts') : null;
        await db.meta.put({
          key: tripRevisionKey(userId, tripId),
          value: `${Math.max(1, finiteInteger(header.revision, 1))}`,
          updatedAt: nowIso(),
        });
        const existing = await db.events.where('tripId').equals(tripId).toArray();
        if (!existing.some(item => item.type === 'trip_start')) {
          await db.events.put({
            id: `${HEADER_START_PREFIX}${tripId}`,
            tripId,
            type: 'trip_start',
            ts: startTs,
            syncStatus: 'synced',
            ownerUserId,
            originDeviceId: strictText(header.device_id, 'trip.device_id'),
            extras: { odoKm: header.odo_start },
            __remoteSyncApply: true,
          });
        }
        if (endTs && !existing.some(item => item.type === 'trip_end')) {
          await db.events.put({
            id: `${HEADER_END_PREFIX}${tripId}`,
            tripId,
            type: 'trip_end',
            ts: endTs,
            syncStatus: 'synced',
            ownerUserId,
            originDeviceId: strictText(header.device_id, 'trip.device_id'),
            extras: {
              odoKm: header.odo_end ?? 0,
              totalKm: header.total_km ?? 0,
              lastLegKm: header.last_leg_km ?? 0,
            },
            __remoteSyncApply: true,
          });
        }
      }

      for (const remote of remoteEvents) {
        if (remote.ownerUserId !== userId) throw new Error('別アカウントのイベントを受信しました');
        const local = await db.events.get(remote.id);
        if (local?.syncStatus === 'pending') {
          await db.events.update(remote.id, {
            __remoteSyncApply: true,
            ownerUserId: remote.ownerUserId,
            originDeviceId: remote.originDeviceId,
            remoteRevision: remote.remoteRevision,
            remoteChangeSeq: remote.remoteChangeSeq,
          });
          continue;
        }
        if (remote.type === 'trip_start') {
          await db.events.delete(`${HEADER_START_PREFIX}${remote.tripId}`);
        } else if (remote.type === 'trip_end') {
          await db.events.delete(`${HEADER_END_PREFIX}${remote.tripId}`);
        }
        if (hasResolvedIc(local) && !hasResolvedIc(remote)) remote.extras = { ...(remote.extras ?? {}), ...(local?.extras ?? {}) };
        await db.events.put(remote);
      }
      for (const remote of remoteRoutePoints) {
        if (remote.ownerUserId !== userId) throw new Error('別アカウントの位置点を受信しました');
        const local = await db.routePoints.get(remote.id);
        if (local?.syncStatus === 'pending') {
          await db.routePoints.update(remote.id, {
            __remoteSyncApply: true,
            ownerUserId: remote.ownerUserId,
            originDeviceId: remote.originDeviceId,
            remoteRevision: remote.remoteRevision,
            remoteChangeSeq: remote.remoteChangeSeq,
          });
          continue;
        }
        await db.routePoints.put(remote);
      }
      for (const remote of remoteReports) {
        if (remote.ownerUserId !== userId) throw new Error('別アカウントの日報を受信しました');
        const local = await db.reportTrips.get(remote.id);
        if (local?.syncStatus === 'pending') {
          await db.reportTrips.update(remote.id, {
            __remoteSyncApply: true,
            ownerUserId: remote.ownerUserId,
            originDeviceId: remote.originDeviceId,
            remoteRevision: remote.remoteRevision,
            remoteChangeSeq: remote.remoteChangeSeq,
          });
          continue;
        }
        await db.reportTrips.put(remote);
        await db.deletedReportTombstones.delete(remote.id);
        await db.meta.delete(missingParentCandidateKey(userId, remote.id));
      }

      for (const row of response.changes.deletedEvents) {
        const eventId = strictText(row.event_id, 'deletedEvent.event_id');
        const tripId = strictText(row.trip_id, 'deletedEvent.trip_id');
        const ownerUserId = strictText(row.owner_user_id, 'deletedEvent.owner_user_id');
        if (ownerUserId !== userId) throw new Error('別アカウントの削除情報を受信しました');
        await db.deletedEventTombstones.put({
          eventId,
          tripId,
          eventType: row.event_type ?? undefined,
          eventTs: row.event_ts ? strictIso(row.event_ts, 'deletedEvent.event_ts') : undefined,
          deletedAt: strictIso(row.deleted_at, 'deletedEvent.deleted_at'),
          syncedAt: nowIso(),
          remoteRevision: Math.max(1, finiteInteger(row.revision, 1)),
          remoteChangeSeq: finiteInteger(row.change_seq),
          ownerUserId,
          __remoteSyncApply: true,
        });
        await db.events.delete(eventId);
        await db.routePoints.delete(`${EVENT_ANCHOR_PREFIX}${eventId}`);
        await deleteReportUnlessPending(tripId);
      }
      for (const tombstone of remoteDeletedReports) {
        const { tripId } = tombstone;
        await db.deletedReportTombstones.put(tombstone);
        await deleteReportUnlessPending(tripId);
      }
      for (const row of response.changes.deletedTrips) {
        const tripId = strictText(row.trip_id, 'deletedTrip.trip_id');
        const ownerUserId = strictText(row.owner_user_id, 'deletedTrip.owner_user_id');
        if (ownerUserId !== userId) throw new Error('別アカウントの運行削除情報を受信しました');
        await db.deletedTripTombstones.put({
          tripId,
          deviceId: strictText(row.device_id, 'deletedTrip.device_id'),
          deletedAt: strictIso(row.deleted_at, 'deletedTrip.deleted_at'),
          syncedAt: nowIso(),
          remoteRevision: Math.max(1, finiteInteger(row.revision, 1)),
          remoteChangeSeq: finiteInteger(row.change_seq),
          ownerUserId,
          __remoteSyncApply: true,
        });
        await deleteLocalTripInTransaction(tripId);
      }

      for (const ack of response.acks.filter(item => item.status === 'deleted')) {
        const snapshot = prepared.snapshots.get(snapshotKey(ack.entityType, ack.entityId));
        if (ack.entityType === 'trip' || ack.entityType === 'tripDelete' || ack.message === 'trip_deleted') {
          await deleteLocalTripInTransaction(snapshot?.tripId ?? ack.entityId);
        } else if (ack.entityType === 'event' || ack.entityType === 'eventDelete') {
          await db.events.delete(ack.entityId);
          await db.routePoints.delete(`${EVENT_ANCHOR_PREFIX}${ack.entityId}`);
          if (snapshot?.tripId) await deleteReportUnlessPending(snapshot.tripId);
        } else if (ack.entityType === 'routePoint') {
          await db.routePoints.delete(ack.entityId);
        } else if (ack.entityType === 'report' || ack.entityType === 'reportDelete') {
          await deleteReportUnlessPending(ack.entityId, {
            snapshot,
            deleteMatchingSnapshot: ack.entityType === 'report',
          });
        }
      }

      await db.meta.put({ key: cursorKey, value: `${response.cursor}`, updatedAt: nowIso() });
    });
  });
  return { deferredMissingParent };
}

async function getFunctionErrorMessage(error: unknown) {
  const fallback = error instanceof Error ? error.message : '同期サーバーへの接続に失敗しました';
  const context = (error as { context?: unknown } | null)?.context;
  if (!(context instanceof Response)) return fallback;
  try {
    const body = await context.clone().json() as { error?: unknown };
    return typeof body.error === 'string' && body.error.trim() ? body.error.trim() : fallback;
  } catch {
    return fallback;
  }
}

export async function performRemoteSyncV2(identity: DriverIdentity): Promise<void> {
  if (!driverSupabase || !identity.deviceId) throw new Error('同期に必要な端末情報がありません');
  const { data: sessionData, error: sessionError } = await driverSupabase.auth.getSession();
  if (sessionError) throw sessionError;
  const userId = sessionData.session?.user?.id?.trim();
  if (!userId || sessionData.session?.user?.is_anonymous) throw new Error('メール認証済みアカウントでログインしてください');
  const boundUserId = await getMeta('remoteSyncBoundUserId');
  if (boundUserId && boundUserId !== userId) {
    throw new Error('この端末の運行データは別アカウントに紐づいています。管理者へ端末移行を依頼してください');
  }
  if (!boundUserId) {
    await db.meta.put({ key: 'remoteSyncBoundUserId', value: userId, updatedAt: nowIso() });
  }
  await repairOutboxMutationIds();
  const cursorKey = metaKey('remoteSyncV2Cursor', userId);
  const protocolKey = metaKey('remoteSyncProtocolVersion', userId);
  let cursor = finiteInteger(await getMeta(cursorKey));
  let bootstrapping = (await getMeta(protocolKey)) !== '2';
  let deferredMissingParentInRun = false;

  for (let round = 0; round < MAX_SYNC_ROUNDS; round += 1) {
    const prepared = await prepareMutations(userId);
    const { data, error } = await driverSupabase.functions.invoke('tracklog-sync', {
      body: {
        protocolVersion: 2,
        deviceId: identity.deviceId,
        cursor,
        mutations: bootstrapping || deferredMissingParentInRun ? [] : prepared.mutations,
      },
    });
    if (error) throw new Error(await getFunctionErrorMessage(error));
    const response = parseResponse(data);
    await applySuccessfulAcks(response.acks, prepared, userId);
    const changeResult = await applyChanges(response, prepared, userId, cursorKey);
    deferredMissingParentInRun ||= changeResult.deferredMissingParent;
    cursor = Math.max(cursor, response.cursor);

    const rejected = response.acks.find(item => item.status === 'rejected');
    if (rejected) throw new Error(rejected.message || 'クラウド同期で変更を保存できませんでした');
    const hardConflict = response.acks.find(item => item.status === 'conflict'
      && !isRevisionConflict(item)
      && !isMissingParentReportConflict(item));
    if (hardConflict) {
      if (hardConflict.code === 'active_trip_conflict' || hardConflict.message === 'Another active trip already exists') {
        throw new Error('同じアカウントの別端末で進行中の運行があります。運行を終了してから再同期してください。');
      }
      throw new Error(hardConflict.message || '別端末の変更と競合したため同期を停止しました');
    }
    if (bootstrapping && !response.hasMore) {
      await db.meta.put({ key: protocolKey, value: '2', updatedAt: nowIso() });
      bootstrapping = false;
      continue;
    }
    if (response.hasMore) continue;
    if (deferredMissingParentInRun) return;
    if (prepared.mutations.length === 0) {
      if (prepared.hasPending) throw new Error('同期前提となる運行情報を確認できません。もう一度同期してください');
      return;
    }
  }
  throw new Error('同期対象が多いため一部を保存しました。もう一度「今すぐ同期」を押してください');
}
