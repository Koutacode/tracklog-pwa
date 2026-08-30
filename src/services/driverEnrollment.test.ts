import assert from 'node:assert/strict';

Object.assign(globalThis, {
  __APP_VERSION__: 'test',
  __BUILD_DATE__: 'test',
});

async function run() {
  const {
    DriverAuthEmailMismatchError,
    DriverAuthSessionRefreshError,
    DriverNativeCredentialUpdateError,
    DriverOtpSessionError,
    DriverProfileEnrollmentError,
    ensureNativeDriverCredentialInstallation,
    getDriverAuthWorkflowErrorCode,
    isPermanentDriverAuthFailure,
    selectDriverEnrollmentAccessToken,
    validateVerifiedDriverOtpSession,
  } = await import('./remoteAuth');
  const { buildTracklogPrivilegedAuthorizationHeader } = await import('./tracklogPrivilegedApi');

  const validSession = {
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    user: {
      id: 'driver-user',
      email: 'Driver@Example.com',
    },
  };

  assert.equal(
    validateVerifiedDriverOtpSession(validSession as never, 'driver@example.com'),
    validSession,
    'OTP session validation accepts the verified email case-insensitively',
  );

  for (const invalidSession of [
    null,
    { ...validSession, access_token: '' },
    { ...validSession, refresh_token: '' },
    { ...validSession, user: null },
  ]) {
    assert.throws(
      () => validateVerifiedDriverOtpSession(invalidSession as never, 'driver@example.com'),
      (error: unknown) => error instanceof DriverOtpSessionError
        && getDriverAuthWorkflowErrorCode(error) === 'driver_otp_session_invalid',
      'OTP enrollment rejects incomplete access, refresh, or user session data',
    );
  }

  assert.throws(
    () => validateVerifiedDriverOtpSession(validSession as never, 'other@example.com'),
    (error: unknown) => error instanceof DriverAuthEmailMismatchError
      && getDriverAuthWorkflowErrorCode(error) === 'driver_auth_email_mismatch',
    'OTP enrollment rejects a session for another email address',
  );

  const revokedCause = Object.assign(new Error('Invalid Refresh Token: Refresh Token Not Found'), {
    code: 'refresh_token_not_found',
  });
  assert.equal(
    isPermanentDriverAuthFailure(new DriverAuthSessionRefreshError(revokedCause)),
    true,
    'wrapped refresh failures preserve permanent revocation classification',
  );
  assert.equal(
    getDriverAuthWorkflowErrorCode(new DriverNativeCredentialUpdateError(new Error('native write failed'))),
    'driver_native_credentials_update_failed',
    'native credential persistence has a dedicated error code',
  );
  assert.equal(
    getDriverAuthWorkflowErrorCode(new DriverProfileEnrollmentError(new Error('enrollment failed'))),
    'driver_profile_enrollment_failed',
    'approval enrollment has a retryable dedicated error code',
  );

  await assert.rejects(
    ensureNativeDriverCredentialInstallation({
      required: true,
      install: async () => false,
    }),
    (error: unknown) => error instanceof DriverNativeCredentialUpdateError
      && getDriverAuthWorkflowErrorCode(error) === 'driver_native_credentials_update_failed',
    'a native installer false result is a dedicated credential update failure',
  );

  let successfulInstallCalls = 0;
  await ensureNativeDriverCredentialInstallation({
    required: true,
    install: async () => {
      successfulInstallCalls += 1;
      return true;
    },
  });
  assert.equal(
    successfulInstallCalls,
    1,
    'a resend can retry and complete native credential installation once',
  );

  let skippedInstallCalls = 0;
  await ensureNativeDriverCredentialInstallation({
    required: false,
    install: async () => {
      skippedInstallCalls += 1;
      return false;
    },
  });
  assert.equal(
    skippedInstallCalls,
    0,
    'web enrollment does not invoke the Android credential installer',
  );

  assert.equal(
    selectDriverEnrollmentAccessToken({
      currentAccessToken: 'current-token',
      approvalStatus: 'unregistered',
    }),
    'current-token',
    'unregistered profiles use the current authenticated session for enrollment retry',
  );
  assert.equal(
    selectDriverEnrollmentAccessToken({
      currentAccessToken: 'current-token',
      approvalStatus: 'approved',
    }),
    '',
    'approved profiles keep using the native data client without an auth override',
  );
  assert.throws(
    () => selectDriverEnrollmentAccessToken({
      expectedAccessToken: 'otp-token',
      currentAccessToken: 'replacement-token',
      approvalStatus: 'unregistered',
    }),
    (error: unknown) => getDriverAuthWorkflowErrorCode(error) === 'driver_enrollment_session_changed',
    'a replacement session cannot claim the OTP enrollment transaction',
  );

  assert.deepEqual(
    buildTracklogPrivilegedAuthorizationHeader('  test-access-token  '),
    { Authorization: 'Bearer test-access-token' },
    'OTP access token is scoped to an explicit bearer header',
  );
  assert.equal(
    buildTracklogPrivilegedAuthorizationHeader('   '),
    null,
    'normal privileged calls do not add an empty authorization override',
  );

  console.log('driverEnrollment: 19 tests passed');
}

void run().catch(error => {
  globalThis.setTimeout(() => {
    throw error;
  }, 0);
});
