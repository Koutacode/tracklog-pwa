import type { AppEvent, EventType } from './types';

const CONTINUOUS_DRIVE_LIMIT_MIN = 4 * 60;
const CONTINUOUS_DRIVE_EMERGENCY_LIMIT_MIN = 4 * 60 + 30;

export type LiveDriveCategory = 'idle' | 'drive' | 'break' | 'rest' | 'load' | 'unload' | 'wait' | 'work';

export type LiveDriveStatus = {
  currentCategory: LiveDriveCategory;
  currentCategoryLabel: string;
  currentCategoryStartedAt: string | null;
  driveSinceResetMinutes: number;
  qualifyingResetMinutes: number;
  currentNonDrivingMinutes: number;
  resetCompleted: boolean;
  resetCompletedAt: string | null;
  lastResetAt: string | null;
  remainingUntilResetMinutes: number;
  remainingUntilLimitMinutes: number;
  remainingUntilEmergencyLimitMinutes: number;
  continuousDriveExceeded: boolean;
  continuousDriveEmergencyExceeded: boolean;
};

type LiveState = {
  category: LiveDriveCategory;
  tripActive: boolean;
};

function diffMinutes(startIso: string, endIso: string) {
  return Math.max(0, Math.floor((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000));
}

function addMinutes(iso: string, minutes: number) {
  return new Date(new Date(iso).getTime() + minutes * 60000).toISOString();
}

function categoryLabel(category: LiveDriveCategory) {
  switch (category) {
    case 'drive':
      return '運転';
    case 'break':
      return '休憩';
    case 'rest':
      return '休息';
    case 'load':
      return '積込';
    case 'unload':
      return '荷卸';
    case 'wait':
      return '待機';
    case 'work':
      return '業務';
    default:
      return '待機';
  }
}

function categoryAfterEvent(
  type: EventType,
  currentCategory: LiveDriveCategory,
  tripActive: boolean,
): LiveState {
  switch (type) {
    case 'trip_start':
      return { category: 'drive', tripActive: true };
    case 'trip_end':
      return { category: 'idle', tripActive: false };
    case 'rest_start':
      return { category: 'rest', tripActive: true };
    case 'rest_end':
      return { category: 'drive', tripActive: true };
    case 'break_start':
      return { category: 'break', tripActive: true };
    case 'break_end':
      return { category: tripActive ? 'drive' : 'idle', tripActive };
    case 'load_start':
      return { category: 'load', tripActive: true };
    case 'load_end':
      return { category: tripActive ? 'drive' : 'idle', tripActive };
    case 'unload_start':
      return { category: 'unload', tripActive: true };
    case 'unload_end':
      return { category: tripActive ? 'drive' : 'idle', tripActive };
    case 'boarding':
    case 'disembark':
    case 'expressway':
    case 'expressway_start':
    case 'expressway_end':
    case 'point_mark':
    case 'refuel':
      return { category: currentCategory, tripActive };
    default:
      return { category: currentCategory, tripActive };
  }
}

export function computeLiveDriveStatus(events: AppEvent[], nowIso = new Date().toISOString()): LiveDriveStatus {
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  const tripStartIndex = sorted.findIndex(event => event.type === 'trip_start');
  if (tripStartIndex < 0) {
    return {
      currentCategory: 'idle',
      currentCategoryLabel: categoryLabel('idle'),
      currentCategoryStartedAt: null,
      driveSinceResetMinutes: 0,
      qualifyingResetMinutes: 0,
      currentNonDrivingMinutes: 0,
      resetCompleted: false,
      resetCompletedAt: null,
      lastResetAt: null,
      remainingUntilResetMinutes: 30,
      remainingUntilLimitMinutes: CONTINUOUS_DRIVE_LIMIT_MIN,
      remainingUntilEmergencyLimitMinutes: CONTINUOUS_DRIVE_EMERGENCY_LIMIT_MIN,
      continuousDriveExceeded: false,
      continuousDriveEmergencyExceeded: false,
    };
  }

  const relevant = sorted.slice(tripStartIndex);
  let state: LiveState = { category: 'idle', tripActive: false };
  let categoryStartedAt: string | null = null;
  let cursor = relevant[0].ts;
  let driveSinceReset = 0;
  let qualifyingResetMinutes = 0;
  let lastResetAt: string | null = null;
  let currentNonDrivingMinutes = 0;
  let currentResetCompleted = false;
  let currentResetCompletedAt: string | null = null;

  const processInterval = (startIso: string, endIso: string, isCurrentInterval: boolean) => {
    const duration = diffMinutes(startIso, endIso);
    if (duration <= 0 || !state.tripActive) {
      if (isCurrentInterval) {
        currentNonDrivingMinutes = 0;
        currentResetCompleted = false;
        currentResetCompletedAt = null;
      }
      return;
    }

    if (state.category === 'drive') {
      if (qualifyingResetMinutes < 30) {
        qualifyingResetMinutes = 0;
      }
      driveSinceReset += duration;
      if (isCurrentInterval) {
        currentNonDrivingMinutes = 0;
        currentResetCompleted = false;
        currentResetCompletedAt = null;
      }
      return;
    }

    const startingQualifying = qualifyingResetMinutes;
    if (isCurrentInterval) {
      currentNonDrivingMinutes = duration;
      if (duration >= 10) {
        const progress = Math.min(30, startingQualifying + duration);
        currentResetCompleted = progress >= 30;
        currentResetCompletedAt =
          progress >= 30 ? addMinutes(startIso, Math.max(0, 30 - startingQualifying)) : null;
      } else {
        currentResetCompleted = false;
        currentResetCompletedAt = null;
      }
    }

    if (duration < 10) {
      qualifyingResetMinutes = 0;
      return;
    }

    const needed = 30 - qualifyingResetMinutes;
    if (duration >= needed) {
      const resetAt = addMinutes(startIso, Math.max(0, needed));
      driveSinceReset = 0;
      qualifyingResetMinutes = 0;
      lastResetAt = resetAt;
      return;
    }

    qualifyingResetMinutes += duration;
  };

  for (const event of relevant) {
    processInterval(cursor, event.ts, false);
    const next = categoryAfterEvent(event.type, state.category, state.tripActive);
    if (next.category !== state.category || next.tripActive !== state.tripActive) {
      categoryStartedAt = event.ts;
    } else if (!categoryStartedAt) {
      categoryStartedAt = event.ts;
    }
    state = next;
    cursor = event.ts;
  }

  processInterval(cursor, nowIso, true);

  return {
    currentCategory: state.category,
    currentCategoryLabel: categoryLabel(state.category),
    currentCategoryStartedAt: categoryStartedAt,
    driveSinceResetMinutes: driveSinceReset,
    qualifyingResetMinutes,
    currentNonDrivingMinutes,
    resetCompleted: currentResetCompleted,
    resetCompletedAt: currentResetCompletedAt,
    lastResetAt,
    remainingUntilResetMinutes: Math.max(0, 30 - qualifyingResetMinutes),
    remainingUntilLimitMinutes: Math.max(0, CONTINUOUS_DRIVE_LIMIT_MIN - driveSinceReset),
    remainingUntilEmergencyLimitMinutes: Math.max(0, CONTINUOUS_DRIVE_EMERGENCY_LIMIT_MIN - driveSinceReset),
    continuousDriveExceeded: driveSinceReset > CONTINUOUS_DRIVE_LIMIT_MIN,
    continuousDriveEmergencyExceeded: driveSinceReset > CONTINUOUS_DRIVE_EMERGENCY_LIMIT_MIN,
  };
}
