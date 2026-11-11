import { isOpsTokenHash, opsTokenMatches, readBearerToken } from '../tracklog-ops-status/auth.ts';
import { buildClosedTripReport, guardPublic } from '../tracklog-ops-status/derive.ts';

const TRIP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

export type ClosedTripDeps = {
  tokenHash: string | undefined;
  databaseConfigured: boolean;
  callClosedTrip: (tripId: string) => Promise<unknown>;
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

export function readTripId(url: string): { tripId: string } | { error: 'invalid_trip_id' } {
  const value = new URL(url).searchParams.get('trip_id');
  if (value == null) return { error: 'invalid_trip_id' };
  const tripId = value.trim();
  if (!TRIP_ID_RE.test(tripId)) return { error: 'invalid_trip_id' };
  return { tripId };
}

export async function handleClosedTrip(request: Request, deps: ClosedTripDeps): Promise<Response> {
  if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405);
  if (!isOpsTokenHash(deps.tokenHash)) return json({ ok: false, error: 'ops_reader_not_configured' }, 503);

  const presented = readBearerToken(request.headers.get('Authorization'));
  if (!presented || !(await opsTokenMatches(presented, deps.tokenHash))) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  if (!deps.databaseConfigured) return json({ ok: false, error: 'ops_reader_not_configured' }, 503);

  const trip = readTripId(request.url);
  if ('error' in trip) return json({ ok: false, error: trip.error }, 400);

  let payload: unknown;
  try {
    payload = unwrapPayload(await deps.callClosedTrip(trip.tripId));
  } catch {
    return json({ ok: false, error: 'status_unavailable' }, 500);
  }

  try {
    const body = buildClosedTripReport(payload);
    guardPublic(body);
    return json(body, 200);
  } catch {
    return json({ ok: false, error: 'status_unavailable' }, 500);
  }
}
