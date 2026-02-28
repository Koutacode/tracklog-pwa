import { Capacitor, registerPlugin } from '@capacitor/core';
import type { BackgroundGeolocationPlugin } from '@capacitor-community/background-geolocation';
import { LocalNotifications } from '@capacitor/local-notifications';

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

type NativeSetupPlugin = {
  checkBatteryOptimization(): Promise<{ supported: boolean; granted: boolean }>;
  requestBatteryOptimizationExemption(): Promise<{
    supported: boolean;
    granted: boolean;
    opened: boolean;
    fallback?: boolean;
  }>;
};

const NativeSetup = registerPlugin<NativeSetupPlugin>('NativeSetup');

export type SimplePermissionState = 'granted' | 'denied' | 'unknown';

export type NativeSetupStep = {
  id: string;
  label: string;
  level: 'ok' | 'warn' | 'error';
  detail: string;
};

const LOCATION_STATUS_CACHE_MS = 60000;
let locationStatusCache: { value: SimplePermissionState; at: number } | null = null;

function isNative() {
  return Capacitor.isNativePlatform();
}

function wait(ms: number) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function toSimpleState(input: unknown): SimplePermissionState {
  if (input === 'granted') return 'granted';
  if (input === 'denied') return 'denied';
  return 'unknown';
}

function toNotificationPermissionState(input: unknown): SimplePermissionState {
  if (!input || typeof input !== 'object') return 'unknown';
  const value =
    (input as { display?: unknown; receive?: unknown; status?: unknown }).display ??
    (input as { receive?: unknown }).receive ??
    (input as { status?: unknown }).status;
  return toSimpleState(value);
}

async function checkGeoPermissionByPermissionsApi(): Promise<SimplePermissionState> {
  try {
    if (!navigator.permissions?.query) return 'unknown';
    const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
    return toSimpleState(status.state);
  } catch {
    return 'unknown';
  }
}

async function probeGeoPermissionByFix(): Promise<SimplePermissionState> {
  if (!navigator.geolocation) return 'unknown';
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      () => resolve('granted'),
      err => {
        if (err?.code === 1) {
          resolve('denied');
          return;
        }
        resolve('unknown');
      },
      {
        enableHighAccuracy: false,
        timeout: 5000,
        maximumAge: 0,
      },
    );
  });
}

async function probeGeoPermissionByBackgroundWatcher(timeoutMs = 1500): Promise<SimplePermissionState> {
  if (!isNative()) return 'unknown';
  return new Promise(resolve => {
    let watcherId: string | null = null;
    let settled = false;
    const timer = window.setTimeout(() => {
      finish('unknown');
    }, timeoutMs);

    const finish = (state: SimplePermissionState) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      void (async () => {
        if (watcherId) {
          try {
            await BackgroundGeolocation.removeWatcher({ id: watcherId });
          } catch {
            // ignore cleanup errors
          }
        }
        resolve(state);
      })();
    };

    void (async () => {
      try {
        watcherId = await BackgroundGeolocation.addWatcher(
          {
            requestPermissions: false,
            stale: true,
            distanceFilter: 1000,
          },
          (location, error) => {
            if (error?.code === 'NOT_AUTHORIZED') {
              finish('denied');
              return;
            }
            if (location) {
              finish('granted');
            }
          },
        );
      } catch (e: any) {
        const text = String(e?.message ?? e ?? '');
        if (text.includes('NOT_AUTHORIZED')) {
          finish('denied');
          return;
        }
        finish('unknown');
      }
    })();
  });
}

export async function checkLocationPermissionStatus(): Promise<SimplePermissionState> {
  const now = Date.now();
  if (locationStatusCache && now - locationStatusCache.at < LOCATION_STATUS_CACHE_MS) {
    return locationStatusCache.value;
  }
  let state = await checkGeoPermissionByPermissionsApi();
  if (state === 'unknown' && isNative()) {
    state = await probeGeoPermissionByBackgroundWatcher();
  }
  locationStatusCache = { value: state, at: now };
  return state;
}

export async function requestLocationPermission(): Promise<SimplePermissionState> {
  if (!isNative()) return 'unknown';
  let watcherId: string | null = null;
  let deniedByPlugin = false;
  try {
    watcherId = await BackgroundGeolocation.addWatcher(
      {
        requestPermissions: true,
        stale: true,
        distanceFilter: 1000,
      },
      (_location, error) => {
        if (error?.code === 'NOT_AUTHORIZED') {
          deniedByPlugin = true;
        }
      },
    );
    await wait(700);
  } catch (e: any) {
    const text = String(e?.message ?? e ?? '');
    if (text.includes('NOT_AUTHORIZED')) {
      deniedByPlugin = true;
    }
  } finally {
    if (watcherId) {
      try {
        await BackgroundGeolocation.removeWatcher({ id: watcherId });
      } catch {
        // ignore cleanup errors
      }
    }
  }

  const apiState = await checkGeoPermissionByPermissionsApi();
  if (apiState !== 'unknown') {
    locationStatusCache = { value: apiState, at: Date.now() };
    return apiState;
  }
  if (deniedByPlugin) {
    locationStatusCache = { value: 'denied', at: Date.now() };
    return 'denied';
  }
  const probed = await probeGeoPermissionByFix();
  locationStatusCache = { value: probed, at: Date.now() };
  return probed;
}

export async function checkNotificationPermissionStatus(): Promise<SimplePermissionState> {
  if (!isNative()) return 'unknown';
  let state: SimplePermissionState = 'unknown';
  try {
    const current = await LocalNotifications.checkPermissions();
    state = toNotificationPermissionState(current);
  } catch {
    state = 'unknown';
  }
  if (state !== 'unknown') return state;
  try {
    const enabled = await LocalNotifications.areEnabled();
    if (typeof enabled?.value === 'boolean') {
      return enabled.value ? 'granted' : 'denied';
    }
  } catch {
    // ignore and fallback below
  }
  if (typeof Notification !== 'undefined') {
    return toSimpleState(Notification.permission);
  }
  return 'unknown';
}

export async function requestNotificationPermission(): Promise<SimplePermissionState> {
  if (!isNative()) return 'unknown';
  const currentState = await checkNotificationPermissionStatus();
  if (currentState === 'granted' || currentState === 'denied') {
    return currentState;
  }
  try {
    const requested = await LocalNotifications.requestPermissions();
    const requestedState = toNotificationPermissionState(requested);
    if (requestedState !== 'unknown') return requestedState;
  } catch {
    // ignore and retry below
  }
  return checkNotificationPermissionStatus();
}

export async function checkExactAlarmStatus(): Promise<SimplePermissionState> {
  if (!isNative()) return 'unknown';
  try {
    const status = await LocalNotifications.checkExactNotificationSetting();
    if (status.exact_alarm === 'granted') return 'granted';
    if (status.exact_alarm === 'denied') return 'denied';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function openExactAlarmSettings(): Promise<boolean> {
  if (!isNative()) return false;
  try {
    await LocalNotifications.changeExactNotificationSetting();
    return true;
  } catch {
    return false;
  }
}

export async function checkBatteryOptimizationStatus(): Promise<SimplePermissionState> {
  if (!isNative()) return 'unknown';
  try {
    const status = await NativeSetup.checkBatteryOptimization();
    if (!status.supported) return 'granted';
    return status.granted ? 'granted' : 'denied';
  } catch {
    return 'unknown';
  }
}

export async function requestBatteryOptimizationExemption(): Promise<{
  state: SimplePermissionState;
  opened: boolean;
  fallback?: boolean;
}> {
  if (!isNative()) return { state: 'unknown', opened: false };
  try {
    const result = await NativeSetup.requestBatteryOptimizationExemption();
    const state = !result.supported || result.granted ? 'granted' : 'denied';
    return { state, opened: !!result.opened, fallback: result.fallback };
  } catch {
    return { state: 'unknown', opened: false };
  }
}

export async function runNativeQuickSetup(): Promise<{
  steps: NativeSetupStep[];
  requiresManualFollowUp: boolean;
}> {
  const steps: NativeSetupStep[] = [];
  if (!isNative()) {
    steps.push({
      id: 'native-only',
      label: '一括セットアップ',
      level: 'warn',
      detail: 'ネイティブ版のみ利用できます。',
    });
    return { steps, requiresManualFollowUp: true };
  }

  const geo = await requestLocationPermission();
  steps.push({
    id: 'geo',
    label: '位置情報権限',
    level: geo === 'granted' ? 'ok' : geo === 'denied' ? 'error' : 'warn',
    detail:
      geo === 'granted'
        ? '許可済み'
        : geo === 'denied'
          ? '拒否されています。端末設定で「常に許可」に変更してください。'
          : '状態を確定できません。端末設定で確認してください。',
  });

  const notif = await requestNotificationPermission();
  steps.push({
    id: 'notif',
    label: '通知権限',
    level: notif === 'granted' ? 'ok' : notif === 'denied' ? 'error' : 'warn',
    detail:
      notif === 'granted'
        ? '許可済み'
        : notif === 'denied'
          ? '拒否されています。通知設定を許可してください。'
          : '状態を確定できません。通知設定を確認してください。',
  });

  const batteryBefore = await checkBatteryOptimizationStatus();
  if (batteryBefore === 'granted') {
    steps.push({
      id: 'battery-opt',
      label: '電池最適化',
      level: 'ok',
      detail: '最適化除外済み',
    });
  } else {
    const batteryRequest = await requestBatteryOptimizationExemption();
    const batteryAfter = await checkBatteryOptimizationStatus();
    const openedText = batteryRequest.opened ? '設定画面を開きました。' : '';
    steps.push({
      id: 'battery-opt',
      label: '電池最適化',
      level: batteryAfter === 'granted' ? 'ok' : 'warn',
      detail:
        batteryAfter === 'granted'
          ? '最適化除外済み'
          : `${openedText}端末側で「最適化しない」を選択してください。`,
    });
  }

  const exactBefore = await checkExactAlarmStatus();
  if (exactBefore === 'granted') {
    steps.push({
      id: 'exact-alarm',
      label: 'Exact Alarm',
      level: 'ok',
      detail: '有効',
    });
  } else {
    const opened = await openExactAlarmSettings();
    const exactAfter = await checkExactAlarmStatus();
    steps.push({
      id: 'exact-alarm',
      label: 'Exact Alarm',
      level: exactAfter === 'granted' ? 'ok' : 'warn',
      detail:
        exactAfter === 'granted'
          ? '有効'
          : `${opened ? '設定画面を開きました。' : ''}端末側で有効化してください。`,
    });
  }

  const requiresManualFollowUp = steps.some(step => step.level !== 'ok');
  return { steps, requiresManualFollowUp };
}
