import { Capacitor } from '@capacitor/core';
import type { Session } from '@supabase/supabase-js';
import { getStableDeviceKey } from './deviceIdentity';
import { restoreNativeResidentLocationSession } from './nativeResidentLocation';
import { driverAuthSupabase, driverSupabase, SUPABASE_CONFIGURED } from './supabase';

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

const EDGE_FUNCTION_NAME = 'tracklog-ic-resolver';
const DEFAULT_RADIUS_M = 8000;
const MIN_RADIUS_M = 250;
const MAX_RADIUS_M = 12000;
const SESSION_REFRESH_MARGIN_MS = 60_000;
let sessionRefreshInFlight: Promise<Session> | null = null;

function isAndroidNative() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

class IcResolverError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(message: string, retryable: boolean, status: number | null = null) {
    super(message);
    this.name = 'IcResolverError';
    this.retryable = retryable;
    this.status = status;
  }
}

export function isRetryableIcResolverError(error: unknown): boolean {
  return error instanceof IcResolverError && error.retryable;
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

function parseSignal(value: unknown): ExpresswaySignal {
  if (!value || typeof value !== 'object') {
    throw new Error('IC解決サーバーの応答が不正です');
  }
  const row = value as Record<string, unknown>;
  if (row.resolved !== true || row.provider !== 'overpass') {
    throw new Error('IC解決サーバーの応答が不正です');
  }
  return {
    resolved: true,
    provider: 'overpass',
    onExpresswayRoad: row.onExpresswayRoad === true,
    nearIc: row.nearIc === true,
    nearEtcGate: row.nearEtcGate === true,
    nearestIc: parseIcResult(row.nearestIc),
  };
}

async function getFunctionErrorDetails(error: unknown): Promise<{
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
  try {
    const body = await context.clone().json() as { error?: unknown };
    return {
      message: typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : fallback,
      status: context.status,
    };
  } catch {
    return { message: fallback, status: context.status };
  }
}

function isRetryableHttpStatus(status: number | null) {
  if (status == null) return true;
  return status === 401 || status === 408 || status === 425 || status === 429 || status >= 500;
}

function authErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message.trim() : fallback;
}

async function refreshResolverSession(current: Session): Promise<Session> {
  if (!driverAuthSupabase) throw new IcResolverError('Supabase が未設定です', true);
  if (sessionRefreshInFlight) return sessionRefreshInFlight;

  sessionRefreshInFlight = (async () => {
    try {
      const result = isAndroidNative()
        ? await (async () => {
            await restoreNativeResidentLocationSession({ forceRefresh: true });
            return driverAuthSupabase.auth.getSession();
          })()
        : await driverAuthSupabase.auth.refreshSession({
            refresh_token: current.refresh_token,
          });
      const { data, error } = result;
      if (error) {
        throw new IcResolverError(authErrorMessage(error, 'ログイン状態を更新できませんでした'), true);
      }
      if (!data.session?.access_token) {
        throw new IcResolverError('ログイン状態を更新できませんでした', true);
      }
      return data.session;
    } catch (error) {
      if (error instanceof IcResolverError) throw error;
      throw new IcResolverError(authErrorMessage(error, 'ログイン状態を更新できませんでした'), true);
    }
  })();

  try {
    return await sessionRefreshInFlight;
  } finally {
    sessionRefreshInFlight = null;
  }
}

async function getResolverSession(): Promise<Session> {
  if (!driverAuthSupabase) throw new IcResolverError('Supabase が未設定です', true);
  let result;
  try {
    await restoreNativeResidentLocationSession();
    result = await driverAuthSupabase.auth.getSession();
  } catch (error) {
    throw new IcResolverError(authErrorMessage(error, 'ログイン状態を確認できませんでした'), true);
  }
  const { data, error } = result;
  if (error) {
    throw new IcResolverError(authErrorMessage(error, 'ログイン状態を確認できませんでした'), true);
  }
  const session = data.session;
  if (!session?.access_token) throw new IcResolverError('ログインが必要です', true);
  const expiresAtMs = (session.expires_at ?? 0) * 1000;
  if (expiresAtMs <= Date.now() + SESSION_REFRESH_MARGIN_MS) {
    return refreshResolverSession(session);
  }
  return session;
}

async function invokeWithSession(
  session: Session,
  body: { deviceId: string; lat: number; lon: number; radiusM: number },
) {
  if (!driverSupabase) throw new IcResolverError('Supabase が未設定です', true);
  return driverSupabase.functions.invoke<FunctionResponse<EdgeExpresswaySignal>>(
    EDGE_FUNCTION_NAME,
    {
      body,
      headers: { Authorization: `Bearer ${session.access_token}` },
    },
  );
}

async function invokeIcResolver(lat: number, lon: number, radiusM: number): Promise<ExpresswaySignal> {
  if (!SUPABASE_CONFIGURED || !driverSupabase) {
    throw new Error('Supabase が未設定のためIC名を取得できません');
  }

  let session = await getResolverSession();
  const { stableDeviceKey } = await getStableDeviceKey();
  const body = {
    deviceId: stableDeviceKey,
    lat,
    lon,
    radiusM,
  };

  let response;
  try {
    response = await invokeWithSession(session, body);
  } catch (error) {
    throw new IcResolverError(authErrorMessage(error, 'IC解決サーバーへの接続に失敗しました'), true);
  }

  if (response.error) {
    const firstError = await getFunctionErrorDetails(response.error);
    if (firstError.status === 401) {
      session = await refreshResolverSession(session);
      try {
        response = await invokeWithSession(session, body);
      } catch (error) {
        throw new IcResolverError(authErrorMessage(error, 'IC解決サーバーへの接続に失敗しました'), true);
      }
    }
  }

  const { data, error } = response;
  if (error) {
    const details = await getFunctionErrorDetails(error);
    throw new IcResolverError(details.message, isRetryableHttpStatus(details.status), details.status);
  }
  if (!data?.ok) {
    throw new Error(data?.error?.trim() || 'IC解決サーバー処理に失敗しました');
  }
  return parseSignal(data.data);
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
  return invokeIcResolver(lat, lon, normalizeRadius(radiusM));
}
