export {};

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

async function run() {
  Object.assign(globalThis, {
    __APP_VERSION__: 'test',
    __BUILD_DATE__: 'test',
    __TRACKLOG_GITHUB_OWNER__: 'test',
    __TRACKLOG_GITHUB_REPO__: 'test',
    __TRACKLOG_RELEASE_APK_NAME__: 'test.apk',
  });
  const {
    classifyNativeAuthCallbackFailure,
    createNativeAuthCallbackTaskRegistry,
    resolveNativeAuthCallbackRoute,
    settleNativeAuthCallbackFailure,
  } = await import('./AdminAuthBridge');
  const registry = createNativeAuthCallbackTaskRegistry();
  const callbackUrl = 'com.tracklog.assist://auth?code=single-use&next=%2Fadmin';
  let exchangeCount = 0;
  const classifiers: string[] = [];
  let resolveExchange!: (value: { handled: boolean; nextPath: string }) => void;
  const exchange = new Promise<{ handled: boolean; nextPath: string }>(resolve => {
    resolveExchange = resolve;
  });

  const fromLaunchUrl = registry.get(callbackUrl, async () => {
    exchangeCount += 1;
    classifiers.push('admin');
    return exchange;
  });
  await new Promise(resolve => setTimeout(resolve, 5));
  const fromPendingUrl = registry.get(callbackUrl, async () => {
    exchangeCount += 1;
    classifiers.push('auto');
    return { handled: true, nextPath: '/wrong-intent' };
  });

  assertEqual(fromLaunchUrl, fromPendingUrl, 'cold launch and pending URL share one in-flight task');
  resolveExchange({ handled: true, nextPath: '/admin' });
  const launchResult = await fromLaunchUrl;
  const pendingResult = await fromPendingUrl;
  assertEqual(exchangeCount, 1, 'the in-flight callback code is exchanged once');
  assertEqual(classifiers.join(','), 'admin', 'the first intent alone classifies the shared task');
  assertEqual(pendingResult.nextPath, launchResult.nextPath, 'all in-flight consumers receive the first result');

  const afterIntentWasConsumed = await registry.get(callbackUrl, async () => {
    exchangeCount += 1;
    classifiers.push('auto');
    return { handled: true, nextPath: '/wrong-late-result' };
  });
  assertEqual(exchangeCount, 1, 'a late callback after intent consumption does not exchange again');
  assertEqual(afterIntentWasConsumed.nextPath, '/admin', 'the completed URL result is reused');

  const rejectedUrl = 'com.tracklog.assist://auth?code=retryable&next=%2Fadmin';
  let rejectedAttempts = 0;
  try {
    await registry.get(rejectedUrl, async () => {
      rejectedAttempts += 1;
      throw new Error('temporary failure');
    });
  } catch {
    // A failed exchange is removed from the in-flight map so recovery can retry.
  }
  const retried = await registry.get(rejectedUrl, async () => {
    rejectedAttempts += 1;
    return { handled: true, nextPath: '/admin' };
  });
  assertEqual(rejectedAttempts, 2, 'a rejected task can be retried');
  assertEqual(retried.handled, true, 'the retry result is returned');

  const unhandledUrl = 'com.tracklog.assist://auth?code=unhandled&next=%2Fsettings';
  let unhandledAttempts = 0;
  await registry.get(unhandledUrl, async () => {
    unhandledAttempts += 1;
    return { handled: false };
  });
  await registry.get(unhandledUrl, async () => {
    unhandledAttempts += 1;
    return { handled: true, nextPath: '/settings' };
  });
  assertEqual(unhandledAttempts, 2, 'an unhandled callback is not cached as completed');

  const boundedRegistry = createNativeAuthCallbackTaskRegistry(2);
  let oldestRuns = 0;
  const completed = async (nextPath: string) => ({ handled: true, nextPath });
  await boundedRegistry.get('com.tracklog.assist://auth?code=a&next=%2Fadmin', () => {
    oldestRuns += 1;
    return completed('/admin');
  });
  await boundedRegistry.get('com.tracklog.assist://auth?code=b&next=%2Fadmin', () => completed('/admin'));
  await boundedRegistry.get('com.tracklog.assist://auth?code=c&next=%2Fadmin', () => completed('/admin'));
  await boundedRegistry.get('com.tracklog.assist://auth?code=a&next=%2Fadmin', () => {
    oldestRuns += 1;
    return completed('/admin');
  });
  assertEqual(oldestRuns, 2, 'bounded completed cache evicts its oldest callback');

  const adminAttempt = {
    id: 'attempt_admin_1',
    intent: 'admin' as const,
    startedAt: 100,
    expiresAt: 10_000,
  };
  const adminIntent = {
    intent: 'admin' as const,
    attemptId: adminAttempt.id,
    expiresAt: adminAttempt.expiresAt,
  };
  const explicitAdmin = resolveNativeAuthCallbackRoute(
    `com.tracklog.assist://auth?code=admin&next=%2Fadmin&attempt=${adminAttempt.id}`,
    adminAttempt,
    adminIntent,
  );
  assertEqual(explicitAdmin.intent, 'admin', 'allowed callback next is the primary role');
  assertEqual(explicitAdmin.forceIntent, false, 'explicit callback role does not need intent forcing');

  const noNext = resolveNativeAuthCallbackRoute(
    `com.tracklog.assist://auth?code=admin&attempt=${adminAttempt.id}`,
    adminAttempt,
    adminIntent,
  );
  assertEqual(noNext.intent, 'admin', 'attempt-bound intent fills a missing next only');
  assertEqual(noNext.forceIntent, true, 'missing next uses the intent as a compatibility fallback');

  let roleCrossRejected = false;
  try {
    resolveNativeAuthCallbackRoute(
      `com.tracklog.assist://auth?code=cross&next=%2Fsettings&attempt=${adminAttempt.id}`,
      adminAttempt,
      adminIntent,
    );
  } catch {
    roleCrossRejected = true;
  }
  assertEqual(roleCrossRejected, true, 'callback next cannot cross the attempt role');

  let staleAttemptRejected = false;
  try {
    resolveNativeAuthCallbackRoute(
      'com.tracklog.assist://auth?code=stale&next=%2Fadmin&attempt=attempt_stale_1',
      adminAttempt,
      adminIntent,
    );
  } catch {
    staleAttemptRejected = true;
  }
  assertEqual(staleAttemptRejected, true, 'stale callback attempt is rejected before exchange');

  let openRedirectRejected = false;
  try {
    resolveNativeAuthCallbackRoute(
      `com.tracklog.assist://auth?code=evil&next=${encodeURIComponent('//evil.example/path')}&attempt=${adminAttempt.id}`,
      adminAttempt,
      adminIntent,
    );
  } catch {
    openRedirectRejected = true;
  }
  assertEqual(openRedirectRejected, true, 'non-local callback next is rejected');

  let malformedAttemptRejected = false;
  try {
    resolveNativeAuthCallbackRoute(
      'com.tracklog.assist://auth?code=bad-attempt&next=%2Fadmin&attempt=x',
      null,
      null,
    );
  } catch {
    malformedAttemptRejected = true;
  }
  assertEqual(malformedAttemptRejected, true, 'malformed callback attempt id is rejected');

  const legacyStrictNext = resolveNativeAuthCallbackRoute(
    'com.tracklog.assist://auth?code=legacy&next=%2Fsettings',
    null,
    null,
  );
  assertEqual(legacyStrictNext.intent, 'driver', 'legacy callback can use a strict allowlisted next without raw intent');

  assertEqual(
    classifyNativeAuthCallbackFailure(new TypeError('Failed to fetch')),
    'transient',
    'network exchange failure is transient',
  );
  assertEqual(
    classifyNativeAuthCallbackFailure({ status: 429, message: 'rate limited' }),
    'transient',
    '429 exchange failure is transient',
  );
  assertEqual(
    classifyNativeAuthCallbackFailure({ status: 503, message: 'unavailable' }),
    'transient',
    '5xx exchange failure is transient',
  );
  assertEqual(
    classifyNativeAuthCallbackFailure({ status: 400, code: 'bad_code_verifier' }),
    'permanent',
    'invalid verifier is permanent',
  );
  assertEqual(
    classifyNativeAuthCallbackFailure(new Error('unexpected exchange response')),
    'transient',
    'unknown exchange failure is retained for retry',
  );

  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage, sessionStorage },
  });
  const persistence = await import('../services/nativeAuthCallbackPersistence');
  const {
    clearNativeAuthStartStateForRole,
    exchangeNativeAuthCodeWithRetryProtection,
    resumeOrExchangeNativeAuthCodeSession,
    withNativeAuthStartForNative,
  } = await import('../services/remoteAuth');
  const {
    clearAuthCodeVerifier,
    restoreAuthCodeVerifier,
    snapshotAuthCodeVerifier,
  } = await import('../services/supabase');
  const persistedAttempt = persistence.beginNativeAuthAttempt('admin', {
    attemptId: 'attempt_admin_2',
  });
  const transientUrl = `com.tracklog.assist://auth?code=retry&next=%2Fadmin&attempt=${persistedAttempt.id}`;
  persistence.persistNativeAuthCallbackUrl(transientUrl);
  assertEqual(
    settleNativeAuthCallbackFailure(transientUrl, new TypeError('Failed to fetch')),
    'transient',
    'transient settlement is reported',
  );
  assertEqual(
    persistence.getNativeAuthCallbackUrl(),
    transientUrl,
    'transient settlement retains the pending callback',
  );
  assertEqual(
    persistence.getNativeAuthAttempt()?.id,
    persistedAttempt.id,
    'transient settlement retains the verifier owner',
  );

  await restoreAuthCodeVerifier('admin', 'opaque-admin-verifier');
  try {
    await exchangeNativeAuthCodeWithRetryProtection({
      role: 'admin',
      callbackUrl: transientUrl,
      attemptId: persistedAttempt.id,
      exchange: async () => {
        await clearAuthCodeVerifier('admin');
        throw new TypeError('Failed to fetch');
      },
    });
  } catch {
    // Supabase removes the verifier even on a network failure; the wrapper restores it.
  }
  assertEqual(
    await snapshotAuthCodeVerifier('admin'),
    'opaque-admin-verifier',
    'network exchange failure restores the verifier through the admin auth adapter',
  );
  try {
    await exchangeNativeAuthCodeWithRetryProtection({
      role: 'admin',
      callbackUrl: transientUrl,
      attemptId: persistedAttempt.id,
      exchange: async () => {
        await clearAuthCodeVerifier('admin');
        throw { status: 503, message: 'service unavailable' };
      },
    });
  } catch {
    // A retryable server response removes the verifier in auth-js as well.
  }
  assertEqual(
    await snapshotAuthCodeVerifier('admin'),
    'opaque-admin-verifier',
    '5xx exchange failure restores the verifier',
  );
  let verifierSeenByRetry: string | null = null;
  await exchangeNativeAuthCodeWithRetryProtection({
    role: 'admin',
    callbackUrl: transientUrl,
    attemptId: persistedAttempt.id,
    exchange: async () => {
      verifierSeenByRetry = await snapshotAuthCodeVerifier('admin');
      await clearAuthCodeVerifier('admin');
    },
  });
  assertEqual(verifierSeenByRetry, 'opaque-admin-verifier', 'second exchange receives the restored verifier');
  assertEqual(
    persistence.getPendingNativeAuthCallback()?.sessionEstablishedAt != null,
    true,
    'successful exchange records a resumable post-auth stage',
  );
  let resumedExchangeCount = 0;
  const resumedResult = await resumeOrExchangeNativeAuthCodeSession({
    role: 'admin',
    callbackUrl: transientUrl,
    attemptId: persistedAttempt.id,
    getSession: async () => ({
      user: { id: 'admin-test' },
      expires_at: Math.floor(Date.now() / 1_000) + 3_600,
      expires_in: 3_600,
    }) as any,
    exchange: async () => {
      resumedExchangeCount += 1;
    },
  });
  assertEqual(resumedResult, 'resumed', 'post-auth retry resumes from the established session stage');
  assertEqual(resumedExchangeCount, 0, 'post-auth retry does not reuse the single-use code');
  settleNativeAuthCallbackFailure(transientUrl, { status: 400, code: 'bad_code_verifier' });
  assertEqual(persistence.getNativeAuthCallbackUrl(), null, 'permanent settlement clears the pending callback');
  assertEqual(persistence.getNativeAuthAttempt(), null, 'permanent settlement clears the matching attempt');

  const permanentAttempt = persistence.beginNativeAuthAttempt('admin', {
    attemptId: 'attempt_admin_permanent',
  });
  const permanentUrl = `com.tracklog.assist://auth?code=invalid&next=%2Fadmin&attempt=${permanentAttempt.id}`;
  persistence.persistNativeAuthCallbackUrl(permanentUrl);
  await restoreAuthCodeVerifier('admin', 'opaque-permanent-verifier');
  try {
    await exchangeNativeAuthCodeWithRetryProtection({
      role: 'admin',
      callbackUrl: permanentUrl,
      attemptId: permanentAttempt.id,
      exchange: async () => {
        await clearAuthCodeVerifier('admin');
        throw { status: 400, code: 'bad_code_verifier' };
      },
    });
  } catch {
    // Permanent failures must not resurrect an unusable verifier.
  }
  assertEqual(await snapshotAuthCodeVerifier('admin'), null, 'permanent exchange failure does not restore verifier');
  settleNativeAuthCallbackFailure(permanentUrl, { status: 400, code: 'bad_code_verifier' });

  const oldAttempt = persistence.beginNativeAuthAttempt('admin', {
    attemptId: 'attempt_admin_oldflow',
  });
  const oldUrl = `com.tracklog.assist://auth?code=old-flow&next=%2Fadmin&attempt=${oldAttempt.id}`;
  persistence.persistNativeAuthCallbackUrl(oldUrl);
  await restoreAuthCodeVerifier('admin', 'opaque-old-verifier');
  let releaseOldExchange!: () => void;
  let signalOldExchangeStarted!: () => void;
  const oldExchangeRelease = new Promise<void>(resolve => {
    releaseOldExchange = resolve;
  });
  const oldExchangeStarted = new Promise<void>(resolve => {
    signalOldExchangeStarted = resolve;
  });
  const oldExchange = exchangeNativeAuthCodeWithRetryProtection({
    role: 'admin',
    callbackUrl: oldUrl,
    attemptId: oldAttempt.id,
    exchange: async () => {
      signalOldExchangeStarted();
      await oldExchangeRelease;
      // auth-js removes whatever currently occupies the role's verifier key
      // when the delayed response arrives, immediately before rejecting.
      await clearAuthCodeVerifier('admin');
      throw new TypeError('Failed to fetch');
    },
  });
  await oldExchangeStarted;
  let restartBlockedDuringExchange = false;
  try {
    await withNativeAuthStartForNative('admin', { restartNativeAttempt: true }, async attempt => attempt);
  } catch (error) {
    restartBlockedDuringExchange = (error as { code?: unknown }).code === 'native_auth_operation_in_progress';
  }
  assertEqual(
    restartBlockedDuringExchange,
    true,
    'restart is blocked while an old exchange can still delete the verifier',
  );
  let crossRoleStartBlockedDuringExchange = false;
  try {
    await withNativeAuthStartForNative('driver', {}, async attempt => attempt);
  } catch (error) {
    crossRoleStartBlockedDuringExchange = (error as { code?: unknown }).code === 'native_auth_operation_in_progress';
  }
  assertEqual(
    crossRoleStartBlockedDuringExchange,
    true,
    'a different-role start is also blocked by the global exchange lock',
  );
  assertEqual(
    persistence.getNativeAuthAttempt()?.id,
    oldAttempt.id,
    'blocked restart leaves the old verifier owner unchanged',
  );
  releaseOldExchange();
  try {
    await oldExchange;
  } catch {
    // The transient old failure restores its own verifier before unlocking.
  }
  assertEqual(
    await snapshotAuthCodeVerifier('admin'),
    'opaque-old-verifier',
    'delayed auth-js deletion is repaired before a replacement may begin',
  );
  const replacementAttempt = await withNativeAuthStartForNative('admin', {
    restartNativeAttempt: true,
  }, async attempt => attempt);
  const replacementUrl = `com.tracklog.assist://auth?code=new-flow&next=%2Fadmin&attempt=${replacementAttempt.id}`;
  persistence.persistNativeAuthCallbackUrl(replacementUrl);
  await restoreAuthCodeVerifier('admin', 'opaque-new-verifier');
  assertEqual(
    await snapshotAuthCodeVerifier('admin'),
    'opaque-new-verifier',
    'restart is allowed after exchange cleanup and keeps the new verifier',
  );
  persistence.clearNativeAuthCallbackUrl(replacementUrl);
  persistence.clearNativeAuthAttempt(replacementAttempt.id);

  const concurrentBaseAttempt = persistence.beginNativeAuthAttempt('admin', {
    attemptId: 'attempt_admin_concurrent_base',
  });
  await restoreAuthCodeVerifier('admin', 'opaque-concurrent-base');
  let signalConcurrentStartEntered!: () => void;
  let releaseConcurrentStart!: () => void;
  const concurrentStartEntered = new Promise<void>(resolve => {
    signalConcurrentStartEntered = resolve;
  });
  const concurrentStartRelease = new Promise<void>(resolve => {
    releaseConcurrentStart = resolve;
  });
  const firstConcurrentRestart = withNativeAuthStartForNative(
    'admin',
    { restartNativeAttempt: true },
    async attempt => {
      signalConcurrentStartEntered();
      await concurrentStartRelease;
      return attempt;
    },
  );
  await concurrentStartEntered;
  const secondConcurrentRestart = withNativeAuthStartForNative(
    'admin',
    { restartNativeAttempt: true },
    async attempt => attempt,
  );
  releaseConcurrentStart();
  const concurrentRestarts = await Promise.allSettled([
    firstConcurrentRestart,
    secondConcurrentRestart,
  ]);
  assertEqual(
    concurrentRestarts.filter(result => result.status === 'fulfilled').length,
    1,
    'only one of two concurrent explicit restarts can claim the start lock',
  );
  assertEqual(
    concurrentRestarts.filter(result => result.status === 'rejected').length,
    1,
    'the competing explicit restart is rejected instead of replacing the winner',
  );
  assertEqual(
    persistence.getNativeAuthAttempt()?.id === concurrentBaseAttempt.id,
    false,
    'the winning restart replaces only the attempt that existed before the race',
  );

  const beforeMixedStart = persistence.getNativeAuthAttempt();
  let signalMixedStartEntered!: () => void;
  let releaseMixedStart!: () => void;
  const mixedStartEntered = new Promise<void>(resolve => {
    signalMixedStartEntered = resolve;
  });
  const mixedStartRelease = new Promise<void>(resolve => {
    releaseMixedStart = resolve;
  });
  const restartFirst = withNativeAuthStartForNative(
    'driver',
    { restartNativeAttempt: true },
    async attempt => {
      signalMixedStartEntered();
      await mixedStartRelease;
      return attempt;
    },
  );
  await mixedStartEntered;
  const normalSecond = withNativeAuthStartForNative('driver', {}, async attempt => attempt);
  releaseMixedStart();
  const mixedStarts = await Promise.allSettled([restartFirst, normalSecond]);
  assertEqual(
    mixedStarts[0]?.status,
    'fulfilled',
    'the restart that acquired the lock first completes',
  );
  assertEqual(
    mixedStarts[1]?.status,
    'rejected',
    'a normal start cannot enter while the restart provider request is awaiting',
  );
  assertEqual(
    persistence.getNativeAuthAttempt()?.id === beforeMixedStart?.id,
    false,
    'the mixed-start winner remains the active verifier owner',
  );
  persistence.clearNativeAuthAttempt();
  await clearAuthCodeVerifier('admin');
  await clearAuthCodeVerifier('driver');

  const processDeathAttempt = persistence.beginNativeAuthAttempt('admin', {
    attemptId: 'attempt_admin_process_death_gap',
  });
  const processDeathUrl = `com.tracklog.assist://auth?code=consumed-before-kill&next=%2Fadmin&attempt=${processDeathAttempt.id}`;
  persistence.persistNativeAuthCallbackUrl(processDeathUrl);
  assertEqual(
    persistence.markNativeAuthCallbackExchangeStarted(processDeathUrl, processDeathAttempt.id, null),
    true,
    'exchange start and absence of a prior session are persisted before code exchange',
  );
  Object.defineProperty((globalThis as any).window, 'sessionStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });
  let processDeathReexchangeCount = 0;
  const recoveredAfterProcessDeath = await resumeOrExchangeNativeAuthCodeSession({
    role: 'admin',
    callbackUrl: processDeathUrl,
    attemptId: processDeathAttempt.id,
    getSession: async () => ({
      user: { id: 'admin-after-exchange' },
      expires_at: Math.floor(Date.now() / 1_000) + 3_600,
      expires_in: 3_600,
    }) as any,
    exchange: async () => {
      processDeathReexchangeCount += 1;
    },
  });
  assertEqual(
    recoveredAfterProcessDeath,
    'resumed',
    'a changed persisted session resumes when the process died before the success marker',
  );
  assertEqual(
    processDeathReexchangeCount,
    0,
    'process-death recovery never reuses the already-consumed authorization code',
  );
  assertEqual(
    persistence.getPendingNativeAuthCallback()?.sessionEstablishedAt != null,
    true,
    'process-death inference promotes the callback to the established stage',
  );
  persistence.clearNativeAuthCallbackUrl(processDeathUrl);
  persistence.clearNativeAuthAttempt(processDeathAttempt.id);

  const unchangedSessionAttempt = persistence.beginNativeAuthAttempt('admin', {
    attemptId: 'attempt_admin_unchanged_session',
  });
  const unchangedSessionUrl = `com.tracklog.assist://auth?code=not-consumed&next=%2Fadmin&attempt=${unchangedSessionAttempt.id}`;
  persistence.persistNativeAuthCallbackUrl(unchangedSessionUrl);
  const unchangedSession = {
    user: { id: 'admin-existing-session' },
    expires_at: Math.floor(Date.now() / 1_000) + 3_600,
    expires_in: 3_600,
  } as any;
  let unchangedSessionExchangeCount = 0;
  try {
    await resumeOrExchangeNativeAuthCodeSession({
      role: 'admin',
      callbackUrl: unchangedSessionUrl,
      attemptId: unchangedSessionAttempt.id,
      getSession: async () => unchangedSession,
      exchange: async () => {
        unchangedSessionExchangeCount += 1;
        throw new TypeError('Failed to fetch');
      },
    });
  } catch {
    // The unchanged prior session must not be mistaken for callback success.
  }
  const unchangedSessionRetry = await resumeOrExchangeNativeAuthCodeSession({
    role: 'admin',
    callbackUrl: unchangedSessionUrl,
    attemptId: unchangedSessionAttempt.id,
    getSession: async () => unchangedSession,
    exchange: async () => {
      unchangedSessionExchangeCount += 1;
    },
  });
  assertEqual(
    unchangedSessionRetry,
    'exchanged',
    'an unchanged pre-exchange session is not treated as process-death success',
  );
  assertEqual(
    unchangedSessionExchangeCount,
    2,
    'an unchanged session retries the still-unconsumed code after a transient failure',
  );
  persistence.clearNativeAuthCallbackUrl(unchangedSessionUrl);
  persistence.clearNativeAuthAttempt(unchangedSessionAttempt.id);

  const currentAttempt = persistence.beginNativeAuthAttempt('driver', {
    attemptId: 'attempt_driver_current',
  });
  const currentUrl = `com.tracklog.assist://auth?code=current&next=%2Fsettings&attempt=${currentAttempt.id}`;
  persistence.persistNativeAuthCallbackUrl(currentUrl);
  const staleUrl = 'com.tracklog.assist://auth?code=old&next=%2Fadmin&attempt=attempt_admin_old';
  settleNativeAuthCallbackFailure(staleUrl, { status: 400, code: 'bad_code_verifier' });
  assertEqual(
    persistence.getNativeAuthCallbackUrl(),
    currentUrl,
    'a stale permanent callback cannot clear the newer pending callback',
  );
  assertEqual(
    persistence.getNativeAuthAttempt()?.id,
    currentAttempt.id,
    'a stale permanent callback cannot clear the newer attempt',
  );

  const clearedVerifierRoles: string[] = [];
  await clearNativeAuthStartStateForRole('admin', async role => {
    clearedVerifierRoles.push(role);
  });
  assertEqual(
    persistence.getNativeAuthAttempt()?.id,
    currentAttempt.id,
    'admin OTP or sign-out cannot clear an active driver attempt',
  );
  assertEqual(
    persistence.getNativeAuthCallbackUrl(),
    currentUrl,
    'admin OTP or sign-out cannot clear the driver pending callback',
  );
  assertEqual(clearedVerifierRoles.join(','), 'admin', 'cross-role completion clears only its own verifier');
  await clearNativeAuthStartStateForRole('driver', async role => {
    clearedVerifierRoles.push(role);
  });
  assertEqual(persistence.getNativeAuthAttempt(), null, 'matching driver completion clears its attempt');
  assertEqual(persistence.getNativeAuthCallbackUrl(), null, 'matching driver completion clears its pending callback');

  console.log('nativeAuthCallbackTaskRegistry: 62 tests passed');
}

void run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
