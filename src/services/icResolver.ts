import { getStableDeviceKey } from './deviceIdentity';
import { driverSupabase, SUPABASE_CONFIGURED } from './supabase';

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

async function getFunctionErrorMessage(error: unknown) {
  const fallback = error instanceof Error && error.message
    ? error.message
    : 'IC解決サーバーへの接続に失敗しました';
  const context = (error as { context?: unknown } | null)?.context;
  if (!(context instanceof Response)) return fallback;
  try {
    const body = await context.clone().json() as { error?: unknown };
    return typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : fallback;
  } catch {
    return fallback;
  }
}

async function invokeIcResolver(lat: number, lon: number, radiusM: number): Promise<ExpresswaySignal> {
  if (!SUPABASE_CONFIGURED || !driverSupabase) {
    throw new Error('Supabase が未設定のためIC名を取得できません');
  }

  const { data: sessionData, error: sessionError } = await driverSupabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (!sessionData.session?.access_token) {
    throw new Error('ログインが必要です');
  }

  const { stableDeviceKey } = await getStableDeviceKey();
  const { data, error } = await driverSupabase.functions.invoke<FunctionResponse<EdgeExpresswaySignal>>(
    EDGE_FUNCTION_NAME,
    {
      body: {
        deviceId: stableDeviceKey,
        lat,
        lon,
        radiusM,
      },
    },
  );
  if (error) {
    throw new Error(await getFunctionErrorMessage(error));
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
