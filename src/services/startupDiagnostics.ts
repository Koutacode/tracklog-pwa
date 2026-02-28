import { Capacitor } from '@capacitor/core';
import { getNativeNotificationDiagnostic } from './nativeExpresswayPrompt';
import { checkBatteryOptimizationStatus, checkLocationPermissionStatus, getNativePlatformInfo } from './nativeSetup';

export type StartupDiagnosticLevel = 'ok' | 'warn' | 'error';

export type StartupDiagnosticItem = {
  id: string;
  label: string;
  detail: string;
  level: StartupDiagnosticLevel;
};

async function checkGeoPermissionState(): Promise<PermissionState | 'unknown'> {
  try {
    if (!navigator.permissions?.query) return 'unknown';
    const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
    return status.state;
  } catch {
    return 'unknown';
  }
}

export async function runStartupDiagnostics(): Promise<StartupDiagnosticItem[]> {
  const items: StartupDiagnosticItem[] = [];
  const geoPerm = Capacitor.isNativePlatform() ? await checkLocationPermissionStatus() : await checkGeoPermissionState();
  if (geoPerm === 'granted') {
    items.push({
      id: 'geo',
      label: '位置情報権限',
      detail: '許可済み',
      level: 'ok',
    });
  } else if (geoPerm === 'denied') {
    items.push({
      id: 'geo',
      label: '位置情報権限',
      detail: '拒否されています。バックグラウンド記録は動作しません。',
      level: 'error',
    });
  } else {
    items.push({
      id: 'geo',
      label: '位置情報権限',
      detail: '未確定または要確認。初回起動時に許可してください。',
      level: 'warn',
    });
  }

  if (Capacitor.isNativePlatform()) {
    const platformInfo = await getNativePlatformInfo();
    const exactAlarmRelevant = platformInfo.exactAlarmRelevant !== false;
    const nativeDiag = await getNativeNotificationDiagnostic();
    if (nativeDiag) {
      if (nativeDiag.notificationPermission === 'granted') {
        items.push({
          id: 'notif',
          label: '通知権限',
          detail: '許可済み',
          level: 'ok',
        });
      } else if (nativeDiag.notificationPermission === 'denied') {
        items.push({
          id: 'notif',
          label: '通知権限',
          detail: '拒否されています。高速終了確認の通知アクションが使えません。',
          level: 'error',
        });
      } else {
        items.push({
          id: 'notif',
          label: '通知権限',
          detail: '未確定です。許可すると終了確認が安定します。',
          level: 'warn',
        });
      }
      if (!exactAlarmRelevant) {
        items.push({
          id: 'exact-alarm',
          label: 'Exact Alarm設定',
          detail: '対象外（Android 12未満）',
          level: 'ok',
        });
      } else if (nativeDiag.exactAlarm === 'granted') {
        items.push({
          id: 'exact-alarm',
          label: 'Exact Alarm設定',
          detail: '有効',
          level: 'ok',
        });
      } else if (nativeDiag.exactAlarm === 'denied') {
        items.push({
          id: 'exact-alarm',
          label: 'Exact Alarm設定',
          detail: '無効です。端末設定で有効化すると通知の遅延を減らせます。',
          level: 'warn',
        });
      } else {
        items.push({
          id: 'exact-alarm',
          label: 'Exact Alarm設定',
          detail: '要確認（Android 12+では有効化推奨）',
          level: 'warn',
        });
      }
    }
    const battery = await checkBatteryOptimizationStatus();
    if (battery === 'granted') {
      items.push({
        id: 'battery-opt',
        label: '電池最適化',
        detail: '最適化除外済み',
        level: 'ok',
      });
    } else if (battery === 'denied') {
      items.push({
        id: 'battery-opt',
        label: '電池最適化',
        detail: '最適化対象です。除外しないとバックグラウンド記録が停止する場合があります。',
        level: 'warn',
      });
    } else {
      items.push({
        id: 'battery-opt',
        label: '電池最適化',
        detail: '判定不可です。端末設定で最適化除外を確認してください。',
        level: 'warn',
      });
    }
  } else {
    const notifPermission = typeof Notification !== 'undefined' ? Notification.permission : 'default';
    if (notifPermission === 'granted') {
      items.push({
        id: 'notif',
        label: '通知権限',
        detail: '許可済み',
        level: 'ok',
      });
    } else if (notifPermission === 'denied') {
      items.push({
        id: 'notif',
        label: '通知権限',
        detail: '拒否されています。リマインダー通知が使えません。',
        level: 'warn',
      });
    } else {
      items.push({
        id: 'notif',
        label: '通知権限',
        detail: '未確定です。',
        level: 'warn',
      });
    }
  }

  items.push({
    id: 'network',
    label: '通信状態',
    detail: navigator.onLine ? 'オンライン' : 'オフライン（IC判定/住所補完/マップ補正に制限あり）',
    level: navigator.onLine ? 'ok' : 'warn',
  });

  return items;
}
