import type { TracklogRuntimeConfig } from '../domain/remoteTypes';
import {
  getTracklogRuntimeConfigViaFunction,
  updateTracklogRuntimeConfigViaFunction,
} from './tracklogPrivilegedApi';

export const DEFAULT_LOCATION_NOTIFICATION_TEXT = '位置記録中';

const CONFIG_CACHE_MS = 5 * 60 * 1000;
const MAX_NOTIFICATION_TEXT_LENGTH = 40;

let cachedConfig: TracklogRuntimeConfig | null = null;
let cachedAt = 0;
let pendingLoad: Promise<TracklogRuntimeConfig> | null = null;

export function normalizeLocationNotificationText(text?: string | null) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return DEFAULT_LOCATION_NOTIFICATION_TEXT;
  return Array.from(trimmed).slice(0, MAX_NOTIFICATION_TEXT_LENGTH).join('');
}

function fallbackConfig(): TracklogRuntimeConfig {
  return {
    locationNotificationText: DEFAULT_LOCATION_NOTIFICATION_TEXT,
    updatedAt: null,
  };
}

export async function loadTracklogRuntimeConfig(options?: {
  force?: boolean;
  admin?: boolean;
}): Promise<TracklogRuntimeConfig> {
  const now = Date.now();
  if (!options?.force && cachedConfig && now - cachedAt < CONFIG_CACHE_MS) {
    return cachedConfig;
  }
  if (!pendingLoad) {
    pendingLoad = getTracklogRuntimeConfigViaFunction({ admin: options?.admin })
      .then(config => ({
        locationNotificationText: normalizeLocationNotificationText(config.locationNotificationText),
        updatedAt: config.updatedAt ?? null,
      }))
      .catch(() => fallbackConfig())
      .finally(() => {
        pendingLoad = null;
      });
  }
  const config = await pendingLoad;
  cachedConfig = config;
  cachedAt = Date.now();
  return config;
}

export async function saveTracklogRuntimeConfig(input: {
  locationNotificationText: string;
}): Promise<TracklogRuntimeConfig> {
  const config = await updateTracklogRuntimeConfigViaFunction({
    locationNotificationText: normalizeLocationNotificationText(input.locationNotificationText),
  });
  cachedConfig = {
    locationNotificationText: normalizeLocationNotificationText(config.locationNotificationText),
    updatedAt: config.updatedAt ?? null,
  };
  cachedAt = Date.now();
  return cachedConfig;
}
