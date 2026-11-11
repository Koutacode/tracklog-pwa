-- Read-only segment report for one closed trip.
-- Does not add columns or change rows. service_role only.

create or replace function public.tracklog_ops_closed_trip(_trip_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
set statement_timeout = '3s'
as $$
declare
  v_trip_id text := nullif(btrim(coalesce(_trip_id, '')), '');
  v_status text;
  v_started_at timestamptz;
  v_ended_at timestamptz;
  v_events jsonb := '[]'::jsonb;
begin
  if coalesce(auth.role(), '') is distinct from 'service_role' then
    raise exception 'tracklog_ops_closed_trip requires service_role' using errcode = '42501';
  end if;

  if v_trip_id is null
     or char_length(v_trip_id) > 200
     or v_trip_id ~ '[^A-Za-z0-9_.:-]'
     or left(v_trip_id, 1) !~ '^[A-Za-z0-9]' then
    raise exception 'invalid trip_id' using errcode = '22023';
  end if;

  select trip.status, trip.start_ts, trip.end_ts
    into v_status, v_started_at, v_ended_at
  from public.trip_headers trip
  where trip.trip_id = v_trip_id;

  if v_status is distinct from 'closed' then
    return jsonb_build_object('closed', false);
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

  return jsonb_build_object(
    'closed', true,
    'trip_id', v_trip_id,
    'trip_started_at', to_char(v_started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'trip_ended_at', case
      when v_ended_at is null then null
      else to_char(v_ended_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    end,
    'events', v_events
  );
end;
$$;

revoke all on function public.tracklog_ops_closed_trip(text) from public, anon, authenticated;
grant execute on function public.tracklog_ops_closed_trip(text) to service_role;

comment on function public.tracklog_ops_closed_trip(text) is
  'Read-only segment list for one closed trip. service_role only. Does not write.';
