import { isOpsTokenHash, opsTokenMatches, readBearerToken } from './auth.ts';
import { applyCoarsePlace, buildOpsStatus, guardPublic, type OpsPlace } from './derive.ts';

const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

export type OpsStatusDeps = {
  tokenHash: string | undefined;
  databaseConfigured: boolean;
  callStatus: (deviceId: string | null) => Promise<unknown>;
  reverseGeocode: (lat: number, lng: number) => Promise<OpsPlace | null>;
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function unwrapPayload(data: unknown): unknown {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function readDeviceId(url: string): { deviceId: string | null } | { error: 'invalid_device_id' } {
  const value = new URL(url).searchParams.get('device_id');
  if (value == null || value.trim() === '') return { deviceId: null };
  const deviceId = value.trim();
  if (!DEVICE_ID_RE.test(deviceId)) return { error: 'invalid_device_id' };
  return { deviceId };
}

export async function handleOpsStatus(request: Request, deps: OpsStatusDeps): Promise<Response> {
  if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405);
  if (!isOpsTokenHash(deps.tokenHash)) return json({ ok: false, error: 'ops_reader_not_configured' }, 503);

  const presented = readBearerToken(request.headers.get('Authorization'));
  if (!presented || !(await opsTokenMatches(presented, deps.tokenHash))) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  if (!deps.databaseConfigured) return json({ ok: false, error: 'ops_reader_not_configured' }, 503);

  const device = readDeviceId(request.url);
  if ('error' in device) return json({ ok: false, error: device.error }, 400);

  let payload: unknown;
  try {
    payload = unwrapPayload(await deps.callStatus(device.deviceId));
  } catch {
    return json({ ok: false, error: 'status_unavailable' }, 500);
  }

  try {
    const built = buildOpsStatus(payload);
    let body = built.body;
    if (built.geocode && body.trip_active === true && body.place == null) {
      const place = await deps.reverseGeocode(built.geocode.lat, built.geocode.lng);
      body = applyCoarsePlace(body, place);
    }
    guardPublic(body);
    return json(body, built.status);
  } catch {
    return json({ ok: false, error: 'status_unavailable' }, 500);
  }
}
