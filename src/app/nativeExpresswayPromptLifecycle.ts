export type NativeExpresswayPromptResumeHandle = {
  remove(): void | Promise<void>;
};

export type NativeExpresswayPromptLifecycleInput = {
  initialize(): Promise<void>;
  registerResume(listener: () => void):
    | NativeExpresswayPromptResumeHandle
    | Promise<NativeExpresswayPromptResumeHandle>;
};

/**
 * Register notification actions on cold start and retry on every native resume.
 * Initialization failures are intentionally recoverable; the service initializer
 * itself is single-flight and idempotent.
 */
export function startNativeExpresswayPromptLifecycle(
  input: NativeExpresswayPromptLifecycleInput,
): () => void {
  let active = true;
  const initialize = () => {
    if (!active) return;
    void input.initialize().catch(() => {
      // Resume is the next bounded retry opportunity.
    });
  };

  initialize();
  let resumeHandle: Promise<NativeExpresswayPromptResumeHandle | null>;
  try {
    resumeHandle = Promise.resolve(input.registerResume(initialize));
  } catch {
    resumeHandle = Promise.resolve(null);
  }

  return () => {
    active = false;
    void resumeHandle
      .then(handle => handle?.remove())
      .catch(() => {
        // Listener cleanup is best-effort during app teardown.
      });
  };
}
