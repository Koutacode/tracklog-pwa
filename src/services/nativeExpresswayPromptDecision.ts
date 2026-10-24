import {
  clearPendingExpresswayEndDecision,
  clearPendingExpresswayEndPrompt,
  clearPendingExpresswayEndPromptIfMatches,
  commitPendingExpresswayKeepDecision,
  endExpressway,
  getEventsByTripId,
  getLatestRoutePointForTrip,
  getPendingExpresswayEndPrompt,
  setPendingExpresswayEndDecision,
  type AutoExpresswayDecisionReason,
  type PendingExpresswayEndPrompt,
} from '../db/repositories';
import { enqueueNotificationExpresswayEndIcResolution } from './expresswayIcResolution';
import { cancelNativeExpresswayEndPrompt } from './nativeExpresswayPrompt';
import {
  EXPRESSWAY_PROMPT_MAX_AGE_MS,
  isFreshExpresswayEndPrompt,
  matchesExpresswayPromptDecision,
} from '../domain/expresswayPromptFreshness';
import {
  resolveNativeResidentExpresswayPrompt,
  type NativeResidentExpresswayPromptResolution,
} from './nativeResidentLocation';

type AutomaticPromptDecisionDependencies = {
  resolveNativePrompt: typeof resolveNativeResidentExpresswayPrompt;
  setPendingDecision: typeof setPendingExpresswayEndDecision;
  commitPendingKeepDecision: typeof commitPendingExpresswayKeepDecision;
  clearPendingPrompt: typeof clearPendingExpresswayEndPrompt;
  clearPendingPromptIfMatches: typeof clearPendingExpresswayEndPromptIfMatches;
  clearPendingDecision: typeof clearPendingExpresswayEndDecision;
  endExpressway: typeof endExpressway;
  enqueueEndIcResolution: typeof enqueueNotificationExpresswayEndIcResolution;
  cancelLocalNotification: typeof cancelNativeExpresswayEndPrompt;
  getEventsByTripId: typeof getEventsByTripId;
  getLatestRoutePointForTrip: typeof getLatestRoutePointForTrip;
  getPendingPrompt: typeof getPendingExpresswayEndPrompt;
  now(): number;
};

const DEFAULT_DEPENDENCIES: AutomaticPromptDecisionDependencies = {
  resolveNativePrompt: resolveNativeResidentExpresswayPrompt,
  setPendingDecision: setPendingExpresswayEndDecision,
  commitPendingKeepDecision: commitPendingExpresswayKeepDecision,
  clearPendingPrompt: clearPendingExpresswayEndPrompt,
  clearPendingPromptIfMatches: clearPendingExpresswayEndPromptIfMatches,
  clearPendingDecision: clearPendingExpresswayEndDecision,
  endExpressway,
  enqueueEndIcResolution: enqueueNotificationExpresswayEndIcResolution,
  cancelLocalNotification: cancelNativeExpresswayEndPrompt,
  getEventsByTripId,
  getLatestRoutePointForTrip,
  getPendingPrompt: getPendingExpresswayEndPrompt,
  now: Date.now,
};

async function assertPromptStillCurrent(
  isAndroidNative: boolean,
  prompt: PendingExpresswayEndPrompt,
  dependencies: AutomaticPromptDecisionDependencies,
): Promise<void> {
  const current = await dependencies.getPendingPrompt();
  if (!current && !isJavaOwnedExpresswayPrompt(isAndroidNative, prompt)) {
    throw new Error('この高速道路の確認はすでに更新されています。');
  }
  if (current && (current.detectedAt !== prompt.detectedAt
    || !matchesExpresswayPromptDecision({
      tripId: prompt.tripId,
      promptId: prompt.promptId,
      nativeDetectionId: prompt.reason?.nativeDetectionId,
      detectedAt: prompt.detectedAt,
    }, current))) {
    throw new Error('この高速道路の確認はすでに更新されています。');
  }
}

async function requireFreshWebPrompt(
  isAndroidNative: boolean,
  prompt: PendingExpresswayEndPrompt,
  dependencies: AutomaticPromptDecisionDependencies,
): Promise<void> {
  if (isJavaOwnedExpresswayPrompt(isAndroidNative, prompt)) return;
  const nowMs = dependencies.now();
  const fresh = isFreshExpresswayEndPrompt({
    detectedAt: prompt.detectedAt,
    decidedAt: new Date(nowMs).toISOString(),
    geo: prompt.geo,
    events: await dependencies.getEventsByTripId(prompt.tripId),
    latestFix: await dependencies.getLatestRoutePointForTrip(
      prompt.tripId, nowMs, EXPRESSWAY_PROMPT_MAX_AGE_MS,
      prompt.geo, prompt.detectedAt),
  });
  if (fresh) return;
  const cleared = await dependencies.clearPendingPromptIfMatches({
    tripId: prompt.tripId,
    promptId: prompt.promptId,
    nativeDetectionId: prompt.reason?.nativeDetectionId,
    detectedAt: prompt.detectedAt,
  });
  if (cleared) await dependencies.cancelLocalNotification(prompt.tripId).catch(() => undefined);
  throw new Error('高速道路の確認候補が古くなりました。現在地を確認して再度操作してください。');
}

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
  await assertPromptStillCurrent(options.isAndroidNative, options.prompt, dependencies);
  await requireFreshWebPrompt(options.isAndroidNative, options.prompt, dependencies);
  const nativeResolution = await resolveJavaOwnedPrompt({
    isAndroidNative: options.isAndroidNative,
    prompt: options.prompt,
    action: 'keep',
    dependencies,
  });
  if (!nativeResolution) {
    await dependencies.commitPendingKeepDecision({
      tripId: options.prompt.tripId,
      ...(options.prompt.promptId ? { promptId: options.prompt.promptId } : {}),
      action: 'keep',
      decidedAt: options.decidedAt,
      detectedAt: options.prompt.detectedAt,
      speedKmh: options.prompt.speedKmh,
      geo: options.prompt.geo,
    }, { detectedAt: options.prompt.detectedAt,
      promptId: options.prompt.promptId,
      nativeDetectionId: options.prompt.reason?.nativeDetectionId });
    await dependencies.cancelLocalNotification(options.prompt.tripId).catch(() => undefined);
    return;
  }
  await dependencies.setPendingDecision({
    tripId: options.prompt.tripId,
    ...(nativeResolution ? { nativeDetectionId: nativeResolution.eventId } : {}),
    ...(options.prompt.promptId ? { promptId: options.prompt.promptId } : {}),
    action: 'keep',
    decidedAt: nativeResolution?.decidedAt ?? options.decidedAt,
    detectedAt: options.prompt.detectedAt,
    speedKmh: options.prompt.speedKmh,
    geo: options.prompt.geo,
  });
  if (await dependencies.clearPendingPromptIfMatches({
    tripId: options.prompt.tripId,
    promptId: options.prompt.promptId,
    nativeDetectionId: options.prompt.reason?.nativeDetectionId,
    detectedAt: options.prompt.detectedAt,
  })) await dependencies.cancelLocalNotification(options.prompt.tripId).catch(() => undefined);
}

export async function commitAutomaticExpresswayEnd(options: {
  isAndroidNative: boolean;
  prompt: PendingExpresswayEndPrompt;
  dependencies?: Partial<AutomaticPromptDecisionDependencies>;
}): Promise<{ eventId: string }> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  await assertPromptStillCurrent(options.isAndroidNative, options.prompt, dependencies);
  await requireFreshWebPrompt(options.isAndroidNative, options.prompt, dependencies);
  const nativeResolution = await resolveJavaOwnedPrompt({
    isAndroidNative: options.isAndroidNative,
    prompt: options.prompt,
    action: 'end',
    dependencies,
  });
  const { eventId, created } = await dependencies.endExpressway({
    tripId: options.prompt.tripId,
    geo: options.prompt.geo,
    ...(nativeResolution ? { occurredAt: nativeResolution.decidedAt } : {}),
    autoDecision: decisionReason(options.prompt, nativeResolution),
    ...(!isJavaOwnedExpresswayPrompt(options.isAndroidNative, options.prompt)
      ? { expectedPrompt: {
        detectedAt: options.prompt.detectedAt,
        promptId: options.prompt.promptId,
        nativeDetectionId: options.prompt.reason?.nativeDetectionId,
      } } : {}),
    source: 'automatic_detection',
    automaticConfirmation: 'confirmed',
  });
  if (created) dependencies.enqueueEndIcResolution({ eventId, geo: options.prompt.geo });
  await dependencies.clearPendingPromptIfMatches({
    tripId: options.prompt.tripId,
    promptId: options.prompt.promptId,
    nativeDetectionId: options.prompt.reason?.nativeDetectionId,
    detectedAt: options.prompt.detectedAt,
  });
  if (created) await dependencies.cancelLocalNotification(options.prompt.tripId).catch(() => undefined);
  return { eventId };
}
