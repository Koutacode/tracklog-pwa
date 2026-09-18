import { Capacitor, registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { requestRouteTrackingSync } from '../app/routeTrackingSignal';

type NativeSetupPlugin = {
  checkBatteryOptimization(): Promise<{ supported: boolean; granted: boolean }>;
  checkLocationPermissions(): Promise<{
    fine?: boolean;
    coarse?: boolean;
    foreground?: boolean;
    background?: boolean;
    backgroundRelevant?: boolean;
  }>;
  requestLocationPermission(): ReturnType<NativeSetupPlugin['checkLocationPermissions']>;
  requestBackgroundLocationPermission(): Promise<{ requested: boolean; granted: boolean }>;
  getSetupSnapshot(options?: { fresh?: boolean }): Promise<NativeSetupSnapshot>;
  openAppSettings(): Promise<NativeSettingsOpenResult>;
  openLocationSettings(): Promise<NativeSettingsOpenResult>;
  openNotificationSettings(): Promise<NativeSettingsOpenResult>;
  openResidentNotificationSettings(): Promise<NativeSettingsOpenResult>;
  requestBatteryOptimizationExemption(): Promise<{
    supported: boolean;
    granted: boolean;
    opened: boolean;
    fallback?: boolean;
    destination?: string;
    fallbackLevel?: number;
  }>;
};

const NativeSetup = registerPlugin<NativeSetupPlugin>('NativeSetup');

export type SimplePermissionState = 'granted' | 'denied' | 'unknown';
export type NativeNotificationPermissionState =
  | SimplePermissionState
  | 'prompt'
  | 'prompt-with-rationale';

export type NativeSetupStep = {
  id: NativeSetupStepId | 'native-only';
  label: string;
  level: 'ok' | 'warn' | 'error';
  detail: string;
  instruction?: string;
};

export type NativeSetupStepId =
  | 'location-enabled'
  | 'location-precise'
  | 'location-background'
  | 'notification'
  | 'battery-opt'
  | 'resident-service';

export type NativeSettingsOpenResult = {
  opened: boolean;
  destination: string;
  fallbackLevel: number;
};

export type NativeSetupSnapshot = {
  androidSdkInt: number | null;
  locationEnabled: boolean;
  fine: boolean;
  coarse: boolean;
  foreground: boolean;
  background: boolean;
  backgroundRelevant: boolean;
  backgroundPermissionOptionLabel: string;
  notifications: boolean;
  residentNotificationChannelExists: boolean;
  residentNotificationChannelEnabled: boolean;
  batteryOptimization: boolean;
  residentRunning: boolean;
  approved: boolean;
  setupComplete: boolean;
  authorizationConfigured: boolean;
};

export type NativeSetupReadiness = {
  ready: boolean;
  permissionsReady: boolean;
  steps: NativeSetupStep[];
  activeStep: NativeSetupStep | null;
  remaining: number;
  snapshot: NativeSetupSnapshot | null;
};

export type NativeLocationPermissionDetail = {
  foreground: SimplePermissionState;
  background: SimplePermissionState;
  backgroundRelevant: boolean;
  fine: boolean;
  coarse: boolean;
};

const LOCATION_STATUS_CACHE_MS = 60000;
let locationStatusCache: { value: SimplePermissionState; at: number } | null = null;
let locationDetailCache: { value: NativeLocationPermissionDetail; at: number } | null = null;

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

function toNotificationPermissionState(input: unknown): NativeNotificationPermissionState {
  if (!input || typeof input !== 'object') return 'unknown';
  const value =
    (input as { display?: unknown; receive?: unknown; status?: unknown }).display ??
    (input as { receive?: unknown }).receive ??
    (input as { status?: unknown }).status;
  if (value === 'prompt' || value === 'prompt-with-rationale') return value;
  return toSimpleState(value);
}

async function checkNativeNotificationPermissionState(): Promise<NativeNotificationPermissionState> {
  try {
    const current = await LocalNotifications.checkPermissions();
    return toNotificationPermissionState(current);
  } catch {
    return 'unknown';
  }
}

function toLocationPermissionDetail(input: Awaited<ReturnType<NativeSetupPlugin['checkLocationPermissions']>>): NativeLocationPermissionDetail {
  const fine = !!input.fine;
  const coarse = !!input.coarse;
  const foreground = !!input.foreground || fine || coarse;
  const backgroundRelevant = input.backgroundRelevant !== false;
  const background = backgroundRelevant ? !!input.background : true;
  return {
    fine,
    coarse,
    foreground: foreground ? 'granted' : 'denied',
    background: background ? 'granted' : 'denied',
    backgroundRelevant,
  };
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

export async function checkLocationPermissionStatus(): Promise<SimplePermissionState> {
  const now = Date.now();
  if (locationStatusCache && now - locationStatusCache.at < LOCATION_STATUS_CACHE_MS) {
    return locationStatusCache.value;
  }
  const state = isNative()
    ? (await checkNativeLocationPermissionDetail()).foreground
    : await checkGeoPermissionByPermissionsApi();
  locationStatusCache = { value: state, at: now };
  return state;
}

export async function checkNativeLocationPermissionDetail(): Promise<NativeLocationPermissionDetail> {
  const fallback: NativeLocationPermissionDetail = {
    foreground: 'unknown',
    background: 'unknown',
    backgroundRelevant: true,
    fine: false,
    coarse: false,
  };
  if (!isNative()) return fallback;
  const now = Date.now();
  if (locationDetailCache && now - locationDetailCache.at < LOCATION_STATUS_CACHE_MS) {
    return locationDetailCache.value;
  }
  try {
    const detail = toLocationPermissionDetail(await NativeSetup.checkLocationPermissions());
    locationDetailCache = { value: detail, at: now };
    return detail;
  } catch {
    locationDetailCache = { value: fallback, at: now };
    return fallback;
  }
}

function clearLocationPermissionCache() {
  locationStatusCache = null;
  locationDetailCache = null;
}

export async function requestLocationPermission(): Promise<SimplePermissionState> {
  clearLocationPermissionCache();
  if (!isNative()) {
    // Browsers cannot request only geolocation permission. The first fix and
    // browser prompt belong to the active-trip flow, never the settings screen.
    const current = await checkLocationPermissionStatus();
    requestRouteTrackingSync();
    return current;
  }
  try {
    const detail = toLocationPermissionDetail(await NativeSetup.requestLocationPermission());
    const at = Date.now();
    locationDetailCache = { value: detail, at };
    locationStatusCache = { value: detail.foreground, at };
    return detail.foreground;
  } catch {
    // A bridge failure must not activate GPS to infer permission state.
    return 'unknown';
  }
}

export async function checkNotificationPermissionStatus(): Promise<SimplePermissionState> {
  if (!isNative()) {
    if (typeof Notification === 'undefined') return 'unknown';
    return toSimpleState(Notification.permission);
  }
  const state = await checkNativeNotificationPermissionState();
  if (state === 'granted' || state === 'denied') return state;
  if (state === 'prompt' || state === 'prompt-with-rationale') return 'unknown';
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
  if (!isNative()) {
    if (typeof Notification === 'undefined') return 'unknown';
    const currentState = await checkNotificationPermissionStatus();
    if (currentState === 'granted' || currentState === 'denied') {
      return currentState;
    }
    try {
      return toSimpleState(await Notification.requestPermission());
    } catch {
      return checkNotificationPermissionStatus();
    }
  }
  const currentState = await checkNativeNotificationPermissionState();
  if (currentState === 'granted') return 'granted';
  // The explicit setup button must always reach requestPermissions for every
  // non-granted native state. In particular, Android 13's initial `prompt`
  // must not be collapsed through areEnabled() into a synthetic denial.
  try {
    const requested = await LocalNotifications.requestPermissions();
    const requestedState = toNotificationPermissionState(requested);
    if (requestedState === 'granted' || requestedState === 'denied') return requestedState;
  } catch {
    // ignore and retry below
  }
  return checkNotificationPermissionStatus();
}

export async function openAppPermissionSettings(): Promise<boolean> {
  if (!isNative()) return false;
  try {
    const result = await NativeSetup.openAppSettings();
    clearLocationPermissionCache();
    return !!result.opened;
  } catch {
    return false;
  }
}

function normalizeSettingsOpenResult(
  input: Partial<NativeSettingsOpenResult> | null | undefined,
  destination: string,
): NativeSettingsOpenResult {
  return {
    opened: input?.opened === true,
    destination: typeof input?.destination === 'string' && input.destination
      ? input.destination
      : destination,
    fallbackLevel: Number.isFinite(Number(input?.fallbackLevel))
      ? Math.max(0, Math.trunc(Number(input?.fallbackLevel)))
      : 0,
  };
}

async function openAppPermissionSettingsResult(): Promise<NativeSettingsOpenResult> {
  if (!isNative()) return { opened: false, destination: 'unsupported', fallbackLevel: 0 };
  try {
    const result = normalizeSettingsOpenResult(await NativeSetup.openAppSettings(), 'app-details');
    clearLocationPermissionCache();
    return result;
  } catch {
    return { opened: false, destination: 'app-details', fallbackLevel: 0 };
  }
}

export async function openSystemLocationSettings(): Promise<boolean> {
  if (!isNative()) return false;
  try {
    const result = await NativeSetup.openLocationSettings();
    return !!result.opened;
  } catch {
    return false;
  }
}

async function openSystemLocationSettingsResult(): Promise<NativeSettingsOpenResult> {
  if (!isNative()) return { opened: false, destination: 'unsupported', fallbackLevel: 0 };
  try {
    return normalizeSettingsOpenResult(await NativeSetup.openLocationSettings(), 'location-services');
  } catch {
    return { opened: false, destination: 'location-services', fallbackLevel: 0 };
  }
}

export async function openNotificationSettings(): Promise<NativeSettingsOpenResult> {
  if (!isNative()) return { opened: false, destination: 'unsupported', fallbackLevel: 0 };
  try {
    return normalizeSettingsOpenResult(await NativeSetup.openNotificationSettings(), 'app-notifications');
  } catch {
    return { opened: false, destination: 'app-notifications', fallbackLevel: 0 };
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

const EMPTY_NATIVE_SETUP_SNAPSHOT: NativeSetupSnapshot = {
  androidSdkInt: null,
  locationEnabled: false,
  fine: false,
  coarse: false,
  foreground: false,
  background: false,
  backgroundRelevant: true,
  backgroundPermissionOptionLabel: '常に許可',
  notifications: false,
  residentNotificationChannelExists: false,
  residentNotificationChannelEnabled: false,
  batteryOptimization: false,
  residentRunning: false,
  approved: false,
  setupComplete: false,
  authorizationConfigured: false,
};

function normalizeSetupSnapshot(input: Partial<NativeSetupSnapshot>): NativeSetupSnapshot {
  return {
    androidSdkInt: Number.isFinite(Number(input.androidSdkInt)) ? Number(input.androidSdkInt) : null,
    locationEnabled: input.locationEnabled === true,
    fine: input.fine === true,
    coarse: input.coarse === true,
    foreground: input.foreground === true || input.fine === true || input.coarse === true,
    background: input.background === true,
    backgroundRelevant: input.backgroundRelevant !== false,
    backgroundPermissionOptionLabel: typeof input.backgroundPermissionOptionLabel === 'string'
      && input.backgroundPermissionOptionLabel.trim()
      ? input.backgroundPermissionOptionLabel.trim()
      : '常に許可',
    notifications: input.notifications === true,
    residentNotificationChannelExists: input.residentNotificationChannelExists === true,
    residentNotificationChannelEnabled: input.residentNotificationChannelEnabled === true,
    batteryOptimization: input.batteryOptimization === true,
    residentRunning: input.residentRunning === true,
    approved: input.approved === true,
    setupComplete: input.setupComplete === true,
    authorizationConfigured: input.authorizationConfigured === true,
  };
}

export function buildNativeSetupReadiness(snapshot: NativeSetupSnapshot): NativeSetupReadiness {
  const backgroundReady = !snapshot.backgroundRelevant || snapshot.background;
  const notificationChannelsSupported = snapshot.androidSdkInt !== null
    && snapshot.androidSdkInt >= 26;
  const residentNotificationChannelDisabled = notificationChannelsSupported
    && snapshot.residentNotificationChannelExists
    && !snapshot.residentNotificationChannelEnabled;
  // A missing channel is intentionally allowed through the physical settings
  // phase. Starting the resident service creates it, then the final fresh
  // snapshot must observe the enabled channel before setup is complete.
  const notificationReady = snapshot.notifications && !residentNotificationChannelDisabled;
  const residentForegroundNotificationReady = !notificationChannelsSupported
    || snapshot.residentNotificationChannelEnabled;
  const residentServiceReady = snapshot.residentRunning
    && snapshot.approved
    && snapshot.setupComplete
    && snapshot.authorizationConfigured
    && snapshot.notifications
    && residentForegroundNotificationReady;
  const steps: NativeSetupStep[] = [
    {
      id: 'location-enabled',
      label: '端末の位置情報',
      level: snapshot.locationEnabled ? 'ok' : 'error',
      detail: snapshot.locationEnabled ? 'オンです。' : '端末の位置情報がオフです。',
      instruction: '開いた画面で「位置情報を使用」をオンにしてTrackLogへ戻ってください。',
    },
    {
      id: 'location-precise',
      label: '正確な位置情報',
      level: snapshot.fine ? 'ok' : 'error',
      detail: snapshot.fine
        ? '正確な位置情報を許可済みです。'
        : snapshot.coarse
          ? '概算の位置情報のみです。'
          : '位置情報が許可されていません。',
      instruction: '権限画面で「正確な位置情報を使用」をオンにし、位置情報を許可してください。',
    },
    {
      id: 'location-background',
      label: '常時位置情報',
      level: backgroundReady ? 'ok' : 'error',
      detail: backgroundReady
        ? snapshot.backgroundRelevant ? '「常に許可」済みです。' : 'このAndroidでは追加設定は不要です。'
        : 'アプリ使用中のみ許可されています。',
      instruction: snapshot.androidSdkInt !== null && snapshot.androidSdkInt >= 30
        ? `「権限」→「位置情報」を開き、「${snapshot.backgroundPermissionOptionLabel}」を選んでください。`
        : '位置情報で「常に許可」を選んでください。',
    },
    {
      id: 'notification',
      label: '通知',
      level: notificationReady ? 'ok' : 'error',
      detail: !snapshot.notifications
        ? '通知が無効です。'
        : residentNotificationChannelDisabled
          ? '「位置記録中」の常駐通知が無効です。'
          : '通知を許可済みです。',
      instruction: residentNotificationChannelDisabled
        ? '通知設定で「位置記録中」をオンにしてください。'
        : '通知を許可してください。高速終了確認と記録中の常駐通知に必要です。',
    },
    {
      id: 'battery-opt',
      label: '電池最適化',
      level: snapshot.batteryOptimization ? 'ok' : 'error',
      detail: snapshot.batteryOptimization ? '「最適化しない」設定済みです。' : '電池最適化の対象です。',
      instruction: '表示された確認で「許可」または「最適化しない」を選んでください。',
    },
    {
      id: 'resident-service',
      label: '位置記録サービス',
      level: residentServiceReady ? 'ok' : 'warn',
      detail: residentServiceReady
        ? 'バックグラウンド記録は正常に動作中です。'
        : '端末設定完了後に起動テストを行います。',
      instruction: 'この画面のまま少し待ってください。起動できない場合は「動作確認をやり直す」を押します。',
    },
  ];
  const permissionsReady = steps.slice(0, 5).every(step => step.level === 'ok');
  const activeStep = steps.find(step => step.level !== 'ok') ?? null;
  return {
    ready: permissionsReady && steps[5]?.level === 'ok',
    permissionsReady,
    steps,
    activeStep,
    remaining: steps.filter(step => step.level !== 'ok').length,
    snapshot,
  };
}

export async function getNativeSetupSnapshot(options: { fresh?: boolean } = {}): Promise<NativeSetupSnapshot | null> {
  if (!isNative()) return null;
  if (options.fresh) clearLocationPermissionCache();
  try {
    return normalizeSetupSnapshot(await NativeSetup.getSetupSnapshot({ fresh: options.fresh === true }));
  } catch {
    return null;
  }
}

export async function checkNativeSetupReadiness(
  options: { fresh?: boolean } = {},
): Promise<NativeSetupReadiness> {
  if (!isNative()) {
    return {
      ready: true,
      permissionsReady: true,
      steps: [
        {
          id: 'native-only',
          label: '端末設定',
          level: 'ok',
          detail: 'PWA/ブラウザではAndroid権限チェック対象外です。',
        },
      ],
      activeStep: null,
      remaining: 0,
      snapshot: null,
    };
  }
  const snapshot = await getNativeSetupSnapshot(options);
  return buildNativeSetupReadiness(snapshot ?? EMPTY_NATIVE_SETUP_SNAPSHOT);
}

export function shouldRequestBackgroundLocationDirectly(snapshot: NativeSetupSnapshot | null): boolean {
  return snapshot?.androidSdkInt === 29
    && snapshot.fine
    && snapshot.backgroundRelevant
    && !snapshot.background;
}

export function classifyNativeSetupStepReturn(
  previousStepId: NativeSetupStepId,
  currentStepId: NativeSetupStepId | null,
): 'unchanged' | 'advanced' | 'complete' {
  if (currentStepId === previousStepId) return 'unchanged';
  if (currentStepId == null) return 'complete';
  return 'advanced';
}

export function selectNativeNotificationSetupAction(input: {
  permission: NativeNotificationPermissionState;
  notificationsEnabled: boolean;
  requestAttempted: boolean;
}): 'complete' | 'request-permission' | 'open-settings' {
  if (input.notificationsEnabled) return 'complete';
  if (input.permission === 'granted') return 'open-settings';
  if (!input.requestAttempted) return 'request-permission';
  return 'open-settings';
}

export async function completeNativeNotificationSetup(input: {
  readState(): Promise<{
    permission: NativeNotificationPermissionState;
    notificationsEnabled: boolean;
  }>;
  requestPermission(): Promise<unknown>;
  openSettings(): Promise<NativeSettingsOpenResult>;
}): Promise<NativeSettingsOpenResult> {
  const before = await input.readState();
  const initialAction = selectNativeNotificationSetupAction({
    ...before,
    requestAttempted: false,
  });
  if (initialAction === 'complete') {
    return { opened: false, destination: 'already-granted', fallbackLevel: 0 };
  }
  if (initialAction === 'open-settings') return input.openSettings();

  await input.requestPermission();
  const after = await input.readState();
  const nextAction = selectNativeNotificationSetupAction({
    ...after,
    requestAttempted: true,
  });
  if (nextAction === 'complete') {
    return { opened: false, destination: 'permission-dialog', fallbackLevel: 0 };
  }
  return input.openSettings();
}

export async function requestBatteryOptimizationExemption(): Promise<{
  state: SimplePermissionState;
  opened: boolean;
  fallback?: boolean;
  destination?: string;
  fallbackLevel?: number;
}> {
  if (!isNative()) return { state: 'unknown', opened: false };
  try {
    const result = await NativeSetup.requestBatteryOptimizationExemption();
    const state = !result.supported || result.granted ? 'granted' : 'denied';
    return {
      state,
      opened: !!result.opened,
      fallback: result.fallback,
      destination: result.destination,
      fallbackLevel: result.fallbackLevel,
    };
  } catch {
    return { state: 'unknown', opened: false };
  }
}

export async function runNativeSetupStep(stepId: NativeSetupStepId): Promise<NativeSettingsOpenResult> {
  const notOpened = (destination: string): NativeSettingsOpenResult => ({
    opened: false,
    destination,
    fallbackLevel: 0,
  });
  if (!isNative()) return notOpened('unsupported');

  if (stepId === 'location-enabled') return openSystemLocationSettingsResult();
  if (stepId === 'location-precise') {
    await requestLocationPermission();
    const snapshot = await getNativeSetupSnapshot({ fresh: true });
    if (snapshot?.fine) return notOpened('permission-dialog');
    return openAppPermissionSettingsResult();
  }
  if (stepId === 'location-background') {
    const snapshot = await getNativeSetupSnapshot({ fresh: true });
    if (shouldRequestBackgroundLocationDirectly(snapshot)) {
      const result = await NativeSetup.requestBackgroundLocationPermission();
      const refreshed = await getNativeSetupSnapshot({ fresh: true });
      if (result.granted || refreshed?.background) return notOpened('permission-dialog');
    }
    return openAppPermissionSettingsResult();
  }
  if (stepId === 'notification') {
    const initialSnapshot = await getNativeSetupSnapshot({ fresh: true });
    const residentChannelDisabled = initialSnapshot?.androidSdkInt !== null
      && (initialSnapshot?.androidSdkInt ?? 0) >= 26
      && initialSnapshot?.residentNotificationChannelExists === true
      && initialSnapshot.residentNotificationChannelEnabled === false;
    if (initialSnapshot?.notifications && residentChannelDisabled) {
      try {
        return normalizeSettingsOpenResult(
          await NativeSetup.openResidentNotificationSettings(),
          'resident-notification-channel',
        );
      } catch {
        return openNotificationSettings();
      }
    }
    return completeNativeNotificationSetup({
      readState: async () => {
        const [snapshot, permission] = await Promise.all([
          getNativeSetupSnapshot({ fresh: true }),
          checkNativeNotificationPermissionState(),
        ]);
        return {
          permission,
          notificationsEnabled: snapshot?.notifications === true,
        };
      },
      requestPermission: requestNotificationPermission,
      openSettings: openNotificationSettings,
    });
  }
  if (stepId === 'battery-opt') {
    const result = await requestBatteryOptimizationExemption();
    return {
      opened: result.opened,
      destination: result.destination ?? 'battery-exemption-request',
      fallbackLevel: result.fallbackLevel ?? (result.fallback ? 1 : 0),
    };
  }

  requestRouteTrackingSync();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await wait(attempt === 0 ? 150 : 350);
    const readiness = await checkNativeSetupReadiness({ fresh: true });
    if (readiness.ready) return notOpened('resident-service-running');
  }
  return notOpened('resident-service-pending');
}

/** @deprecated Runs only the current missing item. Kept for older settings-screen callers. */
export async function runNativeQuickSetup(): Promise<{
  steps: NativeSetupStep[];
  requiresManualFollowUp: boolean;
}> {
  if (!isNative()) {
    const readiness = await checkNativeSetupReadiness();
    return { steps: readiness.steps, requiresManualFollowUp: false };
  }
  const before = await checkNativeSetupReadiness({ fresh: true });
  if (before.activeStep && before.activeStep.id !== 'native-only') {
    await runNativeSetupStep(before.activeStep.id);
  }
  const after = await checkNativeSetupReadiness({ fresh: true });
  return { steps: after.steps, requiresManualFollowUp: !after.ready };
}
