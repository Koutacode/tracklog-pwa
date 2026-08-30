import type { AppEvent, EventType } from './types';
import {
  PERSISTED_BASIC_TOGGLE_DEFINITIONS,
  findAcceptedTogglePair,
  resolveTogglePairing,
  type TogglePairDefinition,
} from './togglePairing';

const SESSION_KEYS = [
  'restSessionId',
  'breakSessionId',
  'loadSessionId',
  'unloadSessionId',
  'expresswaySessionId',
  'ferrySessionId',
] as const;

const EDITABLE_BASIC_DEFINITIONS = PERSISTED_BASIC_TOGGLE_DEFINITIONS.filter(
  definition => definition.channel !== 'ferry',
);

const PROTECTED_TYPES = new Set<EventType>([
  'trip_start',
  'trip_end',
  'boarding',
  'disembark',
  'expressway',
  'expressway_start',
  'expressway_end',
]);

const INSTANT_TYPES = new Set<EventType>(['refuel', 'point_mark']);

type BasicRole = 'start' | 'end';

type BasicTypeInfo = {
  definition: TogglePairDefinition;
  role: BasicRole;
};

type SafePairResolution = {
  paired?: AppEvent;
  ambiguous: boolean;
};

export type EventTypeConversionUpdate = {
  id: string;
  previousType: EventType;
  type: EventType;
  extras: Record<string, unknown>;
};

export type EventTypeConversionPlan = {
  tripId: string;
  changed: boolean;
  sourceEvent: AppEvent;
  pairedEvent?: AppEvent;
  updates: EventTypeConversionUpdate[];
};

function getBasicTypeInfo(type: EventType): BasicTypeInfo | null {
  for (const definition of EDITABLE_BASIC_DEFINITIONS) {
    if (definition.start === type) return { definition, role: 'start' };
    if (definition.end === type) return { definition, role: 'end' };
  }
  return null;
}

function readSessionId(event: AppEvent, definition: TogglePairDefinition): string | null {
  const value = event.extras?.[definition.key];
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function compareExactSessionEvents(
  left: AppEvent,
  right: AppEvent,
  definition: TogglePairDefinition,
): number {
  const byTimestamp = left.ts.localeCompare(right.ts);
  if (byTimestamp !== 0) return byTimestamp;

  // An explicitly simultaneous start/end is a valid zero-length pair.
  const leftRole = left.type === definition.start ? 0 : 1;
  const rightRole = right.type === definition.start ? 0 : 1;
  const byRole = leftRole - rightRole;
  if (byRole !== 0) return byRole;
  return left.id.localeCompare(right.id);
}

/**
 * Session IDs are the strongest pairing evidence for edits. This intentionally
 * differs from the report repair projection, which may reconnect damaged
 * histories: an editor must never rewrite a different, merely nearby pair.
 */
function findExactSessionPair(
  events: readonly AppEvent[],
  selected: AppEvent,
  definition: TogglePairDefinition,
  sessionId: string,
): SafePairResolution {
  const relevant = events
    .filter(event => (
      (event.type === definition.start || event.type === definition.end)
      && readSessionId(event, definition) === sessionId
    ))
    .sort((left, right) => compareExactSessionEvents(left, right, definition));

  const starts = relevant.filter(event => event.type === definition.start);
  const ends = relevant.filter(event => event.type === definition.end);
  if (starts.length > 1 || ends.length > 1) {
    return { ambiguous: true };
  }
  const start = starts[0];
  const end = ends[0];
  if (start && end && (start.id === selected.id || end.id === selected.id)) {
    if (compareExactSessionEvents(start, end, definition) > 0) {
      // Strong identity evidence exists but its timestamps are impossible. Do
      // not fall through and co-edit a weaker nearby legacy candidate.
      return { ambiguous: true };
    }
    return { paired: start.id === selected.id ? end : start, ambiguous: false };
  }
  return { ambiguous: false };
}

function sessionIdsAreCompatible(
  left: AppEvent,
  right: AppEvent,
  definition: TogglePairDefinition,
): boolean {
  const leftSessionId = readSessionId(left, definition);
  const rightSessionId = readSessionId(right, definition);
  return !leftSessionId || !rightSessionId || leftSessionId === rightSessionId;
}

function isUniqueLegacyCandidate(
  events: readonly AppEvent[],
  selected: AppEvent,
  candidate: AppEvent,
  info: BasicTypeInfo,
): boolean {
  const ordered = events
    .filter(event => (
      event.type === info.definition.start || event.type === info.definition.end
    ))
    .sort((left, right) => compareExactSessionEvents(left, right, info.definition));
  const selectedIndex = ordered.findIndex(event => event.id === selected.id);
  if (selectedIndex < 0) return false;

  if (info.role === 'start') {
    const nextStartOffset = ordered
      .slice(selectedIndex + 1)
      .findIndex(event => event.type === info.definition.start);
    const intervalEnd = nextStartOffset < 0
      ? ordered.length
      : selectedIndex + 1 + nextStartOffset;
    const candidates = ordered
      .slice(selectedIndex + 1, intervalEnd)
      .filter(event => (
        event.type === info.definition.end
        && sessionIdsAreCompatible(selected, event, info.definition)
      ));
    return candidates.length === 1 && candidates[0]?.id === candidate.id;
  }

  let previousEndIndex = -1;
  for (let index = selectedIndex - 1; index >= 0; index -= 1) {
    if (ordered[index]?.type === info.definition.end) {
      previousEndIndex = index;
      break;
    }
  }
  const candidates = ordered
    .slice(previousEndIndex + 1, selectedIndex)
    .filter(event => (
      event.type === info.definition.start
      && sessionIdsAreCompatible(selected, event, info.definition)
    ));
  return candidates.length === 1 && candidates[0]?.id === candidate.id;
}

function findSafeBasicPair(
  events: readonly AppEvent[],
  selected: AppEvent,
  info: BasicTypeInfo,
): SafePairResolution {
  const selectedSessionId = readSessionId(selected, info.definition);
  if (selectedSessionId) {
    const exact = findExactSessionPair(events, selected, info.definition, selectedSessionId);
    if (exact.ambiguous || exact.paired) return exact;
  }

  const repaired = resolveTogglePairing(events, [info.definition]);
  const accepted = findAcceptedTogglePair(repaired, selected);
  if (!accepted) return { ambiguous: false };
  const candidate = accepted.start.id === selected.id ? accepted.end : accepted.start;
  const candidateSessionId = readSessionId(candidate, info.definition);

  // A legacy/missing ID on either side can be repaired by chronology. Two
  // different non-empty IDs are separate sessions and must not be co-edited.
  if (
    selectedSessionId
    && candidateSessionId
    && selectedSessionId !== candidateSessionId
  ) {
    return { ambiguous: false };
  }
  if (!isUniqueLegacyCandidate(events, selected, candidate, info)) {
    return { ambiguous: true };
  }
  return { paired: candidate, ambiguous: false };
}

function isFerryCoupledRestEvent(events: readonly AppEvent[], event: AppEvent): boolean {
  if (event.type !== 'rest_start' && event.type !== 'rest_end') return false;
  const autoReason = typeof event.extras?.autoReason === 'string'
    ? event.extras.autoReason.trim()
    : '';
  if (autoReason === 'ferry_boarding' || autoReason === 'ferry_disembark') return true;

  const generatedFrom = typeof event.extras?.generatedFrom === 'string'
    ? event.extras.generatedFrom.trim()
    : '';
  if (generatedFrom) {
    const generator = events.find(candidate => candidate.id === generatedFrom);
    if (generator?.type === 'boarding' || generator?.type === 'disembark') return true;
  }

  const restSessionId = readSessionId(event, PERSISTED_BASIC_TOGGLE_DEFINITIONS[0]);
  return !!restSessionId && events.some(candidate => (
    candidate.type === 'boarding'
    && typeof candidate.extras?.autoRestSessionId === 'string'
    && candidate.extras.autoRestSessionId.trim() === restSessionId
  ));
}

function hasValidRestOdometer(event: AppEvent | undefined): boolean {
  const odo = Number(event?.extras?.odoKm);
  return Number.isFinite(odo) && odo > 0;
}

function pickSessionId(
  source: AppEvent,
  sourceDefinition: TogglePairDefinition,
  paired: AppEvent | undefined,
  createSessionId: () => string,
): string {
  return readSessionId(source, sourceDefinition)
    ?? (paired ? readSessionId(paired, sourceDefinition) : null)
    ?? createSessionId();
}

function normalizeExtrasForType(
  original: Record<string, unknown> | undefined,
  nextType: EventType,
  targetDefinition?: TogglePairDefinition,
  sessionId?: string,
): Record<string, unknown> {
  const extras = { ...(original ?? {}) };
  for (const key of SESSION_KEYS) delete extras[key];

  if (targetDefinition && sessionId) extras[targetDefinition.key] = sessionId;

  if (nextType !== 'rest_end') {
    delete extras.dayClose;
    delete extras.dayIndex;
  } else if (typeof extras.dayClose !== 'boolean') {
    extras.dayClose = false;
  }

  // Automation provenance describes the original generated transition. A
  // manual type correction must never make the new operation look generated.
  delete extras.autoReason;
  delete extras.generatedFrom;

  if (nextType !== 'rest_start') {
    delete extras.odoKm;
  }

  const targetInfo = getBasicTypeInfo(nextType);
  if (targetInfo?.role !== 'start') delete extras.reportMinDurationMinutes;
  if (nextType === 'point_mark') delete extras.liters;
  return extras;
}

function assertRestStartOdometer(event: AppEvent, nextType: EventType): void {
  if (nextType !== 'rest_start') return;
  if (!hasValidRestOdometer(event)) {
    throw new Error('休息開始に変更するにはODOが必要です。先にODOを入力してください。');
  }
}

function planInstantConversion(
  source: AppEvent,
  nextType: EventType,
): EventTypeConversionPlan {
  if (!INSTANT_TYPES.has(source.type) || !INSTANT_TYPES.has(nextType)) {
    throw new Error('この項目は開始/終了の作業項目に変更できません。');
  }
  if (nextType === 'refuel') {
    const liters = Number(source.extras?.liters);
    if (!Number.isFinite(liters) || liters <= 0) {
      throw new Error('給油に変更するには給油量が必要です。');
    }
  }
  return {
    tripId: source.tripId,
    changed: true,
    sourceEvent: source,
    updates: [{
      id: source.id,
      previousType: source.type,
      type: nextType,
      extras: normalizeExtrasForType(source.extras, nextType),
    }],
  };
}

/**
 * Builds the complete mutation before Dexie writes begin. Callers can then
 * apply every update in one transaction or apply none of them.
 */
export function planEventTypeConversion(
  allEvents: readonly AppEvent[],
  eventId: string,
  nextType: EventType,
  createSessionId: () => string,
): EventTypeConversionPlan {
  const source = allEvents.find(event => event.id === eventId);
  if (!source) throw new Error('イベントが見つかりません');

  if (source.type === nextType) {
    return {
      tripId: source.tripId,
      changed: false,
      sourceEvent: source,
      updates: [],
    };
  }

  if (source.type === 'trip_start' || source.type === 'trip_end') {
    throw new Error('運行開始/終了の項目は変更できません');
  }
  if (nextType === 'trip_start' || nextType === 'trip_end') {
    throw new Error('運行開始/終了には変更できません');
  }
  if (PROTECTED_TYPES.has(source.type) || PROTECTED_TYPES.has(nextType)) {
    throw new Error('フェリー・高速道路の開始/終了は、ICや休息との連動を保つため項目変更できません。');
  }

  const tripEvents = allEvents.filter(event => event.tripId === source.tripId);
  const sourceInfo = getBasicTypeInfo(source.type);
  const targetInfo = getBasicTypeInfo(nextType);

  if (!sourceInfo || !targetInfo) return planInstantConversion(source, nextType);
  if (sourceInfo.role !== targetInfo.role) {
    throw new Error('開始は別の開始項目へ、終了は別の終了項目へ変更してください。');
  }

  const pairResolution = findSafeBasicPair(tripEvents, source, sourceInfo);
  if (pairResolution.ambiguous) {
    throw new Error('対応する開始/終了記録を1件に特定できないため、項目を変更できません。');
  }
  const paired = pairResolution.paired;
  if (!paired && sourceInfo.role === 'end') {
    throw new Error('この終了記録に対応する開始記録が見つからないため、項目を変更できません。');
  }
  if (
    isFerryCoupledRestEvent(tripEvents, source)
    || (paired ? isFerryCoupledRestEvent(tripEvents, paired) : false)
  ) {
    throw new Error('フェリー乗船と連動する休息は、下船時の自動終了を保つため項目変更できません。');
  }

  const pairedNextType = paired
    ? (targetInfo.role === 'start'
      ? targetInfo.definition.end as EventType
      : targetInfo.definition.start as EventType)
    : null;
  assertRestStartOdometer(source, nextType);
  if (paired && pairedNextType) assertRestStartOdometer(paired, pairedNextType);

  const sessionId = pickSessionId(source, sourceInfo.definition, paired, createSessionId);
  const updates: EventTypeConversionUpdate[] = [{
    id: source.id,
    previousType: source.type,
    type: nextType,
    extras: normalizeExtrasForType(source.extras, nextType, targetInfo.definition, sessionId),
  }];

  if (paired && pairedNextType) {
    updates.push({
      id: paired.id,
      previousType: paired.type,
      type: pairedNextType,
      extras: normalizeExtrasForType(
        paired.extras,
        pairedNextType,
        targetInfo.definition,
        sessionId,
      ),
    });
  }

  return {
    tripId: source.tripId,
    changed: true,
    sourceEvent: source,
    ...(paired ? { pairedEvent: paired } : {}),
    updates,
  };
}

/** Options used by the edit UI so impossible role flips are not offered. */
export function getEditableEventTypeOptions(
  allEvents: readonly AppEvent[],
  eventId: string,
): EventType[] {
  const source = allEvents.find(event => event.id === eventId);
  if (!source) return [];
  const info = getBasicTypeInfo(source.type);
  if (info) {
    const tripEvents = allEvents.filter(event => event.tripId === source.tripId);
    const pairResolution = findSafeBasicPair(tripEvents, source, info);
    const paired = pairResolution.paired;
    if (
      pairResolution.ambiguous
      || (info.role === 'end' && !paired)
      || isFerryCoupledRestEvent(tripEvents, source)
      || (paired ? isFerryCoupledRestEvent(tripEvents, paired) : false)
    ) {
      return [source.type];
    }
    return EDITABLE_BASIC_DEFINITIONS.map(definition => (
      (info.role === 'start' ? definition.start : definition.end) as EventType
    )).filter(type => (
      type !== (info.role === 'start' ? 'rest_start' : 'rest_end')
      || source.type === type
      || hasValidRestOdometer(info.role === 'start' ? source : paired)
    ));
  }
  if (source.type === 'refuel') return ['refuel', 'point_mark'];
  if (source.type === 'point_mark' && Number(source.extras?.liters) > 0) {
    return ['point_mark', 'refuel'];
  }
  return [source.type];
}
