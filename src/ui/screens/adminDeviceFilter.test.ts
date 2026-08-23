import assert from 'node:assert/strict';
import type { RemoteDeviceProfile } from '../../domain/remoteTypes';
import { filterAdminDevices, getAdminDeviceSeenStatus } from './adminDeviceFilter';

const NOW = Date.parse('2026-08-23T06:00:00.000Z');

function device(
  deviceId: string,
  overrides: Partial<RemoteDeviceProfile> = {},
): RemoteDeviceProfile {
  return {
    device_id: deviceId,
    display_name: '山田 太郎',
    vehicle_label: '札幌１０１ か ８９１６',
    driver_phone: '０９０−１２３４−５６７８',
    driver_email: 'Driver.One@Example.com',
    platform: 'android',
    app_version: '0.1.52',
    latest_status: 'driving',
    latest_trip_id: 'trip-1',
    latest_lat: null,
    latest_lng: null,
    latest_accuracy: null,
    last_seen_at: '2026-08-23T05:50:00.000Z',
    approval_status: 'approved',
    ...overrides,
  };
}

const active = device('device-A1');
const recent = device('device-B2', {
  display_name: '鈴木 花子',
  vehicle_label: '旭川200あ10',
  driver_email: 'hanako@example.com',
  driver_phone: '080-0000-1111',
  last_seen_at: '2026-08-23T05:00:00.000Z',
  approval_status: 'pending',
});
const stale = device('device-C3', {
  display_name: '佐藤 次郎',
  last_seen_at: '2026-08-23T02:00:00.000Z',
});
const devices = [active, recent, stale];

assert.equal(getAdminDeviceSeenStatus(active.last_seen_at, NOW).kind, 'active');
assert.equal(getAdminDeviceSeenStatus(recent.last_seen_at, NOW).kind, 'recent');
assert.equal(getAdminDeviceSeenStatus(stale.last_seen_at, NOW).kind, 'stale');
assert.equal(getAdminDeviceSeenStatus('invalid-date', NOW).label, '要確認');

assert.deepEqual(
  filterAdminDevices(devices, { query: '鈴木', status: 'all', nowMs: NOW }).map(item => item.device_id),
  ['device-B2'],
  '端末名の部分一致で絞り込む',
);
assert.deepEqual(
  filterAdminDevices(devices, { query: '０９０１２３４', status: 'all', nowMs: NOW }).map(item => item.device_id),
  ['device-A1', 'device-C3'],
  '全角数字と電話番号の区切りを正規化する',
);
assert.deepEqual(
  filterAdminDevices(devices, { query: 'driver.one device-a1', status: 'active', nowMs: NOW }).map(item => item.device_id),
  ['device-A1'],
  '複数語は検索対象項目をまたいで一致できる',
);
assert.deepEqual(
  filterAdminDevices(devices, { query: '', status: 'pending', nowMs: NOW }).map(item => item.device_id),
  ['device-B2'],
  '承認待ちは同期状態と独立して絞り込む',
);
assert.deepEqual(
  filterAdminDevices(devices, { query: '旭川', status: 'recent', nowMs: NOW }).map(item => item.device_id),
  ['device-B2'],
  '車番検索と同期状態を組み合わせる',
);

console.log('adminDeviceFilter: search normalization and five status filters passed');
