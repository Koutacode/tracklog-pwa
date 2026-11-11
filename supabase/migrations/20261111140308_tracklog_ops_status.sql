-- Read-only status snapshot for the ops reader.
-- Executable only by service_role. The bearer token is not stored here;
-- the Edge Function compares a SHA-256 hash from TRACKLOG_OPS_STATUS_TOKEN_SHA256.
-- This function selects trip state fields and never writes.

create index if not exists idx_trip_headers_active_device
  on public.trip_headers (device_id, start_ts desc)
  where status = 'active';

create or replace function public.tracklog_ops_status(_device_id text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
set statement_timeout = '3s'
as $$
declare
  v_device_id text := nullif(btrim(coalesce(_device_id, '')), '');
  v_synced_at timestamptz := now();
  v_synced_iso text;
  v_count integer := 0;
  v_trip_id text;
  v_owner_device text;
  v_started_at timestamptz;
  v_seen_at timestamptz;
  v_lat double precision;
  v_lng double precision;
  v_events jsonb := '[]'::jsonb;
  v_geocode jsonb := null;
  v_result jsonb;
begin
  if coalesce(auth.role(), '') is distinct from 'service_role' then
    raise exception 'tracklog_ops_status requires service_role' using errcode = '42501';
  end if;

  if v_device_id is not null and (
    char_length(v_device_id) > 200
    or v_device_id ~ '[^A-Za-z0-9_.:-]'
    or left(v_device_id, 1) !~ '^[A-Za-z0-9]'
  ) then
    raise exception 'invalid device_id' using errcode = '22023';
  end if;

  v_synced_iso := to_char(v_synced_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  select count(*)::integer
    into v_count
  from public.trip_headers trip
  where trip.status = 'active'
    and (v_device_id is null or trip.device_id = v_device_id);

  if v_count = 0 then
    return jsonb_build_object(
      'trip_active', false,
      'synced_at', v_synced_iso,
      'stale', false
    );
  end if;

  if v_device_id is null and v_count > 1 then
    return jsonb_build_object(
      'trip_active', false,
      'selection_required', true,
      'active_count', v_count,
      'devices', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'device_id', trip.device_id,
            'display_name', profile.display_name,
            'vehicle_label', profile.vehicle_label
          )
          order by trip.start_ts, trip.device_id
        )
        from public.trip_headers trip
        join public.device_profiles profile on profile.device_id = trip.device_id
        where trip.status = 'active'
      ), '[]'::jsonb),
      'synced_at', v_synced_iso,
      'stale', false
    );
  end if;

  select
    trip.trip_id,
    trip.device_id,
    trip.start_ts,
    greatest(profile.last_seen_at, profile.latest_location_at),
    profile.latest_lat,
    profile.latest_lng
  into v_trip_id, v_owner_device, v_started_at, v_seen_at, v_lat, v_lng
  from public.trip_headers trip
  join public.device_profiles profile on profile.device_id = trip.device_id
  where trip.status = 'active'
    and (v_device_id is null or trip.device_id = v_device_id)
  order by trip.start_ts desc, trip.trip_id desc
  limit 1;

  if v_trip_id is null then
    return jsonb_build_object(
      'trip_active', false,
      'synced_at', v_synced_iso,
      'stale', false
    );
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', src.id,
        'type', src.type,
        'ts', to_char(src.ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'address', src.address,
        'ic_name', src.ic_name,
        'session_key', src.session_key,
        'session_id', case
          when src.session_key is null then null
          when jsonb_typeof(src.extras -> src.session_key) = 'string'
            then nullif(btrim(src.extras ->> src.session_key), '')
          else null
        end,
        'auto_reason', case
          when jsonb_typeof(src.extras -> 'autoReason') = 'string'
            then nullif(btrim(src.extras ->> 'autoReason'), '')
          else null
        end
      )
      order by src.ts, src.id
    ),
    '[]'::jsonb
  )
  into v_events
  from (
    select
      event.id,
      event.type,
      event.ts,
      left(nullif(btrim(event.address), ''), 500) as address,
      event.extras,
      case
        when jsonb_typeof(event.extras -> 'icName') = 'string'
          then nullif(btrim(event.extras ->> 'icName'), '')
        else null
      end as ic_name,
      case event.type
        when 'rest_start' then 'restSessionId'
        when 'rest_end' then 'restSessionId'
        when 'break_start' then 'breakSessionId'
        when 'break_end' then 'breakSessionId'
        when 'load_start' then 'loadSessionId'
        when 'load_end' then 'loadSessionId'
        when 'unload_start' then 'unloadSessionId'
        when 'unload_end' then 'unloadSessionId'
        when 'boarding' then 'ferrySessionId'
        when 'disembark' then 'ferrySessionId'
        when 'work_start' then 'workSessionId'
        when 'work_end' then 'workSessionId'
        when 'expressway_start' then 'expresswaySessionId'
        when 'expressway_end' then 'expresswaySessionId'
        when 'wait_start' then 'waitSessionId'
        when 'wait_end' then 'waitSessionId'
        when 'drive_start' then 'driveSessionId'
        when 'drive_end' then 'driveSessionId'
        else null
      end as session_key
    from public.trip_events event
    where event.trip_id = v_trip_id
  ) src;

  if v_lat is not null and v_lng is not null
     and v_lat = v_lat and v_lng = v_lng
     and v_lat between -90 and 90
     and v_lng between -180 and 180 then
    v_geocode := jsonb_build_object('lat', v_lat, 'lng', v_lng);
  end if;

  v_result := jsonb_build_object(
    'trip_active', true,
    'trip_id', v_trip_id,
    'device_id', v_owner_device,
    'trip_started_at', to_char(v_started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'seen_at', case
      when v_seen_at is null then null
      else to_char(v_seen_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    end,
    'stale', v_seen_at is null or v_seen_at < v_synced_at - interval '15 minutes',
    'events', v_events,
    'synced_at', v_synced_iso
  );

  if v_geocode is not null then
    v_result := v_result || jsonb_build_object('_reverse_geocode', v_geocode);
  end if;

  return v_result;
end;
$$;

revoke all on function public.tracklog_ops_status(text) from public, anon, authenticated;
grant execute on function public.tracklog_ops_status(text) to service_role;

comment on function public.tracklog_ops_status(text) is
  'Read-only ops snapshot of the active trip. service_role only. Does not write.';
