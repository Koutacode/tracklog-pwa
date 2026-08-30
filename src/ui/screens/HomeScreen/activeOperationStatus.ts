import type { AppEvent } from '../../../domain/types';
import type { LiveDriveStatus } from '../../../domain/liveDriveStatus';
import {
  EXPRESSWAY_TOGGLE_DEFINITION,
  PERSISTED_BASIC_TOGGLE_DEFINITIONS,
  findOpenToggleStart,
} from '../../../domain/togglePairing';
import { formatRoundedJstTime } from '../../../domain/reportLogic';

export type ActiveOperationStatus = {
  channel: 'base' | 'ferry' | 'expressway';
  kind: string;
  label: string;
  startedAt: string;
  origin: 'manual' | 'automatic' | 'derived';
  startedLabel: '開始' | '乗船';
  annotation?: string;
};

const REST = PERSISTED_BASIC_TOGGLE_DEFINITIONS[0];
const FERRY = PERSISTED_BASIC_TOGGLE_DEFINITIONS[4];

export function buildActiveOperationStatuses(
  events: AppEvent[],
  liveDrive: LiveDriveStatus,
): ActiveOperationStatus[] {
  const statuses: ActiveOperationStatus[] = [];
  const rest = findOpenToggleStart(events, REST);
  const ferry = findOpenToggleStart(events, FERRY);
  const expressway = findOpenToggleStart(events, EXPRESSWAY_TOGGLE_DEFINITION);

  if (liveDrive.currentCategory !== 'idle' && liveDrive.currentCategoryStartedAt) {
    const ferryGeneratedRest = liveDrive.currentCategory === 'rest'
      && rest?.extras?.autoReason === 'ferry_boarding';
    statuses.push({
      channel: 'base',
      kind: liveDrive.currentCategory,
      label: `${liveDrive.currentCategoryLabel}中`,
      startedAt: liveDrive.currentCategoryStartedAt,
      origin: ferryGeneratedRest ? 'automatic' : 'derived',
      startedLabel: '開始',
      annotation: liveDrive.currentCategory === 'rest' && ferry
        ? ferryGeneratedRest
          ? 'フェリー乗船と同時に開始'
          : '乗船前から継続'
        : undefined,
    });
  }

  if (ferry) {
    statuses.push({
      channel: 'ferry',
      kind: 'ferry',
      label: 'フェリー乗船中',
      startedAt: ferry.ts,
      origin: 'manual',
      startedLabel: '乗船',
    });
  }

  if (expressway) {
    statuses.push({
      channel: 'expressway',
      kind: 'expressway',
      label: '高速道路走行中',
      startedAt: expressway.ts,
      origin: expressway.extras?.autoDecision && typeof expressway.extras.autoDecision === 'object'
        ? 'automatic'
        : 'manual',
      startedLabel: '開始',
    });
  }

  return statuses.slice(0, 3);
}

export function formatElapsedHoursMinutes(startedAt: string, nowMs: number): string {
  const elapsedMinutes = Math.max(0, Math.floor((nowMs - Date.parse(startedAt)) / 60000));
  const hours = Math.floor(elapsedMinutes / 60);
  const minutes = elapsedMinutes % 60;
  if (hours === 0) return `${minutes}分`;
  return minutes === 0 ? `${hours}時間` : `${hours}時間${String(minutes).padStart(2, '0')}分`;
}

export function formatStartedClock(startedAt: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(startedAt));
}

export function buildRestMilestones(restStartedAt: string) {
  return [8, 9, 10, 12].map(hours => ({
    hours,
    clock: formatRoundedJstTime(
      new Date(Date.parse(restStartedAt) + hours * 60 * 60 * 1000).toISOString(),
    ),
  }));
}
