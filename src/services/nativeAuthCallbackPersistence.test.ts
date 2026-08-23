export {};

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run() {
  const localStorage = new MemoryStorage();
  let sessionStorage = new MemoryStorage();
  const testWindow = { localStorage, sessionStorage };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: testWindow,
  });

  const persistence = await import('./nativeAuthCallbackPersistence');
  const base = Date.now();
  let assertions = 0;
  const checkEqual = <T>(actual: T, expected: T, message: string) => {
    assertEqual(actual, expected, message);
    assertions += 1;
  };

  checkEqual(persistence.getNativeAuthAttempt(base), null, 'attempt starts empty');
  const first = persistence.beginNativeAuthAttempt('admin', {
    now: base,
    attemptId: 'attempt_admin_1',
  });
  checkEqual(first.intent, 'admin', 'admin attempt is created');
  checkEqual(persistence.getNativeAuthCallbackIntent(base), 'admin', 'intent is bound to active attempt');
  checkEqual(
    persistence.getNativeAuthCallbackIntentRecord(base)?.attemptId,
    first.id,
    'intent record carries the attempt id',
  );

  for (const intent of ['admin', 'driver'] as const) {
    let blocked = false;
    try {
      persistence.beginNativeAuthAttempt(intent, {
        now: base + 10,
        attemptId: `attempt_${intent}_2`,
      });
    } catch (error) {
      blocked = persistence.isNativeAuthFlowInProgressError(error);
    }
    checkEqual(blocked, true, `${intent} overlap is blocked`);
  }
  checkEqual(
    persistence.getNativeAuthAttempt(base + 10)?.id,
    first.id,
    'blocked overlap does not replace the verifier owner',
  );

  const firstCallback = `com.tracklog.assist://auth?code=one&next=%2Fadmin&attempt=${first.id}`;
  persistence.persistNativeAuthCallbackUrl(firstCallback, base + 20);
  checkEqual(persistence.getNativeAuthCallbackUrl(base + 30), firstCallback, 'pending callback is retained for retry');

  sessionStorage = new MemoryStorage();
  Object.defineProperty(testWindow, 'sessionStorage', {
    configurable: true,
    value: sessionStorage,
  });
  checkEqual(
    persistence.getNativeAuthAttempt(base + 40)?.id,
    first.id,
    'attempt survives WebView process death via localStorage',
  );
  checkEqual(
    persistence.getNativeAuthCallbackUrl(base + 40),
    firstCallback,
    'pending callback survives WebView process death via localStorage',
  );
  checkEqual(
    sessionStorage.length > 0,
    true,
    'localStorage recovery repairs the new sessionStorage',
  );

  const restarted = persistence.beginNativeAuthAttempt('driver', {
    now: base + 50,
    restart: true,
    attemptId: 'attempt_driver_2',
  });
  checkEqual(restarted.intent, 'driver', 'explicit restart creates the requested role');
  checkEqual(restarted.id, 'attempt_driver_2', 'explicit restart replaces the attempt id');
  checkEqual(persistence.getNativeAuthCallbackUrl(base + 60), null, 'explicit restart discards the old pending URL');

  const staleCallback = `com.tracklog.assist://auth?code=stale&next=%2Fadmin&attempt=${first.id}`;
  persistence.persistNativeAuthCallbackUrl(staleCallback, base + 70);
  checkEqual(
    persistence.getNativeAuthCallbackUrl(base + 80),
    null,
    'a stale callback cannot replace pending state for the current attempt',
  );
  persistence.persistNativeAuthCallbackUrl('com.tracklog.assist://auth?code=legacy&next=%2Fsettings', base + 80);
  checkEqual(
    persistence.getNativeAuthCallbackUrl(base + 81),
    null,
    'a callback without an attempt cannot overwrite an active flow',
  );

  const driverCallback = `com.tracklog.assist://auth?code=driver&next=%2Fsettings&attempt=${restarted.id}`;
  persistence.persistNativeAuthCallbackUrl(driverCallback, base + 90);
  const secondDriverCallback = `com.tracklog.assist://auth?code=driver-two&next=%2Fsettings&attempt=${restarted.id}`;
  persistence.persistNativeAuthCallbackUrl(secondDriverCallback, base + 95);
  checkEqual(
    persistence.getNativeAuthCallbackUrl(base + 96),
    driverCallback,
    'the first callback for an active attempt wins until it is settled',
  );
  persistence.persistNativeAuthCallbackUrl(driverCallback, base + 100);
  const pending = persistence.getPendingNativeAuthCallback(base + 110);
  assert(pending, 'pending callback record exists');
  assertions += 1;
  checkEqual(pending.receivedAt, base + 90, 'duplicate delivery does not extend callback TTL');
  checkEqual(
    persistence.markNativeAuthCallbackExchangeStarted(driverCallback, restarted.id, null, base + 115),
    true,
    'exchange start is persisted before the single-use code is consumed',
  );
  checkEqual(
    persistence.markNativeAuthCallbackSessionEstablished(driverCallback, base + 120),
    true,
    'successful exchange stage is persisted for resumable post-processing',
  );
  sessionStorage = new MemoryStorage();
  Object.defineProperty(testWindow, 'sessionStorage', {
    configurable: true,
    value: sessionStorage,
  });
  checkEqual(
    persistence.getPendingNativeAuthCallback(base + 130)?.exchangeStartedAt,
    base + 115,
    'exchange start survives WebView process death',
  );
  checkEqual(
    persistence.getPendingNativeAuthCallback(base + 130)?.priorSessionFingerprint,
    null,
    'the no-prior-session state survives WebView process death',
  );
  checkEqual(
    persistence.getPendingNativeAuthCallback(base + 130)?.sessionEstablishedAt,
    base + 120,
    'successful exchange stage survives WebView process death',
  );
  checkEqual(
    persistence.getNativeAuthCallbackUrl(base + 90 + persistence.NATIVE_AUTH_CALLBACK_TTL_MS + 1),
    null,
    'pending callback expires instead of retrying forever',
  );

  checkEqual(
    persistence.getNativeAuthAttempt(base + persistence.NATIVE_AUTH_ATTEMPT_TTL_MS + 49)?.id,
    restarted.id,
    'attempt remains valid before its TTL',
  );
  checkEqual(
    persistence.getNativeAuthAttempt(base + persistence.NATIVE_AUTH_ATTEMPT_TTL_MS + 51),
    null,
    'expired attempt is removed',
  );
  checkEqual(persistence.getNativeAuthCallbackIntent(base + persistence.NATIVE_AUTH_ATTEMPT_TTL_MS + 51), null, 'expired intent is removed with its attempt');

  const legacy = persistence.beginNativeAuthAttempt('admin', {
    attemptId: 'attempt_admin_legacy',
  });
  checkEqual(persistence.consumeNativeAuthCallbackIntent(), 'admin', 'legacy intent consumer still returns the role');
  checkEqual(persistence.getNativeAuthAttempt(), null, 'legacy intent consumer clears its attempt');
  assert(legacy.id.length > 0, 'legacy attempt fixture is valid');
  assertions += 1;

  const callbackUrl = 'com.tracklog.assist://auth?code=test&next=%2Fadmin';
  persistence.persistNativeAuthCallbackUrl(callbackUrl);
  checkEqual(persistence.consumeNativeAuthCallbackUrl(), callbackUrl, 'callback URL compatibility consumer returns URL');
  checkEqual(persistence.consumeNativeAuthCallbackUrl(), null, 'callback URL is consumed only once');

  persistence.persistNativeAuthCallbackUrl('https://example.com/auth?code=test');
  checkEqual(persistence.consumeNativeAuthCallbackUrl(), null, 'foreign callback URL is rejected');
  checkEqual(persistence.isTracklogNativeAuthCallbackUrl(callbackUrl), true, 'TrackLog native callback URL is recognized');
  checkEqual(
    persistence.isTracklogNativeAuthCallbackUrl('com.tracklog.assist://auth/extra?code=test'),
    false,
    'native callback with an unexpected path is rejected',
  );
  checkEqual(
    persistence.isTracklogNativeAuthCallbackUrl('com.tracklog.assist://other?code=test'),
    false,
    'unrelated TrackLog deep link is rejected',
  );

  console.log(`nativeAuthCallbackPersistence: ${assertions} tests passed`);
}

void run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
