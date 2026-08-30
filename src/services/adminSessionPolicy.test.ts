import {
  classifyAdminValidationFailure,
  getAdminValidationFailureDisposition,
  initialAdminEntryAvailability,
  reduceAdminEntryAvailability,
  resolveAdminSession,
} from './adminSessionPolicy';

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

async function run() {
  let serverChecks = 0;
  const unconfigured = await resolveAdminSession({
    configured: false,
    validateUser: async () => {
      throw new Error('must not validate');
    },
    getServerAccessState: async () => {
      throw new Error('must not query allowlist');
    },
  });
  assertEqual(unconfigured.configured, false, 'unconfigured client');

  const signedOut = await resolveAdminSession({
    configured: true,
    validateUser: async () => null,
    getServerAccessState: async () => {
      serverChecks += 1;
      return { email: 'admin@example.com', isAdmin: true };
    },
  });
  assertEqual(signedOut.authenticated, false, 'missing validated user');
  assertEqual(serverChecks, 0, 'signed-out user skips allowlist');

  const admin = await resolveAdminSession({
    configured: true,
    validateUser: async () => ({ email: 'Driver.Admin@Example.com ' }),
    getServerAccessState: async () => ({ email: 'driver.admin@example.com', isAdmin: true }),
  });
  assertEqual(admin.authenticated, true, 'validated user authenticated');
  assertEqual(admin.isAdmin, true, 'enabled matching admin');
  assertEqual(admin.email, 'Driver.Admin@Example.com', 'display email is trimmed');

  const disabled = await resolveAdminSession({
    configured: true,
    validateUser: async () => ({ email: 'driver@example.com' }),
    getServerAccessState: async () => ({ email: 'driver@example.com', isAdmin: false }),
  });
  assertEqual(disabled.isAdmin, false, 'disabled admin denied');

  const mismatched = await resolveAdminSession({
    configured: true,
    validateUser: async () => ({ email: 'driver@example.com' }),
    getServerAccessState: async () => ({ email: 'other@example.com', isAdmin: true }),
  });
  assertEqual(mismatched.isAdmin, false, 'server identity mismatch denied');

  let threw = false;
  try {
    await resolveAdminSession({
      configured: true,
      validateUser: async () => ({ email: 'driver@example.com' }),
      getServerAccessState: async () => {
        throw new Error('network unavailable');
      },
    });
  } catch {
    threw = true;
  }
  assertEqual(threw, true, 'allowlist lookup errors fail closed');

  assertEqual(
    classifyAdminValidationFailure(Object.assign(new Error('Invalid JWT'), { status: 401 }), false),
    'definitive',
    'invalid JWT remains definitive while offline',
  );
  assertEqual(
    classifyAdminValidationFailure(new Error('AuthSessionMissingError: Auth session missing!'), true),
    'definitive',
    'missing session is definitive',
  );
  assertEqual(
    classifyAdminValidationFailure(Object.assign(new Error('Service unavailable'), { status: 503 }), true),
    'transient',
    'server outage is transient',
  );
  assertEqual(
    classifyAdminValidationFailure(new TypeError('Failed to fetch'), true),
    'transient',
    'network failure is transient',
  );
  assertEqual(
    classifyAdminValidationFailure(new Error('unexpected validation failure'), true),
    'transient',
    'unknown validation failure is read-only eligible only after prior validation',
  );
  assertEqual(
    getAdminValidationFailureDisposition('transient', false),
    'block',
    'first transient failure stays fail closed',
  );
  assertEqual(
    getAdminValidationFailureDisposition('transient', true),
    'retain-read-only',
    'validated transient failure retains read-only view',
  );
  assertEqual(
    getAdminValidationFailureDisposition('definitive', true),
    'revoke',
    'definitive failure revokes a validated view',
  );

  const initialEntry = initialAdminEntryAvailability();
  assertEqual(initialEntry.visible, false, 'unverified admin entry starts hidden');
  const firstTransientEntry = reduceAdminEntryAvailability(initialEntry, {
    kind: 'failed',
    failure: 'transient',
  });
  assertEqual(firstTransientEntry.visible, false, 'first transient failure keeps admin entry hidden');
  const confirmedEntry = reduceAdminEntryAvailability(firstTransientEntry, {
    kind: 'validated',
    authenticated: true,
    isAdmin: true,
  });
  assertEqual(confirmedEntry.visible, true, 'validated admin entry is visible');
  const retainedEntry = reduceAdminEntryAvailability(confirmedEntry, {
    kind: 'failed',
    failure: 'transient',
  });
  assertEqual(retainedEntry.visible, true, 'transient failure retains previously confirmed entry');
  const revokedEntry = reduceAdminEntryAvailability(retainedEntry, {
    kind: 'failed',
    failure: 'definitive',
  });
  assertEqual(revokedEntry.visible, false, 'definitive failure hides previously confirmed entry');
  const nonAdminEntry = reduceAdminEntryAvailability(confirmedEntry, {
    kind: 'validated',
    authenticated: true,
    isAdmin: false,
  });
  assertEqual(nonAdminEntry.visible, false, 'validated non-admin hides entry immediately');
}

void run();
