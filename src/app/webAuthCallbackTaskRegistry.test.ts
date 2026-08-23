export {};

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
    createWebAuthCallbackTaskRegistry,
    isRetryableWebAuthCallbackFailure,
  } = await import('./AuthCallbackScreen');
  const registry = createWebAuthCallbackTaskRegistry();
  const callbackUrl = 'https://tracklog.example/auth/admin/callback?code=single-use';
  let exchangeCount = 0;
  let resolveExchange!: (value: { nextPath: string }) => void;
  const exchange = new Promise<{ nextPath: string }>(resolve => {
    resolveExchange = resolve;
  });

  const firstMount = registry.get('admin', callbackUrl, async () => {
    exchangeCount += 1;
    return exchange;
  });
  const strictModeMount = registry.get('admin', callbackUrl, async () => {
    exchangeCount += 1;
    return { nextPath: '/wrong' };
  });
  assertEqual(firstMount, strictModeMount, 'two mounts share the in-flight web callback task');
  resolveExchange({ nextPath: '/admin' });
  await Promise.all([firstMount, strictModeMount]);
  assertEqual(exchangeCount, 1, 'two mounts exchange a web auth code once');

  const lateMount = await registry.get('admin', callbackUrl, async () => {
    exchangeCount += 1;
    return { nextPath: '/wrong-late' };
  });
  assertEqual(exchangeCount, 1, 'late duplicate reuses the completed web callback');
  assertEqual(lateMount.nextPath, '/admin', 'late duplicate receives the original navigation result');

  await registry.get('driver', callbackUrl, async () => {
    exchangeCount += 1;
    return { nextPath: '/settings' };
  });
  assertEqual(exchangeCount, 2, 'role remains part of the web callback fingerprint');

  let retryCount = 0;
  const retryUrl = 'https://tracklog.example/auth/admin/callback?code=retry';
  try {
    await registry.get('admin', retryUrl, async () => {
      retryCount += 1;
      throw new Error('temporary failure');
    });
  } catch {
    // Failed callbacks stay retryable.
  }
  await registry.get('admin', retryUrl, async () => {
    retryCount += 1;
    return { nextPath: '/admin' };
  });
  assertEqual(retryCount, 2, 'failed web callback is removed from the in-flight registry');

  const bounded = createWebAuthCallbackTaskRegistry(2);
  let oldestRuns = 0;
  const runCompleted = async () => ({ nextPath: '/admin' });
  await bounded.get('admin', `${callbackUrl}-a`, async () => {
    oldestRuns += 1;
    return runCompleted();
  });
  await bounded.get('admin', `${callbackUrl}-b`, runCompleted);
  await bounded.get('admin', `${callbackUrl}-c`, runCompleted);
  await bounded.get('admin', `${callbackUrl}-a`, async () => {
    oldestRuns += 1;
    return runCompleted();
  });
  assertEqual(oldestRuns, 2, 'bounded web completed cache evicts the oldest callback');

  assertEqual(
    isRetryableWebAuthCallbackFailure(callbackUrl, new TypeError('Failed to fetch')),
    false,
    'an untagged post-exchange failure never retries a single-use code',
  );
  assertEqual(
    isRetryableWebAuthCallbackFailure(callbackUrl, { status: 400, code: 'bad_code_verifier' }),
    false,
    'a permanent code failure is not retried',
  );
  assertEqual(
    isRetryableWebAuthCallbackFailure(
      'https://tracklog.example/auth/admin/callback#access_token=secret&refresh_token=secret',
      new TypeError('Failed to fetch'),
    ),
    false,
    'bearer-token callbacks are never retained in the address bar',
  );
  assertEqual(
    isRetryableWebAuthCallbackFailure(
      `${callbackUrl}&error=access_denied`,
      new TypeError('Failed to fetch'),
    ),
    false,
    'provider-declined callbacks are not retried as exchange failures',
  );

  const { exchangeWebAuthCodeWithRetryProtection } = await import('../services/remoteAuth');
  const {
    clearAuthCodeVerifier,
    restoreAuthCodeVerifier,
    snapshotAuthCodeVerifier,
  } = await import('../services/supabase');
  await restoreAuthCodeVerifier('admin', 'opaque-web-verifier');
  let retryableWebExchangeError: unknown = null;
  try {
    await exchangeWebAuthCodeWithRetryProtection('admin', async () => {
      await clearAuthCodeVerifier('admin');
      throw new TypeError('Failed to fetch');
    });
  } catch (error) {
    retryableWebExchangeError = error;
    // Retryable web exchanges restore the verifier before showing retry UI.
  }
  assertEqual(
    await snapshotAuthCodeVerifier('admin'),
    'opaque-web-verifier',
    'transient web exchange restores the exact admin verifier adapter',
  );
  assertEqual(
    isRetryableWebAuthCallbackFailure(callbackUrl, retryableWebExchangeError),
    true,
    'only a verifier-restored exchange failure retains the code callback URL',
  );
  try {
    await exchangeWebAuthCodeWithRetryProtection('admin', async () => {
      await clearAuthCodeVerifier('admin');
      throw { status: 400, code: 'bad_code_verifier' };
    });
  } catch {
    // A used/invalid code must not resurrect its verifier.
  }
  assertEqual(
    await snapshotAuthCodeVerifier('admin'),
    null,
    'permanent web exchange failure leaves the unusable verifier cleared',
  );

  console.log('webAuthCallbackTaskRegistry: 15 tests passed');
}

void run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
