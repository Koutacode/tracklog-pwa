import type { DriverIdentity } from '../domain/remoteTypes';
import {
  getDriverPostAuthPath,
  getWebAuthCallbackRole,
} from './authCallbackRouting';

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function identity(overrides: Partial<DriverIdentity>): DriverIdentity {
  return {
    configured: true,
    deviceId: 'test-device',
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

assertEqual(getWebAuthCallbackRole('/auth/driver/callback'), 'driver', 'driver callback role');
assertEqual(getWebAuthCallbackRole('/auth/admin/callback'), 'admin', 'admin callback role');
assertEqual(getWebAuthCallbackRole('/auth/driver/callback/'), 'driver', 'trailing slash');
assertEqual(getWebAuthCallbackRole('/auth/admin/callback/extra'), null, 'nested path rejection');
assertEqual(getWebAuthCallbackRole('/admin'), null, 'ordinary admin route rejection');

assertEqual(getDriverPostAuthPath(identity({})), '/', 'approved complete driver');
assertEqual(
  getDriverPostAuthPath(identity({ approvalStatus: 'pending' })),
  '/settings',
  'pending driver',
);
assertEqual(
  getDriverPostAuthPath(identity({ profileComplete: false })),
  '/settings',
  'incomplete driver',
);
assertEqual(
  getDriverPostAuthPath(identity({ authInitialized: false })),
  '/settings',
  'unauthenticated driver',
);

console.log('authCallbackRouting: 9 tests passed');
