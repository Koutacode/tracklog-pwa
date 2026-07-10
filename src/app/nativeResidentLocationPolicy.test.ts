import type { DriverIdentity } from '../domain/remoteTypes';
import type { NativeResidentLocationPoint } from '../services/nativeResidentLocation';
import {
  canUseNativeResidentLocation,
  drainNativeResidentRoutePointQueue,
  uniqueNativeResidentRoutePoints,
} from './nativeResidentLocationPolicy';

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function identity(overrides: Partial<DriverIdentity> = {}): DriverIdentity {
  return {
    configured: true,
    deviceId: 'android:test-device',
    displayName: 'Test Driver',
    vehicleLabel: '札幌101か8916',
    phone: '09012345678',
    email: 'driver@example.com',
    authInitialized: true,
    profileComplete: true,
    approvalStatus: 'approved',
    ...overrides,
  };
}

function point(overrides: Partial<NativeResidentLocationPoint> = {}): NativeResidentLocationPoint {
  return {
    id: 'point-1',
    tripId: 'trip-1',
    ts: '2026-07-10T05:00:00.000Z',
    lat: 35.6812,
    lng: 139.7671,
    accuracy: 8,
    speed: 12,
    heading: 90,
    source: 'background',
    provider: 'gps',
    ...overrides,
  };
}

assertEqual(
  canUseNativeResidentLocation({
    isAndroidNative: true,
    identity: identity(),
    setupReady: true,
  }),
  true,
  'approved configured Android device',
);
assertEqual(
  canUseNativeResidentLocation({
    isAndroidNative: false,
    identity: identity(),
    setupReady: true,
  }),
  false,
  'PWA must be a no-op',
);
assertEqual(
  canUseNativeResidentLocation({
    isAndroidNative: true,
    identity: identity({ approvalStatus: 'pending' }),
    setupReady: true,
  }),
  false,
  'pending approval must stop native service',
);
assertEqual(
  canUseNativeResidentLocation({
    isAndroidNative: true,
    identity: identity({ profileComplete: false }),
    setupReady: true,
  }),
  false,
  'incomplete profile must stop native service',
);
assertEqual(
  canUseNativeResidentLocation({
    isAndroidNative: true,
    identity: identity(),
    setupReady: false,
  }),
  false,
  'incomplete native settings must stop native service',
);

const unique = uniqueNativeResidentRoutePoints([
  point(),
  point(),
  point({ id: 'point-2', lat: 91 }),
  point({ id: 'point-3', tripId: '' }),
  point({ id: 'point-4', speed: null, heading: null, accuracy: null }),
]);
assertEqual(unique.length, 2, 'duplicate and invalid native points are excluded');
assertEqual(unique[0].id, 'point-1', 'native UUID is preserved for idempotent storage');
assertEqual(unique[1].id, 'point-4', 'valid nullable sensor values are retained');

async function runAsyncTests() {
  let peekCalls = 0;
  const storedIds: string[] = [];
  const acknowledgedBatches: string[] = [];
  const drained = await drainNativeResidentRoutePointQueue({
    enabled: true,
    batchSize: 2,
    maxBatches: 3,
    peek: async limit => {
      assertEqual(limit, 2, 'configured native peek batch size');
      peekCalls += 1;
      return peekCalls === 1
        ? { points: [point(), point({ id: 'point-2' })], remaining: 1 }
        : { points: [point({ id: 'point-3' })], remaining: 0 };
    },
    acknowledge: async ids => {
      acknowledgedBatches.push(ids.join(','));
      return { remaining: acknowledgedBatches.length === 1 ? 1 : 0 };
    },
    addRoutePoint: async routePoint => {
      storedIds.push(routePoint.id);
    },
  });
  assertEqual(drained.persisted, 3, 'resume drain persists each UUID once across batches');
  assertEqual(storedIds.join(','), 'point-1,point-2,point-3', 'resume drain preserves UUID order');
  assertEqual(
    acknowledgedBatches.join('|'),
    'point-1,point-2|point-3',
    'native points are acknowledged only after each Dexie batch is persisted',
  );

  let acknowledgedAfterFailure = false;
  let failed = false;
  try {
    await drainNativeResidentRoutePointQueue({
      enabled: true,
      peek: async () => ({ points: [point()], remaining: 0 }),
      acknowledge: async () => {
        acknowledgedAfterFailure = true;
        return { remaining: 0 };
      },
      addRoutePoint: async () => {
        throw new Error('IndexedDB unavailable');
      },
    });
  } catch {
    failed = true;
  }
  assertEqual(failed, true, 'Dexie failures are surfaced for retry');
  assertEqual(acknowledgedAfterFailure, false, 'failed Dexie writes leave the native queue intact');

  let pwaPeekCalled = false;
  await drainNativeResidentRoutePointQueue({
    enabled: false,
    peek: async () => {
      pwaPeekCalled = true;
      return { points: [], remaining: 0 };
    },
    acknowledge: async () => ({ remaining: 0 }),
    addRoutePoint: async () => undefined,
  });
  assertEqual(pwaPeekCalled, false, 'PWA does not invoke the native queue bridge');

  console.log('nativeResidentLocationPolicy: 14 tests passed');
}

void runAsyncTests().catch(error => {
  globalThis.setTimeout(() => {
    throw error;
  }, 0);
});
