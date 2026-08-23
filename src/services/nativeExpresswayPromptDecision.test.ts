import type {
  AutoExpresswayDecisionReason,
  PendingExpresswayEndPrompt,
} from '../db/repositories';
import {
  commitAutomaticExpresswayEnd,
  commitAutomaticExpresswayKeep,
  isJavaOwnedExpresswayPrompt,
} from './nativeExpresswayPromptDecision';

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
}

const reason: AutoExpresswayDecisionReason = {
  source: 'native-auto',
  nativeDetectionId: 'prompt-4',
  nativeGeneration: 4,
  action: 'end-prompt',
  evaluatedAt: '2026-08-23T01:00:00.000Z',
  speedKmh: 18,
  signalResolved: true,
  onExpresswayRoad: false,
  nearIc: true,
  nearEtcGate: true,
  config: { startSpeedKmh: 78, startDurationSec: 6, endSpeedKmh: 34, endDurationSec: 24 },
};

const prompt: PendingExpresswayEndPrompt = {
  tripId: 'trip-prompt',
  promptId: 'prompt-4',
  speedKmh: 18,
  detectedAt: '2026-08-23T01:00:00.000Z',
  geo: { lat: 35.68, lng: 139.76, accuracy: 8 },
  reason,
};

function dependencies(log: string[]) {
  return {
    resolveNativePrompt: async (input: { promptId: string; action: 'end' | 'keep' }) => {
      log.push(`native:${input.action}:${input.promptId}`);
      return { stored: true as const, eventId: `decision-${input.action}-5`, generation: 5 };
    },
    setPendingDecision: async (decision: { nativeDetectionId?: string; promptId?: string }) => {
      log.push(`decision:${decision.nativeDetectionId}:${decision.promptId}`);
    },
    clearPendingPrompt: async () => { log.push('clear-prompt'); },
    clearPendingDecision: async () => { log.push('clear-decision'); },
    endExpressway: async (input: { autoDecision?: AutoExpresswayDecisionReason }) => {
      log.push(`end:${input.autoDecision?.nativeDetectionId}:${input.autoDecision?.nativeGeneration}`);
      return { eventId: 'stored-end', created: true };
    },
    enqueueEndIcResolution: () => { log.push('enqueue-ic'); },
    cancelLocalNotification: async () => { log.push('cancel-local'); },
  };
}

async function run() {
  assertEqual(isJavaOwnedExpresswayPrompt(true, prompt), true, 'native generation and matching id prove Java ownership');
  assertEqual(isJavaOwnedExpresswayPrompt(false, prompt), false, 'non-Android prompt is never Java-owned');
  {
    const log: string[] = [];
    await commitAutomaticExpresswayKeep({
      isAndroidNative: true,
      prompt,
      decidedAt: '2026-08-23T01:01:00.000Z',
      dependencies: dependencies(log),
    });
    assertEqual(
      log.join(','),
      'native:keep:prompt-4,decision:decision-keep-5:prompt-4,clear-prompt,cancel-local',
      'Java keep is committed before Dexie prompt clear',
    );
  }
  {
    const log: string[] = [];
    await commitAutomaticExpresswayEnd({
      isAndroidNative: true,
      prompt,
      dependencies: dependencies(log),
    });
    assertEqual(
      log.join(','),
      'native:end:prompt-4,end:decision-end-5:5,enqueue-ic,clear-prompt,clear-decision,cancel-local',
      'Java end identity is committed and reused before Dexie cleanup',
    );
  }
  {
    const log: string[] = [];
    const rejected = dependencies(log);
    rejected.resolveNativePrompt = async () => {
      log.push('native:stale');
      throw new Error('stale prompt');
    };
    let failedClosed = false;
    try {
      await commitAutomaticExpresswayKeep({
        isAndroidNative: true,
        prompt,
        decidedAt: '2026-08-23T01:01:00.000Z',
        dependencies: rejected,
      });
    } catch {
      failedClosed = true;
    }
    assertEqual(failedClosed, true, 'stale native prompt rejects the Home action');
    assertEqual(log.join(','), 'native:stale', 'stale prompt leaves Dexie state untouched');
  }
  {
    const log: string[] = [];
    const retrying = dependencies(log);
    let firstEnd = true;
    retrying.endExpressway = async input => {
      log.push(`end:${input.autoDecision?.nativeDetectionId}`);
      if (firstEnd) {
        firstEnd = false;
        throw new Error('simulated Dexie interruption');
      }
      return { eventId: 'stored-end', created: true };
    };
    let firstFailed = false;
    try {
      await commitAutomaticExpresswayEnd({ isAndroidNative: true, prompt, dependencies: retrying });
    } catch {
      firstFailed = true;
    }
    assertEqual(firstFailed, true, 'Dexie interruption keeps the Home dialog retryable');
    assertEqual(log.includes('clear-prompt'), false, 'failed Dexie end never clears its prompt');
    await commitAutomaticExpresswayEnd({ isAndroidNative: true, prompt, dependencies: retrying });
    assertEqual(
      log.filter(item => item === 'native:end:prompt-4').length,
      2,
      'retry asks the idempotent native API for the same decision',
    );
    assertEqual(log.filter(item => item === 'clear-prompt').length, 1, 'only successful retry clears prompt');
  }
  {
    const log: string[] = [];
    await commitAutomaticExpresswayKeep({
      isAndroidNative: false,
      prompt: { ...prompt, promptId: undefined },
      decidedAt: '2026-08-23T01:01:00.000Z',
      dependencies: dependencies(log),
    });
    assertEqual(log.some(item => item.startsWith('native:')), false, 'legacy prompt remains local-only');
    assertEqual(log.includes('clear-prompt'), true, 'legacy keep remains backward compatible');
  }
  {
    const log: string[] = [];
    const upgradedLegacyPrompt: PendingExpresswayEndPrompt = {
      ...prompt,
      promptId: 'legacy-prompt-id',
      reason: {
        ...reason,
        nativeDetectionId: 'legacy-detection-id',
        nativeGeneration: undefined,
      },
    };
    await commitAutomaticExpresswayKeep({
      isAndroidNative: true,
      prompt: upgradedLegacyPrompt,
      decidedAt: '2026-08-23T01:01:00.000Z',
      dependencies: dependencies(log),
    });
    assertEqual(log.some(item => item.startsWith('native:')), false, 'upgrade legacy keep bypasses Java resolve');
    assertEqual(log.includes('clear-prompt'), true, 'upgrade legacy keep remains operable');

    log.length = 0;
    await commitAutomaticExpresswayEnd({
      isAndroidNative: true,
      prompt: upgradedLegacyPrompt,
      dependencies: dependencies(log),
    });
    assertEqual(log.some(item => item.startsWith('native:')), false, 'upgrade legacy end bypasses Java resolve');
    assertEqual(log.some(item => item.startsWith('end:legacy-detection-id:')), true, 'upgrade legacy end stays local');
  }
  {
    const log: string[] = [];
    const mismatch = dependencies(log);
    mismatch.resolveNativePrompt = async input => {
      log.push(`native:mismatch:${input.action}`);
      throw new Error('native prompt mismatch');
    };
    let failedClosed = false;
    try {
      await commitAutomaticExpresswayEnd({
        isAndroidNative: true,
        prompt,
        dependencies: mismatch,
      });
    } catch {
      failedClosed = true;
    }
    assertEqual(failedClosed, true, 'native mismatch fails closed');
    assertEqual(log.join(','), 'native:mismatch:end', 'native mismatch cannot mutate or clear Dexie');
  }
  console.log('nativeExpresswayPromptDecision: 20 tests passed');
}

void run().catch(error => {
  globalThis.setTimeout(() => { throw error; }, 0);
});
