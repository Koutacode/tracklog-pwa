import { createClient } from 'npm:@supabase/supabase-js@2.58.0';
import { handleOpsStatus } from './handler.ts';
import { reverseGeocodeMunicipality } from './geocode.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const tokenHash = Deno.env.get('TRACKLOG_OPS_STATUS_TOKEN_SHA256');

const adminClient = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  : null;

Deno.serve((request: Request) => handleOpsStatus(request, {
  tokenHash,
  databaseConfigured: adminClient !== null,
  callStatus: async deviceId => {
    if (!adminClient) throw new Error('database_not_configured');
    const { data, error } = await adminClient.rpc('tracklog_ops_status', { _device_id: deviceId });
    if (error) {
      console.error('[tracklog-ops-status] rpc_failed', error.code ?? '');
      throw new Error('rpc_failed');
    }
    return data;
  },
  reverseGeocode: (lat, lng) => reverseGeocodeMunicipality(lat, lng),
}));
