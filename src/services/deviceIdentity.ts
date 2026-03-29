import { Capacitor, registerPlugin } from '@capacitor/core';
import { db } from '../db/db';
import { uuid } from '../db/repositories';

type DeviceIdentityPlugin = {
  getStableDeviceKey: () => Promise<{
    stableDeviceKey: string;
    source: string;
  }>;
};

const DeviceIdentity = registerPlugin<DeviceIdentityPlugin>('DeviceIdentity');

const META_STABLE_DEVICE_KEY = 'device_stable_key';
const META_STABLE_DEVICE_KEY_SOURCE = 'device_stable_key_source';

function nowIso() {
  return new Date().toISOString();
}

async function getMeta(key: string) {
  const row = await db.meta.get(key);
  return row?.value ?? null;
}

async function setMeta(key: string, value: string | null) {
  if (!value) {
    await db.meta.delete(key);
    return;
  }
  await db.meta.put({
    key,
    value,
    updatedAt: nowIso(),
  });
}

function buildWebStableKey() {
  return `web:${uuid()}`;
}

export async function getStoredStableDeviceKey() {
  return getMeta(META_STABLE_DEVICE_KEY);
}

export async function getStableDeviceKey(): Promise<{
  stableDeviceKey: string;
  source: string;
}> {
  const storedKey = await getMeta(META_STABLE_DEVICE_KEY);
  const storedSource = await getMeta(META_STABLE_DEVICE_KEY_SOURCE);
  if (storedKey) {
    return {
      stableDeviceKey: storedKey,
      source: storedSource || 'stored',
    };
  }

  let next: { stableDeviceKey: string; source: string } | null = null;
  if (Capacitor.getPlatform() === 'android') {
    try {
      const result = await DeviceIdentity.getStableDeviceKey();
      if (result?.stableDeviceKey?.trim()) {
        next = {
          stableDeviceKey: `android:${result.stableDeviceKey.trim()}`,
          source: result.source || 'android_id',
        };
      }
    } catch {
      next = null;
    }
  }

  if (!next) {
    next = {
      stableDeviceKey: buildWebStableKey(),
      source: Capacitor.isNativePlatform() ? 'native_fallback' : 'web_local',
    };
  }

  await Promise.all([
    setMeta(META_STABLE_DEVICE_KEY, next.stableDeviceKey),
    setMeta(META_STABLE_DEVICE_KEY_SOURCE, next.source),
  ]);
  return next;
}

function looksLikeLegacyAnonymousId(value?: string | null) {
  return !!value?.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
}

export async function resolveStableDeviceId(currentDeviceId?: string | null) {
  if (currentDeviceId?.trim() && !looksLikeLegacyAnonymousId(currentDeviceId)) {
    return currentDeviceId.trim();
  }
  const stable = await getStableDeviceKey();
  return stable.stableDeviceKey;
}
