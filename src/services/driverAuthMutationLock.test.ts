import {
  beginDriverAuthIntent,
  canApplyDriverAuthIntent,
  getDriverAuthIntentGeneration,
  isCurrentDriverAuthIntent,
  withDriverAuthMutation,
} from './driverAuthMutationLock';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run() {
  const order: string[] = [];
  let releaseFirst!: () => void;
  let notifyFirstStarted!: () => void;
  const firstGate = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise<void>(resolve => {
    notifyFirstStarted = resolve;
  });
  const first = withDriverAuthMutation(async () => {
    order.push('first:start');
    notifyFirstStarted();
    await firstGate;
    order.push('first:end');
  });
  const second = withDriverAuthMutation(async () => {
    order.push('second');
  });

  await firstStarted;
  assert(order.join(',') === 'first:start', 'driver auth mutations must not overlap');
  releaseFirst();
  await Promise.all([first, second]);
  assert(order.join(',') === 'first:start,first:end,second', 'driver auth mutations preserve order');

  const olderIntent = beginDriverAuthIntent();
  const newerIntent = beginDriverAuthIntent();
  assert(!isCurrentDriverAuthIntent(olderIntent), 'a newer login/logout intent supersedes an older one');
  assert(isCurrentDriverAuthIntent(newerIntent), 'the newest login/logout intent remains current');
  assert(
    getDriverAuthIntentGeneration() === newerIntent,
    'long-running native work can capture the current login/logout generation',
  );
  assert(
    !canApplyDriverAuthIntent(newerIntent, newerIntent + 1, false),
    'a stale native reconcile cannot apply after a newer logout intent',
  );
  assert(
    !canApplyDriverAuthIntent(newerIntent, newerIntent, true),
    'an explicit logout marker prevents native authorization restoration',
  );

  console.log('driverAuthMutationLock: 7 tests passed');
}

void run().catch(error => {
  globalThis.setTimeout(() => {
    throw error;
  }, 0);
});
