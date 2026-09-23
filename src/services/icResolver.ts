import { Capacitor } from '@capacitor/core';
import type { Session } from '@supabase/supabase-js';
import { getStableDeviceKey } from './deviceIdentity';
import { restoreNativeResidentLocationSession } from './nativeResidentLocation';
import { driverAuthSupabase, SUPABASE_CONFIGURED } from './supabase';
import { invokeIcResolverFunction, withIcResolverTimeout } from './icResolverClient';

export type IcResult = { icName: string; distanceM: number };

export type ExpresswaySignal = {
  resolved: boolean;
  provider: 'overpass' | 'none';
  onExpresswayRoad: boolean;
  nearIc: boolean;
  nearEtcGate: boolean;
  nearestIc: IcResult | null;
};

type FunctionResponse<T> = {
  ok?: boolean;
  data?: T;
  error?: string;
};

type EdgeExpresswaySignal = Omit<ExpresswaySignal, 'provider'> & {
  provider: 'overpass';
};

const DEFAULT_RADIUS_M = 8000;
const MIN_RADIUS_M = 250;
const MAX_RADIUS_M = 12000;
export const MAX_PRIMARY_IC_DISTANCE_M = 1200;
export const MAX_CORROBORATED_IC_DISTANCE_M = 2000;
const SESSION_REFRESH_MARGIN_MS = 60_000;
const runSharedSessionRefresh = createIcResolverSessionTaskRunner<Session>();

export type IcResolverHttpFailureCategory =
  | 'authorization-recoverable'
  | 'temporary'
  | 'permanent';

function isAndroidNative() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export class IcResolverError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;
  readonly category: IcResolverHttpFailureCategory;

  constructor(
    message: string,
    retryable: boolean,
    status: number | null = null,
    category?: IcResolverHttpFailureCategory,
  ) {
    super(message);
    this.name = 'IcResolverError';
    this.retryable = retryable;
    this.status = status;
    this.category = category ?? (retryable ? classifyIcResolverHttpStatus(status) : 'permanent');
  }
}

export function isRetryableIcResolverError(error: unknown): boolean {
  return error instanceof IcResolverError && error.retryable;
}

export function getRetryableIcResolverErrorCategory(
  error: unknown,
): Exclude<IcResolverHttpFailureCategory, 'permanent'> | null {
  if (!(error instanceof IcResolverError) || !error.retryable || error.category === 'permanent') {
    return null;
  }
  return error.category;
}

function unresolvedSignal(): ExpresswaySignal {
  return {
    resolved: false,
    provider: 'none',
    onExpresswayRoad: false,
    nearIc: false,
    nearEtcGate: false,
    nearestIc: null,
  };
}

function normalizeRadius(radiusM: number) {
  if (!Number.isFinite(radiusM)) return DEFAULT_RADIUS_M;
  return Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, Math.round(radiusM)));
}

function assertCoordinates(lat: number, lon: number) {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error('緯度が不正です');
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new Error('経度が不正です');
  }
}

function parseIcResult(value: unknown): IcResult | null {
  if (value == null) return null;
  if (typeof value !== 'object') throw new Error('IC解決サーバーの応答が不正です');
  const row = value as Record<string, unknown>;
  const icName = typeof row.icName === 'string' ? row.icName.trim() : '';
  const distanceM = Number(row.distanceM);
  if (!icName || icName.length > 80 || !Number.isFinite(distanceM) || distanceM < 0) {
    throw new Error('IC解決サーバーの応答が不正です');
  }
  return {
    icName,
    distanceM: Math.round(distanceM),
  };
}

export function acceptIcCandidate(
  result: IcResult | null,
  evidence?: Pick<ExpresswaySignal, 'onExpresswayRoad' | 'nearEtcGate'>,
): IcResult | null {
  if (!result) return null;
  if (result.distanceM <= MAX_PRIMARY_IC_DISTANCE_M) return result;
  if (result.distanceM > MAX_CORROBORATED_IC_DISTANCE_M) return null;
  // The current Edge response does not expose candidate source or runner-up
  // separation. In the ambiguous middle band, require two independent road
  // signals instead of guessing from distance alone.
  return evidence?.nearEtcGate === true && evidence.onExpresswayRoad === true
    ? result
    : null;
}

function parseSignal(value: unknown): ExpresswaySignal {
  if (!value || typeof value !== 'object') {
    throw new Error('IC解決サーバーの応答が不正です');
  }
  const row = value as Record<string, unknown>;
  if (row.resolved !== true || row.provider !== 'overpass') {
    throw new Error('IC解決サーバーの応答が不正です');
  }
  const nearestIc = parseIcResult(row.nearestIc);
  const onExpresswayRoad = row.onExpresswayRoad === true;
  const nearEtcGate = row.nearEtcGate === true;
  return {
    resolved: true,
    provider: 'overpass',
    onExpresswayRoad,
    nearIc: row.nearIc === true,
    nearEtcGate,
    nearestIc: acceptIcCandidate(nearestIc, { onExpresswayRoad, nearEtcGate }),
  };
}

export async function getFunctionErrorDetails(error: unknown, timeoutMs = 2000): Promise<{
  message: string;
  status: number | null;
}> {
  const fallback = error instanceof Error && error.message
    ? error.message
    : 'IC解決サーバーへの接続に失敗しました';
  const context = (error as { context?: unknown } | null)?.context;
  if (typeof Response === 'undefined' || !(context instanceof Response)) {
    return { message: fallback, status: null };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // functions.invoke clears its timer as soon as a non-2xx header arrives.
    // A stalled error body must not pin the event and retry batch forever.
    const body = await Promise.race([
      context.json() as Promise<{ error?: unknown }>,
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    return {
      message: typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : fallback,
      status: context.status,
    };
  } catch {
    return { message: fallback, status: context.status };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function classifyIcResolverHttpStatus(status: number | null): IcResolverHttpFailureCategory {
  if (status === 401 || status === 403) return 'authorization-recoverable';
  if (status == null) return 'temporary';
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'temporary';
  return 'permanent';
}

function isRetryableHttpStatus(status: number | null) {
  return classifyIcResolverHttpStatus(status) !== 'permanent';
}

function authErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message.trim() : fallback;
}

function recoverableAuthorizationError(message: string) {
  return new IcResolverError(message, true, null, 'authorization-recoverable');
}

/** Native refresh already owns permanent rejection and its shared cooldown. */
export async function runIcResolverNativeSessionRestore(
  restore: () => Promise<unknown>,
  timeoutMs?: number,
): Promise<void> {
  try {
    await withIcResolverTimeout(restore, timeoutMs);
  } catch (error) {
    // A native bridge/network failure is not evidence of a rejected login.
    // Treating it as authorization failure delays IC recovery for 15 minutes.
    throw new IcResolverError(
      authErrorMessage(error, 'ログイン状態を一時的に更新できませんでした'),
      true,
      null,
      'temporary',
    );
  }
}

async function refreshResolverSession(current: Session): Promise<Session> {
  const client = driverAuthSupabase;
  if (!client) throw recoverableAuthorizationError('Supabase が未設定です');
  return runSharedSessionRefresh(async () => {
    try {
      const result = isAndroidNative()
        ? await (async () => {
            await runIcResolverNativeSessionRestore(() => restoreNativeResidentLocationSession({ forceRefresh: true }));
            return client.auth.getSession();
          })()
        : await client.auth.refreshSession({
            refresh_token: current.refresh_token,
          });
      const { data, error } = result;
      if (error) {
        throw recoverableAuthorizationError(authErrorMessage(error, 'ログイン状態を更新できませんでした'));
      }
      if (!data.session?.access_token) {
        throw recoverableAuthorizationError('ログイン状態を更新できませんでした');
      }
      return data.session;
    } catch (error) {
      if (error instanceof IcResolverError) throw error;
      throw recoverableAuthorizationError(authErrorMessage(error, 'ログイン状態を更新できませんでした'));
    }
  });
}

async function getResolverSession(): Promise<Session> {
  if (!driverAuthSupabase) throw recoverableAuthorizationError('Supabase が未設定です');
  let result;
  try {
    await runIcResolverNativeSessionRestore(() => restoreNativeResidentLocationSession());
    result = await driverAuthSupabase.auth.getSession();
  } catch (error) {
    if (error instanceof IcResolverError) throw error;
    throw recoverableAuthorizationError(authErrorMessage(error, 'ログイン状態を確認できませんでした'));
  }
  const { data, error } = result;
  if (error) {
    throw recoverableAuthorizationError(authErrorMessage(error, 'ログイン状態を確認できませんでした'));
  }
  const session = data.session;
  if (!session?.access_token) throw recoverableAuthorizationError('ログインが必要です');
  const expiresAtMs = (session.expires_at ?? 0) * 1000;
  if (expiresAtMs <= Date.now() + SESSION_REFRESH_MARGIN_MS) {
    return refreshResolverSession(session);
  }
  return session;
}

async function invokeWithSession<T>(
  session: Session,
  body: Record<string, unknown>,
) {
  if (!invokeIcResolverFunction) throw new IcResolverError('Supabase が未設定です', true);
  return invokeIcResolverFunction<FunctionResponse<T>>(session.access_token, body);
}

export async function runIcResolverSessionTask<T>(task: () => Promise<T>, timeoutMs?: number): Promise<T> {
  try {
    return await withIcResolverTimeout(task, timeoutMs);
  } catch (error) {
    if (error instanceof IcResolverError) throw error;
    throw new IcResolverError(authErrorMessage(error, 'ログイン状態を一時的に確認できませんでした'), true, null, 'temporary');
  }
}

/** Share a bounded waiter; native code continues owning any underlying refresh mutation. */
export function createIcResolverSessionTaskRunner<T>(timeoutMs?: number) {
  let inFlight: Promise<T> | null = null;
  return (task: () => Promise<T>): Promise<T> => {
    if (inFlight) return inFlight;
    const pending = runIcResolverSessionTask(task, timeoutMs);
    inFlight = pending;
    const clear = () => { if (inFlight === pending) inFlight = null; };
    void pending.then(clear, clear);
    return pending;
  };
}

export async function invokeIcResolverAction<T>(requestBody: Record<string, unknown>): Promise<T> {
  if (!SUPABASE_CONFIGURED || !invokeIcResolverFunction) {
    throw new Error('Supabase が未設定のためIC名を取得できません');
  }

  let session = await runIcResolverSessionTask(getResolverSession);
  const { stableDeviceKey } = await runIcResolverSessionTask(getStableDeviceKey);
  const body = {
    ...requestBody,
    deviceId: stableDeviceKey,
  };

  let response;
  try {
    response = await invokeWithSession<T>(session, body);
  } catch (error) {
    throw new IcResolverError(authErrorMessage(error, 'IC解決サーバーへの接続に失敗しました'), true);
  }

  let errorDetails = response.error ? await getFunctionErrorDetails(response.error) : null;
  if (errorDetails) {
    if (errorDetails.status === 401) {
      session = await runIcResolverSessionTask(() => refreshResolverSession(session));
      try {
        response = await invokeWithSession<T>(session, body);
        errorDetails = null;
      } catch (error) {
        throw new IcResolverError(authErrorMessage(error, 'IC解決サーバーへの接続に失敗しました'), true);
      }
    }
  }

  const { data, error } = response;
  if (error) {
    const details = errorDetails ?? await getFunctionErrorDetails(error);
    throw new IcResolverError(details.message, isRetryableHttpStatus(details.status), details.status);
  }
  if (!data?.ok) {
    throw new Error(data?.error?.trim() || 'IC解決サーバー処理に失敗しました');
  }
  return data.data as T;
}

/** Resolves the nearest IC through the authenticated TrackLog Edge Function. */
export async function resolveNearestIC(
  lat: number,
  lon: number,
  radiusM = DEFAULT_RADIUS_M,
): Promise<IcResult | null> {
  const signal = await detectExpresswaySignal(lat, lon, radiusM);
  return signal.nearestIc;
}

export async function detectExpresswaySignal(
  lat: number,
  lon: number,
  radiusM = DEFAULT_RADIUS_M,
): Promise<ExpresswaySignal> {
  assertCoordinates(lat, lon);
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return unresolvedSignal();
  }
  return parseSignal(await invokeIcResolverAction<EdgeExpresswaySignal>({ lat, lon, radiusM: normalizeRadius(radiusM) }));
}
