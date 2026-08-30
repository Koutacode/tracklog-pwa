export type ExpresswayEndSource =
  | 'manual_button'
  | 'voice'
  | 'automatic_detection';

export type ExpresswayEndCommitAuthorization =
  | { source: Exclude<ExpresswayEndSource, 'automatic_detection'> }
  | {
      source: 'automatic_detection';
      automaticConfirmation: 'confirmed';
    };

export type ImmediateExpresswayEndAuthorization = Extract<
  ExpresswayEndCommitAuthorization,
  { source: 'manual_button' | 'voice' }
>;

export type ExpresswayEndRequestResult =
  | { status: 'completed' }
  | { status: 'requires_confirmation' };

export type ExpresswayEndRequestDecision =
  | {
      source: Exclude<ExpresswayEndSource, 'automatic_detection'>;
      disposition: 'commit_immediately';
    }
  | {
      source: 'automatic_detection';
      disposition: 'requires_confirmation';
    };

export const INVALID_EXPRESSWAY_END_AUTHORIZATION =
  '高速終了の入力元または確認状態が不正です';

export function assertExpresswayEndCommitAuthorization(
  value: unknown,
): asserts value is ExpresswayEndCommitAuthorization {
  if (!value || typeof value !== 'object') {
    throw new Error(INVALID_EXPRESSWAY_END_AUTHORIZATION);
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.source === 'manual_button' || candidate.source === 'voice') return;
  if (
    candidate.source === 'automatic_detection'
    && candidate.automaticConfirmation === 'confirmed'
  ) {
    return;
  }
  throw new Error(INVALID_EXPRESSWAY_END_AUTHORIZATION);
}

/**
 * Keeps confirmation policy at the request boundary. Automatic detection may
 * suggest an end, but only a separately confirmed prompt may reach storage.
 */
export function decideExpresswayEndRequest(
  source: ExpresswayEndSource,
): ExpresswayEndRequestDecision {
  return source === 'automatic_detection'
    ? { source, disposition: 'requires_confirmation' }
    : { source, disposition: 'commit_immediately' };
}

/**
 * Executes only requests that policy permits immediately. The automatic source
 * can never invoke `commit`; its persisted prompt/decision flow owns that path.
 */
export async function executeExpresswayEndRequest(
  source: ExpresswayEndSource,
  commit: (authorization: ImmediateExpresswayEndAuthorization) => Promise<boolean>,
): Promise<ExpresswayEndRequestResult | undefined> {
  const decision = decideExpresswayEndRequest(source);
  if (decision.disposition === 'requires_confirmation') {
    return { status: 'requires_confirmation' };
  }
  const completed = await commit({ source: decision.source });
  return completed ? { status: 'completed' } : undefined;
}
