/**
 * Minimal shape shared by persisted AppEvents and report-only TripEvents.
 *
 * Pairing is deliberately recomputed from the complete event list. Session IDs
 * are useful evidence, but old imports and interrupted writes mean they cannot
 * be treated as foreign keys.
 */
export type TogglePairingEvent = {
  id?: string;
  type: string;
  ts: string;
  extras?: Record<string, unknown>;
};

export type TogglePairDefinition = Readonly<{
  channel: string;
  start: string;
  end: string;
  key: string;
  label: string;
  scope: 'persisted' | 'report';
}>;

export const PERSISTED_BASIC_TOGGLE_DEFINITIONS = [
  { channel: 'rest', start: 'rest_start', end: 'rest_end', key: 'restSessionId', label: '休息', scope: 'persisted' },
  { channel: 'break', start: 'break_start', end: 'break_end', key: 'breakSessionId', label: '休憩', scope: 'persisted' },
  { channel: 'load', start: 'load_start', end: 'load_end', key: 'loadSessionId', label: '積込', scope: 'persisted' },
  { channel: 'unload', start: 'unload_start', end: 'unload_end', key: 'unloadSessionId', label: '荷卸', scope: 'persisted' },
  { channel: 'ferry', start: 'boarding', end: 'disembark', key: 'ferrySessionId', label: 'フェリー', scope: 'persisted' },
] as const satisfies readonly TogglePairDefinition[];

export const EXPRESSWAY_TOGGLE_DEFINITION = {
  channel: 'expressway',
  start: 'expressway_start',
  end: 'expressway_end',
  key: 'expresswaySessionId',
  label: '高速道路',
  scope: 'persisted',
} as const satisfies TogglePairDefinition;

export const EXPRESSWAY_TOGGLE_DEFINITIONS = [EXPRESSWAY_TOGGLE_DEFINITION] as const;

export const REPORT_ONLY_TOGGLE_DEFINITIONS = [
  { channel: 'wait', start: 'wait_start', end: 'wait_end', key: 'waitSessionId', label: '待機', scope: 'report' },
  { channel: 'drive', start: 'drive_start', end: 'drive_end', key: 'driveSessionId', label: '運転', scope: 'report' },
  { channel: 'work', start: 'work_start', end: 'work_end', key: 'workSessionId', label: '業務', scope: 'report' },
] as const satisfies readonly TogglePairDefinition[];

export const PERSISTED_TOGGLE_DEFINITIONS: readonly TogglePairDefinition[] = [
  ...PERSISTED_BASIC_TOGGLE_DEFINITIONS,
  EXPRESSWAY_TOGGLE_DEFINITION,
];

export const ALL_TOGGLE_DEFINITIONS: readonly TogglePairDefinition[] = [
  ...PERSISTED_TOGGLE_DEFINITIONS,
  ...REPORT_ONLY_TOGGLE_DEFINITIONS,
];

// Short aliases make call sites read naturally while the longer names document
// which definitions are safe for persisted AppEvents.
export const BASIC_TOGGLE_DEFINITIONS = PERSISTED_BASIC_TOGGLE_DEFINITIONS;
export const REPORT_TOGGLE_DEFINITIONS = REPORT_ONLY_TOGGLE_DEFINITIONS;

export type TogglePairMatch = 'exact' | 'reconnected';
export type ExcludedToggleEndReason = 'orphan_end' | 'stale_end';

export type AcceptedTogglePair<T extends TogglePairingEvent> = {
  definition: TogglePairDefinition;
  start: T;
  end: T;
  startIndex: number;
  endIndex: number;
  startSessionId: string | null;
  endSessionId: string | null;
  match: TogglePairMatch;
};

export type OpenToggleStart<T extends TogglePairingEvent> = {
  definition: TogglePairDefinition;
  start: T;
  startIndex: number;
  sessionId: string | null;
};

export type ExcludedToggleEnd<T extends TogglePairingEvent> = {
  definition: TogglePairDefinition;
  end: T;
  endIndex: number;
  sessionId: string | null;
  reason: ExcludedToggleEndReason;
};

export type TogglePairingResult<T extends TogglePairingEvent> = {
  /** Complete, chronologically ordered input for repair/review screens. */
  rawEvents: T[];
  /** Normal product view: every event except rejected toggle ends. */
  normalEvents: T[];
  pairs: AcceptedTogglePair<T>[];
  openStarts: OpenToggleStart<T>[];
  excludedEnds: ExcludedToggleEnd<T>[];
};

type IndexedEvent<T extends TogglePairingEvent> = {
  event: T;
  originalIndex: number;
};

type OpenEvent<T extends TogglePairingEvent> = IndexedEvent<T> & {
  sessionId: string | null;
};

type ChannelState<T extends TogglePairingEvent> = {
  definition: TogglePairDefinition;
  definitionIndex: number;
  open: OpenEvent<T>[];
  consumedAliases: Set<string>;
};

type EventRole<T extends TogglePairingEvent> = {
  state: ChannelState<T>;
  role: 'start' | 'end';
};

function getSessionId(event: TogglePairingEvent, key: string): string | null {
  const value = event.extras?.[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function chronological<T extends TogglePairingEvent>(
  events: readonly T[],
  roles: ReadonlyMap<string, EventRole<T>>,
): IndexedEvent<T>[] {
  const indexed = events.map((event, originalIndex) => ({ event, originalIndex }));
  const rolesAtTimestamp = new Map<
    string,
    Map<number, { hasStart: boolean; hasEnd: boolean }>
  >();

  for (const item of indexed) {
    const eventRole = roles.get(item.event.type);
    if (!eventRole) continue;
    let channels = rolesAtTimestamp.get(item.event.ts);
    if (!channels) {
      channels = new Map();
      rolesAtTimestamp.set(item.event.ts, channels);
    }
    const definitionIndex = eventRole.state.definitionIndex;
    const flags = channels.get(definitionIndex) ?? { hasStart: false, hasEnd: false };
    if (eventRole.role === 'start') flags.hasStart = true;
    else flags.hasEnd = true;
    channels.set(definitionIndex, flags);
  }

  const phaseAtTimestamp = (event: T, eventRole: EventRole<T> | undefined): number => {
    if (!eventRole) return 3;
    const flags = rolesAtTimestamp
      .get(event.ts)
      ?.get(eventRole.state.definitionIndex);

    // A channel containing both roles at this instant is a zero-length-pair
    // block. Standalone ends close transitions before those blocks, and all
    // standalone starts open only after them.
    if (flags?.hasStart && flags.hasEnd) return 1;
    return eventRole.role === 'end' ? 0 : 2;
  };

  return indexed
    .sort((left, right) => {
      const byTimestamp = left.event.ts.localeCompare(right.event.ts);
      if (byTimestamp !== 0) return byTimestamp;

      const leftRole = roles.get(left.event.type);
      const rightRole = roles.get(right.event.type);

      const byPhase = phaseAtTimestamp(left.event, leftRole)
        - phaseAtTimestamp(right.event, rightRole);
      if (byPhase !== 0) return byPhase;

      if (leftRole && rightRole) {
        const byChannel = leftRole.state.definitionIndex - rightRole.state.definitionIndex;
        if (byChannel !== 0) return byChannel;

        // Inside one channel's simultaneous block, start must precede end so a
        // zero-length pair remains causal even when DB input order is reversed.
        const byRole = (leftRole.role === 'start' ? 0 : 1)
          - (rightRole.role === 'start' ? 0 : 1);
        if (byRole !== 0) return byRole;
      } else {
        const byType = left.event.type.localeCompare(right.event.type);
        if (byType !== 0) return byType;
      }

      // Same channel/role writes use immutable evidence when available so two
      // clients converge even if their DB index order differs. Original input
      // position remains the final tie-break for fully legacy records.
      const leftStableId = left.event.id
        ?? (leftRole ? getSessionId(left.event, leftRole.state.definition.key) : null)
        ?? '';
      const rightStableId = right.event.id
        ?? (rightRole ? getSessionId(right.event, rightRole.state.definition.key) : null)
        ?? '';
      const byStableId = leftStableId.localeCompare(rightStableId);
      if (byStableId !== 0) return byStableId;
      return left.originalIndex - right.originalIndex;
    });
}

function buildRoleMap<T extends TogglePairingEvent>(
  definitions: readonly TogglePairDefinition[],
): {
  roles: Map<string, EventRole<T>>;
  states: ChannelState<T>[];
} {
  const roles = new Map<string, EventRole<T>>();
  const states = definitions.map((definition, definitionIndex) => ({
    definition,
    definitionIndex,
    open: [],
    consumedAliases: new Set<string>(),
  }));

  for (const state of states) {
    for (const [type, role] of [[state.definition.start, 'start'], [state.definition.end, 'end']] as const) {
      if (roles.has(type)) {
        throw new Error(`Toggle event type is defined more than once: ${type}`);
      }
      roles.set(type, { state, role });
    }
  }

  return { roles, states };
}

/**
 * Resolve every toggle channel independently with a causal FIFO queue.
 *
 * A session ID can prove that an end is a stale duplicate after that alias was
 * consumed. Otherwise the oldest currently open start wins, even if IDs differ;
 * this reconnects partial/legacy histories without allowing one end to close
 * more than one start.
 */
export function resolveTogglePairing<T extends TogglePairingEvent>(
  events: readonly T[],
  definitions: readonly TogglePairDefinition[],
): TogglePairingResult<T> {
  const { roles, states } = buildRoleMap<T>(definitions);
  const ordered = chronological(events, roles);
  const pairs: AcceptedTogglePair<T>[] = [];
  const excludedEnds: ExcludedToggleEnd<T>[] = [];
  const excludedIndexes = new Set<number>();

  for (const indexed of ordered) {
    const resolvedRole = roles.get(indexed.event.type);
    if (!resolvedRole) continue;

    const { state, role } = resolvedRole;
    const sessionId = getSessionId(indexed.event, state.definition.key);

    if (role === 'start') {
      state.open.push({ ...indexed, sessionId });
      continue;
    }

    const sameAliasIsOpen = sessionId !== null
      && state.open.some(start => start.sessionId === sessionId);

    if (
      sessionId !== null
      && state.consumedAliases.has(sessionId)
      && !sameAliasIsOpen
    ) {
      excludedEnds.push({
        definition: state.definition,
        end: indexed.event,
        endIndex: indexed.originalIndex,
        sessionId,
        reason: 'stale_end',
      });
      excludedIndexes.add(indexed.originalIndex);
      continue;
    }

    const start = state.open.shift();
    if (!start) {
      excludedEnds.push({
        definition: state.definition,
        end: indexed.event,
        endIndex: indexed.originalIndex,
        sessionId,
        reason: 'orphan_end',
      });
      excludedIndexes.add(indexed.originalIndex);
      continue;
    }

    if (start.sessionId !== null) state.consumedAliases.add(start.sessionId);
    if (sessionId !== null) state.consumedAliases.add(sessionId);

    pairs.push({
      definition: state.definition,
      start: start.event,
      end: indexed.event,
      startIndex: start.originalIndex,
      endIndex: indexed.originalIndex,
      startSessionId: start.sessionId,
      endSessionId: sessionId,
      match: start.sessionId !== null && start.sessionId === sessionId
        ? 'exact'
        : 'reconnected',
    });
  }

  const resolvedOrderByOriginalIndex = new Map(
    ordered.map((item, resolvedIndex) => [item.originalIndex, resolvedIndex]),
  );
  const openStarts = states
    .flatMap(state => state.open.map(start => ({
      definition: state.definition,
      start: start.event,
      startIndex: start.originalIndex,
      sessionId: start.sessionId,
    })))
    .sort((left, right) => (
      (resolvedOrderByOriginalIndex.get(left.startIndex) ?? Number.MAX_SAFE_INTEGER)
      - (resolvedOrderByOriginalIndex.get(right.startIndex) ?? Number.MAX_SAFE_INTEGER)
    ));

  return {
    rawEvents: ordered.map(item => item.event),
    normalEvents: ordered
      .filter(item => !excludedIndexes.has(item.originalIndex))
      .map(item => item.event),
    pairs,
    openStarts,
    excludedEnds,
  };
}

function coerceDefinition(
  definitionOrStart: TogglePairDefinition | string,
  end?: string,
  key?: string,
): TogglePairDefinition {
  if (typeof definitionOrStart !== 'string') return definitionOrStart;
  if (!end || !key) {
    throw new Error('start, end, and session key are required');
  }
  return {
    channel: definitionOrStart,
    start: definitionOrStart,
    end,
    key,
    label: definitionOrStart,
    scope: 'persisted',
  };
}

export function findOpenToggleStart<T extends TogglePairingEvent>(
  events: readonly T[],
  definition: TogglePairDefinition,
): T | null;
export function findOpenToggleStart<T extends TogglePairingEvent>(
  events: readonly T[],
  start: string,
  end: string,
  key: string,
): T | null;
export function findOpenToggleStart<T extends TogglePairingEvent>(
  events: readonly T[],
  definitionOrStart: TogglePairDefinition | string,
  end?: string,
  key?: string,
): T | null {
  const definition = coerceDefinition(definitionOrStart, end, key);
  return resolveTogglePairing(events, [definition]).openStarts[0]?.start ?? null;
}

/** Marker used by persistence code when an open legacy start has no session ID. */
export const LEGACY_TOGGLE_SESSION_ID = '__legacy__';

export function findOpenToggleSessionId<T extends TogglePairingEvent>(
  events: readonly T[],
  definition: TogglePairDefinition,
): string | null;
export function findOpenToggleSessionId<T extends TogglePairingEvent>(
  events: readonly T[],
  start: string,
  end: string,
  key: string,
): string | null;
export function findOpenToggleSessionId<T extends TogglePairingEvent>(
  events: readonly T[],
  definitionOrStart: TogglePairDefinition | string,
  end?: string,
  key?: string,
): string | null {
  const definition = coerceDefinition(definitionOrStart, end, key);
  const open = resolveTogglePairing(events, [definition]).openStarts[0];
  if (!open) return null;
  return open.sessionId ?? LEGACY_TOGGLE_SESSION_ID;
}

function sameEvent(
  candidate: TogglePairingEvent,
  expected: TogglePairingEvent | string,
): boolean {
  if (typeof expected === 'string') return candidate.id === expected;
  if (candidate === expected) return true;
  return !!candidate.id && !!expected.id && candidate.id === expected.id;
}

export function findAcceptedTogglePair<T extends TogglePairingEvent>(
  result: TogglePairingResult<T>,
  eventOrId: T | string,
): AcceptedTogglePair<T> | null {
  return result.pairs.find(pair => (
    sameEvent(pair.start, eventOrId) || sameEvent(pair.end, eventOrId)
  )) ?? null;
}

export function findExcludedToggleEnd<T extends TogglePairingEvent>(
  result: TogglePairingResult<T>,
  eventOrId: T | string,
): ExcludedToggleEnd<T> | null {
  return result.excludedEnds.find(excluded => sameEvent(excluded.end, eventOrId)) ?? null;
}
