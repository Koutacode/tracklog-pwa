import { createClient } from '@supabase/supabase-js';

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL ?? '').trim();
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim();

export const SUPABASE_CONFIGURED = !!supabaseUrl && !!supabaseAnonKey;
export const DEFAULT_ADMIN_EMAIL = (import.meta.env.VITE_TRACKLOG_ADMIN_EMAIL ?? 'matumurak0623@gmail.com').trim();

function buildClient(storageKey: string) {
  if (!SUPABASE_CONFIGURED) return null;
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      storageKey,
    },
  });
}

export const driverSupabase = buildClient('tracklog-driver-auth');
export const adminSupabase = buildClient('tracklog-admin-auth');

