import { isOpsTokenHash, opsTokenMatches, readBearerToken } from '../tracklog-ops-status/auth.ts';
import { buildClosedDayReport, buildClosedTripReport, guardPublic, jstDayWindow } from '../tracklog-ops-status/derive.ts';

const TRIP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

export type ClosedTripDeps = {
  tokenHash: string | undefined;
  databaseConfigured: boolean;
  callClosedTrip: (tripId: string) => Promise<unknown>;
  callClosedDay: (date: string) => Promise<unknown>;
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

export function readClosedSelection(
  url: string,
): { tripId: string } | { date: string } | { error: 'invalid_query' | 'invalid_trip_id' | 'invalid_date' } {
  const params = new URL(url).searchParams;
  const tripValue = params.get('trip_id');
  const dateValue = params.get('date');
  const tripId = tripValue?.trim() ?? '';
  const date = dateValue?.trim() ?? '';
  if (tripId && date) return { error: 'invalid_query' };
  if (tripId) {
    if (!TRIP_ID_RE.test(tripId)) return { error: 'invalid_trip_id' };
    return { tripId };
  }
  if (date) {
    if (!jstDayWindow(date)) return { error: 'invalid_date' };
    return { date };
  }
  return { error: 'invalid_trip_id' };
}

export async function handleClosedTrip(request: Request, deps: ClosedTripDeps): Promise<Response> {
  if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405);
  if (!isOpsTokenHash(deps.tokenHash)) return json({ ok: false, error: 'ops_reader_not_configured' }, 503);

  const presented = readBearerToken(request.headers.get('Authorization'));
  if (!presented || !(await opsTokenMatches(presented, deps.tokenHash))) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  if (!deps.databaseConfigured) return json({ ok: false, error: 'ops_reader_not_configured' }, 503);

  const selection = readClosedSelection(request.url);
  if ('error' in selection) return json({ ok: false, error: selection.error }, 400);

  let payload: unknown;
  try {
    payload = unwrapPayload('tripId' in selection
      ? await deps.callClosedTrip(selection.tripId)
      : await deps.callClosedDay(selection.date));
  } catch {
    return json({ ok: false, error: 'status_unavailable' }, 500);
  }

  try {
    const body = 'tripId' in selection
      ? buildClosedTripReport(payload)
      : buildClosedDayReport(payload);
    guardPublic(body);
    return json(body, 200);
  } catch {
    return json({ ok: false, error: 'status_unavailable' }, 500);
  }
}
