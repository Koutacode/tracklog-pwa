import { createClient } from '@supabase/supabase-js';

/** Sends a caller-validated token without reading or refreshing a stored session. */
export function createTracklogExplicitTokenClient(
  url: string,
  apiKey: string,
  fetchImpl?: typeof fetch,
) {
  return createClient(url, apiKey, {
    // fetchWithAuth obtains a token even when Authorization is already supplied.
    // No Auth session owner is created for these explicit-token requests.
    accessToken: async () => null,
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
  });
}

const url = (import.meta.env?.VITE_SUPABASE_URL ?? '').trim();
const apiKey = (import.meta.env?.VITE_SUPABASE_ANON_KEY ?? '').trim();
export const tracklogExplicitTokenClient = url && apiKey
  ? createTracklogExplicitTokenClient(url, apiKey)
  : null;
