let mutationTail: Promise<void> = Promise.resolve();
let authIntentGeneration = 0;

/** Marks a user-visible login/logout action so the newest intent wins. */
export function beginDriverAuthIntent(): number {
  authIntentGeneration += 1;
  return authIntentGeneration;
}

export function getDriverAuthIntentGeneration(): number {
  return authIntentGeneration;
}

export function canApplyDriverAuthIntent(
  expectedGeneration: number,
  currentGeneration: number,
  explicitSignOutRequested: boolean,
): boolean {
  return expectedGeneration === currentGeneration && !explicitSignOutRequested;
}

export function isCurrentDriverAuthIntent(generation: number): boolean {
  return canApplyDriverAuthIntent(generation, authIntentGeneration, false);
}

/** Serializes driver session writes across login, logout, and native recovery. */
export async function withDriverAuthMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const previous = mutationTail;
  let release!: () => void;
  mutationTail = new Promise<void>(resolve => {
    release = resolve;
  });
  await previous.catch(() => undefined);
  try {
    return await mutation();
  } finally {
    release();
  }
}
