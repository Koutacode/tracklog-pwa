import type { AppEvent, Geo, RoutePoint } from './types';

// A driver can answer after stopping safely, but an old road observation must
// not be attached to a new confirmation time after a rest or another drive.
export const EXPRESSWAY_PROMPT_MAX_AGE_MS = 30 * 60_000;
export const EXPRESSWAY_PROMPT_MOVE_METERS = 500;

export function matchesExpresswayPromptDecision(
  decision: { tripId: string; promptId?: string; nativeDetectionId?: string },
  prompt: { tripId: string; promptId?: string;
    reason?: { nativeDetectionId?: string } } | null,
): boolean {
  if (!prompt || decision.tripId !== prompt.tripId) return false;
  if (decision.promptId) return decision.promptId === prompt.promptId;
  return !!decision.nativeDetectionId
    && decision.nativeDetectionId === prompt.reason?.nativeDetectionId;
}

function distanceMeters(first: Geo, second: Geo): number {
  const lat = (second.lat - first.lat) * Math.PI / 180;
  const lng = (second.lng - first.lng) * Math.PI / 180;
  const a = Math.sin(lat / 2) ** 2
    + Math.cos(first.lat * Math.PI / 180) * Math.cos(second.lat * Math.PI / 180)
    * Math.sin(lng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

export function isFreshExpresswayEndPrompt(input: {
  detectedAt: string;
  decidedAt: string;
  geo: Geo;
  events: readonly AppEvent[];
  latestFix?: RoutePoint | null;
}): boolean {
  const detected = Date.parse(input.detectedAt);
  const decided = Date.parse(input.decidedAt);
  if (!Number.isFinite(input.geo.lat) || Math.abs(input.geo.lat) > 90
    || !Number.isFinite(input.geo.lng) || Math.abs(input.geo.lng) > 180
    || (input.geo.accuracy != null && (!Number.isFinite(input.geo.accuracy)
      || input.geo.accuracy < 0))) return false;
  if (!Number.isFinite(detected) || !Number.isFinite(decided)
    || decided < detected || decided - detected > EXPRESSWAY_PROMPT_MAX_AGE_MS) return false;
  if (input.events.some(event => {
    if (event.type !== 'rest_start' && event.type !== 'boarding') return false;
    const at = Date.parse(event.ts);
    return Number.isFinite(at) && at >= detected && at <= decided;
  })) return false;
  const fix = input.latestFix;
  const fixAt = fix ? Date.parse(fix.ts) : Number.NaN;
  const realFix = !!fix && fix.source !== 'event' && Number.isFinite(fixAt)
    && fixAt > detected && fixAt <= decided
    && Number.isFinite(fix.lat) && Math.abs(fix.lat) <= 90
    && Number.isFinite(fix.lng) && Math.abs(fix.lng) <= 180
    && (fix.accuracy == null || (fix.accuracy >= 0 && fix.accuracy <= 150));
  if (realFix && fix
    && distanceMeters(input.geo, { lat: fix.lat, lng: fix.lng })
      >= EXPRESSWAY_PROMPT_MOVE_METERS + Math.max(input.geo.accuracy ?? 0, fix.accuracy ?? 0)) {
    return false;
  }
  return true;
}
