import type { AppEvent } from '../../domain/types';

type ExpresswayEventType = 'expressway' | 'expressway_start' | 'expressway_end';

export type ExpresswayHistoryEvent = Pick<AppEvent, 'id' | 'tripId' | 'type' | 'ts' | 'extras'> & {
  type: ExpresswayEventType;
};

export type IcDisplayState = 'resolved' | 'pending' | 'unresolved';

export type IcEndpointSummary = {
  label: string;
  state: IcDisplayState;
};

export type ExpresswayHistorySegment = {
  start?: IcEndpointSummary;
  end?: IcEndpointSummary;
  startedAt?: string;
  endedAt?: string;
  pairing: 'exact' | 'fallback' | 'open' | 'orphan' | 'legacy';
};

export type TripExpresswayHistorySummary = {
  latest: ExpresswayHistorySegment;
  segmentCount: number;
};

export type ExpresswayHistoryDisplay = {
  routeLabel: string;
  countLabel?: string;
  state: IcDisplayState;
};

type PendingStart = {
  event: ExpresswayHistoryEvent;
  sessionId: string | null;
};

function readString(extras: Record<string, unknown> | undefined, key: string): string | null {
  const value = extras?.[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function getSessionId(event: ExpresswayHistoryEvent): string | null {
  return readString(event.extras, 'expresswaySessionId');
}

function summarizeIc(event: ExpresswayHistoryEvent): IcEndpointSummary {
  const name = readString(event.extras, 'icName');
  const status = readString(event.extras, 'icResolveStatus');
  const nextRetryAt = readString(event.extras, 'icResolveNextRetryAt');

  if (status === 'pending') {
    return {
      label: name ? `${name}（確認中）` : '確認中',
      state: 'pending',
    };
  }

  if (status === 'failed') {
    if (nextRetryAt) {
      return {
        label: name ? `${name}（再確認待ち）` : '再確認待ち',
        state: 'pending',
      };
    }
    return {
      label: name ? `${name}（未確定）` : '未特定',
      state: 'unresolved',
    };
  }

  if (name) {
    return { label: name, state: 'resolved' };
  }

  return { label: '未特定', state: 'unresolved' };
}

function eventOrder(left: ExpresswayHistoryEvent, right: ExpresswayHistoryEvent): number {
  const byTimestamp = left.ts.localeCompare(right.ts);
  if (byTimestamp !== 0) return byTimestamp;

  const phase: Record<ExpresswayEventType, number> = {
    expressway_start: 0,
    expressway_end: 1,
    expressway: 2,
  };
  const byPhase = phase[left.type] - phase[right.type];
  if (byPhase !== 0) return byPhase;
  return left.id.localeCompare(right.id);
}

function segmentSortStamp(segment: ExpresswayHistorySegment): string {
  return segment.endedAt ?? segment.startedAt ?? '';
}

/**
 * Builds one lightweight IC summary per trip without retaining location data.
 * Explicit session IDs are matched first; legacy/missing IDs then fall back to
 * the oldest causally open start so imported histories stay readable.
 */
export function buildTripExpresswayHistorySummaries(
  events: readonly AppEvent[],
): Map<string, TripExpresswayHistorySummary> {
  const byTrip = new Map<string, ExpresswayHistoryEvent[]>();

  for (const event of events) {
    if (
      event.type !== 'expressway'
      && event.type !== 'expressway_start'
      && event.type !== 'expressway_end'
    ) {
      continue;
    }
    const expresswayEvent = event as ExpresswayHistoryEvent;
    const tripEvents = byTrip.get(event.tripId) ?? [];
    tripEvents.push(expresswayEvent);
    byTrip.set(event.tripId, tripEvents);
  }

  const summaries = new Map<string, TripExpresswayHistorySummary>();
  for (const [tripId, tripEvents] of byTrip) {
    const openStarts: PendingStart[] = [];
    const segments: ExpresswayHistorySegment[] = [];

    for (const event of [...tripEvents].sort(eventOrder)) {
      if (event.type === 'expressway') {
        segments.push({
          start: summarizeIc(event),
          startedAt: event.ts,
          pairing: 'legacy',
        });
        continue;
      }

      if (event.type === 'expressway_start') {
        openStarts.push({ event, sessionId: getSessionId(event) });
        continue;
      }

      const endSessionId = getSessionId(event);
      let startIndex = endSessionId
        ? openStarts.findIndex(start => start.sessionId === endSessionId)
        : -1;
      if (startIndex < 0 && openStarts.length > 0) {
        // Never combine two contradictory explicit identities. Fallback is
        // reserved for imported/legacy data where at least one side lacks an ID.
        startIndex = endSessionId
          ? openStarts.findIndex(start => start.sessionId === null)
          : 0;
      }
      const matched = startIndex >= 0 ? openStarts.splice(startIndex, 1)[0] : undefined;

      if (!matched) {
        segments.push({
          end: summarizeIc(event),
          endedAt: event.ts,
          pairing: 'orphan',
        });
        continue;
      }

      segments.push({
        start: summarizeIc(matched.event),
        end: summarizeIc(event),
        startedAt: matched.event.ts,
        endedAt: event.ts,
        pairing:
          matched.sessionId !== null && matched.sessionId === endSessionId
            ? 'exact'
            : 'fallback',
      });
    }

    for (const open of openStarts) {
      segments.push({
        start: summarizeIc(open.event),
        startedAt: open.event.ts,
        pairing: 'open',
      });
    }

    segments.sort((left, right) => segmentSortStamp(left).localeCompare(segmentSortStamp(right)));
    const latest = segments[segments.length - 1];
    if (latest) {
      summaries.set(tripId, { latest, segmentCount: segments.length });
    }
  }

  return summaries;
}

function strongestState(states: IcDisplayState[]): IcDisplayState {
  if (states.includes('unresolved')) return 'unresolved';
  if (states.includes('pending')) return 'pending';
  return 'resolved';
}

export function formatTripExpresswayHistorySummary(
  summary: TripExpresswayHistorySummary,
  options: { tripActive: boolean },
): ExpresswayHistoryDisplay {
  const { latest } = summary;
  const countLabel = summary.segmentCount > 1 ? `ほか${summary.segmentCount - 1}区間` : undefined;

  if (latest.pairing === 'legacy') {
    return {
      routeLabel: `${latest.start?.label ?? '未特定'}（旧形式）`,
      countLabel,
      state: latest.start?.state ?? 'unresolved',
    };
  }

  if (latest.pairing === 'orphan') {
    return {
      routeLabel: `開始記録なし → ${latest.end?.label ?? '未特定'}`,
      countLabel,
      state: 'unresolved',
    };
  }

  if (latest.pairing === 'open') {
    const endLabel = options.tripActive ? '走行中' : '終了記録なし';
    return {
      routeLabel: `${latest.start?.label ?? '未特定'} → ${endLabel}`,
      countLabel,
      state: options.tripActive
        ? strongestState([latest.start?.state ?? 'unresolved', 'pending'])
        : 'unresolved',
    };
  }

  return {
    routeLabel: `${latest.start?.label ?? '未特定'} → ${latest.end?.label ?? '未特定'}`,
    countLabel,
    state: strongestState([
      latest.start?.state ?? 'unresolved',
      latest.end?.state ?? 'unresolved',
    ]),
  };
}
