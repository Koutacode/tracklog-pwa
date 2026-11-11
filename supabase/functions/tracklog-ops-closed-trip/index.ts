import { createClient } from 'npm:@supabase/supabase-js@2.58.0';
import { handleClosedTrip } from './handler.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const tokenHash = Deno.env.get('TRACKLOG_OPS_STATUS_TOKEN_SHA256');

const adminClient = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  : null;

Deno.serve((request: Request) => handleClosedTrip(request, {
  tokenHash,
  databaseConfigured: adminClient !== null,
  callClosedTrip: async tripId => {
    if (!adminClient) throw new Error('database_not_configured');
    const { data, error } = await adminClient.rpc('tracklog_ops_closed_trip', { _trip_id: tripId });
    if (error) {
      console.error('[tracklog-ops-closed-trip] rpc_failed', error.code ?? '');
      throw new Error('rpc_failed');
    }
    return data;
  },
  callClosedDay: async date => {
    if (!adminClient) throw new Error('database_not_configured');
    const { data, error } = await adminClient.rpc('tracklog_ops_closed_day', { _day: date });
    if (error) {
      console.error('[tracklog-ops-closed-trip] day_rpc_failed', error.code ?? '');
      throw new Error('rpc_failed');
    }
    return data;
  },
}));
