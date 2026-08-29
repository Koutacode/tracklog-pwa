import assert from 'node:assert/strict';
import type { DriverIdentity } from '../domain/remoteTypes';
import {
  getDriverProfileEnrollmentErrorMessage,
  getDriverRegistrationGateModel,
} from './driverRegistrationGateModel';

function identity(overrides: Partial<DriverIdentity> = {}): DriverIdentity {
  return {
    configured: true,
    deviceId: 'android:test-device',
    displayName: '山田 太郎',
    vehicleLabel: '札幌101か8916',
    email: 'driver@example.com',
    phone: '09012345678',
    authInitialized: true,
    profileComplete: true,
    approvalStatus: 'unregistered',
    ...overrides,
  };
}

const enrollmentIncomplete = getDriverRegistrationGateModel(identity());
assert.equal(enrollmentIncomplete.mode, 'enrollment-incomplete');
assert.equal(enrollmentIncomplete.statusLabel, '承認申請未完了');
assert.equal(enrollmentIncomplete.showStatusCard, true);
assert.equal(enrollmentIncomplete.showRegistrationForm, true);
assert.equal(enrollmentIncomplete.showApprovalRefresh, false);
assert.equal(enrollmentIncomplete.canRetryEnrollment, true);

const pending = getDriverRegistrationGateModel(identity({ approvalStatus: 'pending' }));
assert.equal(pending.mode, 'approval-pending');
assert.equal(pending.statusLabel, '管理者承認待ち');
assert.equal(pending.showStatusCard, true);
assert.equal(pending.showRegistrationForm, false);
assert.equal(pending.showApprovalRefresh, true);
assert.equal(pending.canRetryEnrollment, false);

const rejected = getDriverRegistrationGateModel(identity({ approvalStatus: 'rejected' }));
assert.equal(rejected.mode, 'rejected');
assert.equal(rejected.statusLabel, '拒否済み');
assert.equal(rejected.showStatusCard, true);
assert.equal(rejected.showRegistrationForm, false);

const approved = getDriverRegistrationGateModel(identity({ approvalStatus: 'approved' }));
assert.equal(approved.mode, 'approved');
assert.equal(approved.statusLabel, '承認済み');
assert.equal(approved.showStatusCard, false);
assert.equal(approved.showRegistrationForm, false);

const unauthenticated = getDriverRegistrationGateModel(identity({
  authInitialized: false,
  approvalStatus: 'pending',
}));
assert.equal(unauthenticated.mode, 'email-authentication');
assert.equal(unauthenticated.statusLabel, 'メール認証待ち');
assert.equal(unauthenticated.showStatusCard, false);
assert.equal(unauthenticated.showRegistrationForm, true);

const incomplete = getDriverRegistrationGateModel(identity({ profileComplete: false }));
assert.equal(incomplete.mode, 'profile-incomplete');
assert.equal(incomplete.statusLabel, '登録情報不足');
assert.equal(incomplete.showStatusCard, false);

const enrollmentError = Object.assign(new Error('Edge Function returned a non-2xx status code'), {
  code: 'driver_profile_enrollment_failed',
});
assert.match(
  getDriverProfileEnrollmentErrorMessage(enrollmentError) ?? '',
  /メール認証は完了しましたが、端末の承認申請を完了できませんでした/,
);
assert.equal(getDriverProfileEnrollmentErrorMessage(new Error('Invalid OTP')), null);

console.log('driverRegistrationGateModel: registration, approval, rejection, and enrollment failure states passed');
