import assert from 'node:assert/strict';
import { startNativeExpresswayPromptLifecycle } from './nativeExpresswayPromptLifecycle';

async function main() {
  let initializeCalls = 0;
  let resumeListener: (() => void) | null = null;
  let removeCalls = 0;

  const dispose = startNativeExpresswayPromptLifecycle({
    initialize: async () => {
      initializeCalls += 1;
      if (initializeCalls === 1) throw new Error('simulated cold-start bridge race');
    },
    registerResume: async listener => {
      resumeListener = listener;
      return {
        remove: () => {
          removeCalls += 1;
        },
      };
    },
  });

  await Promise.resolve();
  assert.equal(initializeCalls, 1, 'cold start initializes notification action bindings immediately');
  assert.ok(resumeListener, 'resume listener is registered even when cold-start initialization fails');

  const triggerResume = () => {
    const listener = resumeListener as (() => void) | null;
    assert.ok(listener, 'resume listener remains available');
    listener();
  };

  triggerResume();
  await Promise.resolve();
  assert.equal(initializeCalls, 2, 'resume retries a failed cold-start initialization');

  triggerResume();
  await Promise.resolve();
  assert.equal(initializeCalls, 3, 'later resumes keep the idempotent initializer reachable');

  dispose();
  await Promise.resolve();
  assert.equal(removeCalls, 1, 'dispose removes the native resume listener');

  triggerResume();
  await Promise.resolve();
  assert.equal(initializeCalls, 3, 'disposed lifecycle ignores a late native resume callback');

  console.log('nativeExpresswayPromptLifecycle: cold-start, resume retry, and cleanup assertions passed');
}

void main();
