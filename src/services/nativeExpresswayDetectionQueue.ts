import type { NativeResidentRoutePoint } from '../app/nativeResidentLocationPolicy';

export type NativeExpresswayDetectionQueueItem = {
  pointId: string;
  tripId: string;
  ts: string;
  monotonicSessionId?: string;
  elapsedRealtimeMs?: number;
};

export type NativeExpresswayDetectionWorkOutcome = 'processed' | 'retry';

type QueueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

type QueueState = {
  head: number;
  tail: number;
  count: number;
};

type QueueDependencies = {
  storage: QueueStorage;
  loadPoint(pointId: string): Promise<NativeResidentRoutePoint | null>;
  getActiveTripId(): Promise<string | null>;
  processPoint(input: {
    activeTripId: string;
    point: NativeResidentRoutePoint;
  }): Promise<NativeExpresswayDetectionWorkOutcome>;
  schedule(task: () => void): void;
  scheduleRetry(task: () => void, delayMs: number): unknown;
  maxEntries: number;
  batchSize: number;
};

const STATE_KEY = 'tracklog.native-expressway-detection.queue.v1';
const ENTRY_PREFIX = `${STATE_KEY}:entry:`;
const POINT_PREFIX = `${STATE_KEY}:point:`;
const DEFAULT_MAX_ENTRIES = 5_000;
const DEFAULT_BATCH_SIZE = 250;
const RETRY_DELAY_MS = 30_000;

function emptyState(): QueueState {
  return { head: 0, tail: 0, count: 0 };
}

function normalizeState(raw: string | null): QueueState {
  if (!raw) return emptyState();
  try {
    const parsed = JSON.parse(raw) as Partial<QueueState>;
    const head = Number(parsed.head);
    const tail = Number(parsed.tail);
    const count = Number(parsed.count);
    if (
      Number.isInteger(head)
      && Number.isInteger(tail)
      && Number.isInteger(count)
      && head >= 0
      && tail >= head
      && count >= 0
      && count <= tail - head
    ) {
      return { head, tail, count };
    }
  } catch {
    // Throw below. Silently resetting would lose work that native already acked.
  }
  throw new Error('高速判定の保留キューを読み込めません');
}

function pointKey(pointId: string) {
  return `${POINT_PREFIX}${encodeURIComponent(pointId)}`;
}

function entryKey(sequence: number) {
  return `${ENTRY_PREFIX}${sequence}`;
}

function normalizeQueueItem(raw: unknown): NativeExpresswayDetectionQueueItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const pointId = typeof row.pointId === 'string' ? row.pointId.trim() : '';
  const tripId = typeof row.tripId === 'string' ? row.tripId.trim() : '';
  const ts = typeof row.ts === 'string' ? row.ts.trim() : '';
  if (!pointId || !tripId || !ts || !Number.isFinite(Date.parse(ts))) return null;
  const monotonicSessionId = typeof row.monotonicSessionId === 'string'
    ? row.monotonicSessionId.trim()
    : '';
  const elapsedRealtimeMs = Number(row.elapsedRealtimeMs);
  return {
    pointId,
    tripId,
    ts,
    ...(monotonicSessionId ? { monotonicSessionId } : {}),
    ...(monotonicSessionId && Number.isFinite(elapsedRealtimeMs) && elapsedRealtimeMs >= 0
      ? { elapsedRealtimeMs }
      : {}),
  };
}

function parseQueueItem(raw: string | null) {
  if (!raw) return null;
  try {
    return normalizeQueueItem(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export type NativeExpresswayDetectionWorkQueue = {
  /** Synchronous durable enqueue; throws before native ack if backpressure is full. */
  enqueue(input: { activeTripId: string | null; point: NativeResidentRoutePoint }): void;
  /** Fire-and-forget wake used after native drain, resume, and online events. */
  kick(): void;
  /** Awaitable single-flight entry point used by deterministic tests. */
  runPending(): Promise<{ processed: number; pending: number; retrying: boolean }>;
  pendingCount(): number;
};

export function createNativeExpresswayDetectionWorkQueue(
  overrides: Partial<QueueDependencies> & Pick<
    QueueDependencies,
    'storage' | 'loadPoint' | 'getActiveTripId' | 'processPoint'
  >,
): NativeExpresswayDetectionWorkQueue {
  const dependencies: QueueDependencies = {
    ...overrides,
    schedule: overrides.schedule ?? (task => queueMicrotask(task)),
    scheduleRetry: overrides.scheduleRetry ?? ((task, delayMs) => setTimeout(task, delayMs)),
    maxEntries: Math.max(1, Math.trunc(overrides.maxEntries ?? DEFAULT_MAX_ENTRIES)),
    batchSize: Math.max(1, Math.trunc(overrides.batchSize ?? DEFAULT_BATCH_SIZE)),
  } as QueueDependencies;
  let inFlight: Promise<{ processed: number; pending: number; retrying: boolean }> | null = null;
  let kickScheduled = false;
  let retryScheduled = false;

  const readState = () => normalizeState(dependencies.storage.getItem(STATE_KEY));
  const writeState = (state: QueueState) => {
    dependencies.storage.setItem(STATE_KEY, JSON.stringify(state));
  };

  const removeHead = (sequence: number, item: NativeExpresswayDetectionQueueItem | null) => {
    const latest = readState();
    dependencies.storage.removeItem(entryKey(sequence));
    if (item) dependencies.storage.removeItem(pointKey(item.pointId));
    writeState({
      head: Math.max(latest.head, sequence),
      tail: latest.tail,
      count: Math.max(0, latest.count - 1),
    });
  };

  const readNext = () => {
    const state = readState();
    for (let sequence = state.head + 1; sequence <= state.tail; sequence += 1) {
      const raw = dependencies.storage.getItem(entryKey(sequence));
      const item = parseQueueItem(raw);
      if (item) return { state, sequence, item };
      // Recover a state-first enqueue interrupted before its entry write.
      removeHead(sequence, null);
    }
    return { state: readState(), sequence: null, item: null };
  };

  const runInternal = async () => {
    let processed = 0;
    let retrying = false;
    while (processed < dependencies.batchSize) {
      const next = readNext();
      if (next.sequence == null || !next.item) break;
      const activeTripId = await dependencies.getActiveTripId();
      if (!activeTripId || activeTripId !== next.item.tripId) {
        removeHead(next.sequence, next.item);
        processed += 1;
        continue;
      }
      const storedPoint = await dependencies.loadPoint(next.item.pointId);
      if (!storedPoint || storedPoint.tripId !== next.item.tripId) {
        removeHead(next.sequence, next.item);
        processed += 1;
        continue;
      }
      const point: NativeResidentRoutePoint = {
        ...storedPoint,
        ...(next.item.monotonicSessionId
          ? { monotonicSessionId: next.item.monotonicSessionId }
          : {}),
        ...(typeof next.item.elapsedRealtimeMs === 'number'
          ? { elapsedRealtimeMs: next.item.elapsedRealtimeMs }
          : {}),
      };
      let outcome: NativeExpresswayDetectionWorkOutcome;
      try {
        outcome = await dependencies.processPoint({ activeTripId, point });
      } catch {
        outcome = 'retry';
      }
      if (outcome === 'retry') {
        retrying = true;
        break;
      }
      removeHead(next.sequence, next.item);
      processed += 1;
    }
    const pending = readState().count;
    return { processed, pending, retrying };
  };

  const runPending = () => {
    if (inFlight) return inFlight;
    let settledResult: { processed: number; pending: number; retrying: boolean } | null = null;
    inFlight = runInternal().then(result => {
      settledResult = result;
      return result;
    }).finally(() => {
      inFlight = null;
      if (!settledResult || settledResult.pending <= 0) return;
      if (settledResult.retrying) {
        if (!retryScheduled) {
          retryScheduled = true;
          dependencies.scheduleRetry(() => {
            retryScheduled = false;
            api.kick();
          }, RETRY_DELAY_MS);
        }
      } else {
        dependencies.schedule(() => api.kick());
      }
    });
    return inFlight;
  };

  const api: NativeExpresswayDetectionWorkQueue = {
    enqueue: input => {
      const activeTripId = input.activeTripId?.trim() ?? '';
      if (!activeTripId || input.point.tripId !== activeTripId) return;
      const item = normalizeQueueItem({
        pointId: input.point.id,
        tripId: input.point.tripId,
        ts: input.point.ts,
        monotonicSessionId: input.point.monotonicSessionId,
        elapsedRealtimeMs: input.point.elapsedRealtimeMs,
      });
      if (!item) return;
      if (dependencies.storage.getItem(pointKey(item.pointId))) {
        api.kick();
        return;
      }
      const state = readState();
      if (state.count >= dependencies.maxEntries) {
        throw new Error('高速判定の保留件数が上限に達しました');
      }
      const sequence = state.tail + 1;
      // Publish the tail first. A crash after this write leaves a recoverable
      // hole; publishing the point index first could make replay look deduped
      // while no worker-visible entry exists.
      writeState({ head: state.head, tail: sequence, count: state.count + 1 });
      dependencies.storage.setItem(entryKey(sequence), JSON.stringify(item));
      dependencies.storage.setItem(pointKey(item.pointId), String(sequence));
      api.kick();
    },
    kick: () => {
      if (kickScheduled || inFlight) return;
      kickScheduled = true;
      dependencies.schedule(() => {
        kickScheduled = false;
        void runPending();
      });
    },
    runPending,
    pendingCount: () => readState().count,
  };
  return api;
}

export function createMemoryQueueStorage(): QueueStorage {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: key => {
      values.delete(key);
    },
  };
}
