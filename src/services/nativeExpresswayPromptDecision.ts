import {
  clearPendingExpresswayEndDecision,
  clearPendingExpresswayEndPrompt,
  endExpressway,
  setPendingExpresswayEndDecision,
  type AutoExpresswayDecisionReason,
  type PendingExpresswayEndPrompt,
} from '../db/repositories';
import { enqueueNotificationExpresswayEndIcResolution } from './expresswayIcResolution';
import { cancelNativeExpresswayEndPrompt } from './nativeExpresswayPrompt';
import {
  resolveNativeResidentExpresswayPrompt,
  type NativeResidentExpresswayPromptResolution,
} from './nativeResidentLocation';

type AutomaticPromptDecisionDependencies = {
  resolveNativePrompt: typeof resolveNativeResidentExpresswayPrompt;
  setPendingDecision: typeof setPendingExpresswayEndDecision;
  clearPendingPrompt: typeof clearPendingExpresswayEndPrompt;
  clearPendingDecision: typeof clearPendingExpresswayEndDecision;
  endExpressway: typeof endExpressway;
  enqueueEndIcResolution: typeof enqueueNotificationExpresswayEndIcResolution;
  cancelLocalNotification: typeof cancelNativeExpresswayEndPrompt;
};

const DEFAULT_DEPENDENCIES: AutomaticPromptDecisionDependencies = {
  resolveNativePrompt: resolveNativeResidentExpresswayPrompt,
  setPendingDecision: setPendingExpresswayEndDecision,
  clearPendingPrompt: clearPendingExpresswayEndPrompt,
  clearPendingDecision: clearPendingExpresswayEndDecision,
  endExpressway,
  enqueueEndIcResolution: enqueueNotificationExpresswayEndIcResolution,
  cancelLocalNotification: cancelNativeExpresswayEndPrompt,
};

export function isJavaOwnedExpresswayPrompt(
  isAndroidNative: boolean,
  prompt: PendingExpresswayEndPrompt,
): boolean {
  const promptId = prompt.promptId?.trim() ?? '';
  const nativeDetectionId = prompt.reason?.nativeDetectionId?.trim() ?? '';
  const nativeGeneration = Number(prompt.reason?.nativeGeneration);
  return isAndroidNative
    && !!promptId
    && nativeDetectionId === promptId
    && Number.isSafeInteger(nativeGeneration)
    && nativeGeneration >= 1;
}

async function resolveJavaOwnedPrompt(options: {
  isAndroidNative: boolean;
  prompt: PendingExpresswayEndPrompt;
  action: 'end' | 'keep';
  dependencies: AutomaticPromptDecisionDependencies;
}): Promise<NativeResidentExpresswayPromptResolution | null> {
  const promptId = options.prompt.promptId?.trim() ?? '';
  if (!isJavaOwnedExpresswayPrompt(options.isAndroidNative, options.prompt)) return null;
  // This durable native commit must precede every Dexie clear. If Java rejects
  // a stale/mismatched prompt or storage is unavailable, the dialog stays open.
  return options.dependencies.resolveNativePrompt({
    promptId,
    action: options.action,
  });
}

function decisionReason(
  prompt: PendingExpresswayEndPrompt,
  resolution: NativeResidentExpresswayPromptResolution | null,
): AutoExpresswayDecisionReason | undefined {
  if (!prompt.reason || !resolution) return prompt.reason;
  return {
    ...prompt.reason,
    nativeDetectionId: resolution.eventId,
    nativeGeneration: resolution.generation,
    evaluatedAt: prompt.detectedAt,
  };
}

export async function commitAutomaticExpresswayKeep(options: {
  isAndroidNative: boolean;
  prompt: PendingExpresswayEndPrompt;
  decidedAt: string;
  dependencies?: Partial<AutomaticPromptDecisionDependencies>;
}): Promise<void> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  const nativeResolution = await resolveJavaOwnedPrompt({
    isAndroidNative: options.isAndroidNative,
    prompt: options.prompt,
    action: 'keep',
    dependencies,
  });
  await dependencies.setPendingDecision({
    tripId: options.prompt.tripId,
    ...(nativeResolution ? { nativeDetectionId: nativeResolution.eventId } : {}),
    ...(options.prompt.promptId ? { promptId: options.prompt.promptId } : {}),
    action: 'keep',
    decidedAt: options.decidedAt,
    speedKmh: options.prompt.speedKmh,
    geo: options.prompt.geo,
  });
  await dependencies.clearPendingPrompt(options.prompt.tripId);
  await dependencies.cancelLocalNotification(options.prompt.tripId).catch(() => undefined);
}

export async function commitAutomaticExpresswayEnd(options: {
  isAndroidNative: boolean;
  prompt: PendingExpresswayEndPrompt;
  dependencies?: Partial<AutomaticPromptDecisionDependencies>;
}): Promise<{ eventId: string }> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  const nativeResolution = await resolveJavaOwnedPrompt({
    isAndroidNative: options.isAndroidNative,
    prompt: options.prompt,
    action: 'end',
    dependencies,
  });
  const { eventId } = await dependencies.endExpressway({
    tripId: options.prompt.tripId,
    geo: options.prompt.geo,
    autoDecision: decisionReason(options.prompt, nativeResolution),
    source: 'automatic_detection',
    automaticConfirmation: 'confirmed',
  });
  dependencies.enqueueEndIcResolution({ eventId, geo: options.prompt.geo });
  await dependencies.clearPendingPrompt(options.prompt.tripId);
  await dependencies.clearPendingDecision(options.prompt.tripId);
  await dependencies.cancelLocalNotification(options.prompt.tripId).catch(() => undefined);
  return { eventId };
}
