-- Reduce sync-v2 work without changing mutation, receipt, cursor or auth semantics.
-- No index/data deletion and no retention policy is introduced.
-- Device last-seen/sync timestamps are refreshed at most once per minute by
-- this RPC; first sync and protocol upgrades still update immediately.

create or replace function public.tracklog_sync_v2(
  _owner_user_id uuid,
  _device_id text,
  _cursor bigint,
  _mutations jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, tracklog_private
as $$
declare
  v_owner_head bigint;
  v_mutation jsonb;
  v_mutation_id_text text;
  v_mutation_id uuid;
  v_entity_type text;
  v_entity_id text;
  v_ack jsonb;
  v_receipt jsonb;
  v_acks jsonb := '[]'::jsonb;
  v_trips jsonb;
  v_events jsonb;
  v_route_points jsonb;
  v_reports jsonb;
  v_deleted_trips jsonb;
  v_deleted_events jsonb;
  v_deleted_reports jsonb;
  v_next_cursor bigint;
  v_has_more boolean;
begin
  if _owner_user_id is null then
    raise exception 'owner_user_id is required' using errcode = '22023';
  end if;
  if nullif(btrim(_device_id), '') is null or length(_device_id) > 180 then
    raise exception 'device_id is invalid' using errcode = '22023';
  end if;
  if _cursor is null or _cursor < 0 then
    raise exception 'cursor must be a non-negative integer' using errcode = '22023';
  end if;
  if _mutations is null or jsonb_typeof(_mutations) <> 'array' then
    raise exception 'mutations must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(_mutations) > 420 then
    raise exception 'at most 420 mutations are allowed' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.device_profiles profile
    where profile.device_id = _device_id
      and profile.auth_user_id = _owner_user_id
      and profile.approval_status = 'approved'
  ) then
    raise exception 'approved device is required' using errcode = '42501';
  end if;

  insert into public.tracklog_sync_counters (owner_user_id, last_change_seq)
  values (_owner_user_id, 0)
  on conflict (owner_user_id) do nothing;

  -- Held until the RPC transaction commits. All v1/v2 writers for this owner
  -- acquire this same row through the BEFORE trigger.
  select counter.last_change_seq
  into v_owner_head
  from public.tracklog_sync_counters counter
  where counter.owner_user_id = _owner_user_id
  for update;

  if _cursor > v_owner_head then
    raise exception 'cursor is ahead of the owner change feed' using errcode = '22023';
  end if;

  for v_mutation in
    select item.value
    from jsonb_array_elements(_mutations) with ordinality item(value, position)
    order by item.position
  loop
    v_mutation_id_text := coalesce(v_mutation ->> 'mutationId', '');
    v_entity_type := coalesce(v_mutation ->> 'entityType', '');
    v_entity_id := btrim(coalesce(v_mutation ->> 'entityId', ''));
    v_ack := jsonb_build_object(
      'mutationId', v_mutation_id_text,
      'entityType', v_entity_type,
      'entityId', v_entity_id
    );

    if v_mutation_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      v_ack := v_ack || jsonb_build_object(
        'status', 'rejected',
        'message', 'mutationId must be a UUID'
      );
      v_acks := v_acks || jsonb_build_array(v_ack);
      continue;
    end if;

    begin
      v_mutation_id := v_mutation_id_text::uuid;
    exception
      when invalid_text_representation then
        v_ack := v_ack || jsonb_build_object(
          'status', 'rejected',
          'message', 'mutationId must be a UUID'
        );
        v_acks := v_acks || jsonb_build_array(v_ack);
        continue;
    end;

    select receipt.response_json
    into v_receipt
    from public.tracklog_sync_mutations receipt
    where receipt.owner_user_id = _owner_user_id
      and receipt.mutation_id = v_mutation_id;

    if found then
      v_ack := v_receipt || jsonb_build_object('status', 'duplicate');
      v_acks := v_acks || jsonb_build_array(v_ack);
      continue;
    end if;

    v_ack := tracklog_private.apply_tracklog_sync_mutation(
      _owner_user_id,
      _device_id,
      v_mutation
    );

    if v_ack ->> 'status' = 'conflict' and not (v_ack ? 'code') then
      v_ack := v_ack || jsonb_build_object(
        'code',
        case v_ack ->> 'message'
          when 'A newer cloud revision already exists' then 'revision_conflict'
          when 'Report was invalidated by a newer change' then 'report_tombstone_conflict'
          when 'Another active trip already exists' then 'active_trip_conflict'
          when 'Cloud trip no longer exists' then 'entity_deleted'
          when 'Cloud event no longer exists' then 'entity_deleted'
          when 'Cloud route point no longer exists' then 'entity_deleted'
          when 'Cloud report no longer exists' then 'entity_deleted'
          when 'Trip header is missing or belongs to another account' then 'missing_parent'
          else 'conflict'
        end
      );
    end if;

    -- A conflict is deliberately not receipted. Explicit deletes may retry
    -- after rebasing, while upserts either accept currentRow or retry only
    -- when a newer local mutation replaced the request snapshot.
    if v_ack ->> 'status' in ('applied', 'deleted') then
      insert into public.tracklog_sync_mutations (
        owner_user_id,
        mutation_id,
        device_id,
        entity_type,
        entity_id,
        response_json
      ) values (
        _owner_user_id,
        v_mutation_id,
        _device_id,
        v_entity_type,
        v_entity_id,
        v_ack
      );
    end if;

    v_acks := v_acks || jsonb_build_array(v_ack);
  end loop;

  update public.device_profiles
  set sync_protocol_version = 2,
      last_sync_v2_at = clock_timestamp(),
      last_seen_at = clock_timestamp()
  where device_id = _device_id
    and auth_user_id = _owner_user_id
    and (
      sync_protocol_version is distinct from 2
      or last_sync_v2_at is null
      or last_sync_v2_at <= clock_timestamp() - interval '60 seconds'
    );

  -- Each branch contributes at most 1501 rows to the global 1501-row page.
  -- Per-owner change_seq is strictly increasing under the existing counter
  -- lock, so rows after a branch's first 1501 cannot enter the global page.
  -- Apply the limit before to_jsonb and use the existing owner/change index.
  with all_changes as (
    select trip.change_seq, 'trips'::text bucket, trip.trip_id entity_id, to_jsonb(trip) row_data
    from (
      select * from public.trip_headers
      where owner_user_id = _owner_user_id and change_seq > _cursor
      order by change_seq
      limit 1501
    ) trip
    union all
    select event.change_seq, 'events', event.id, to_jsonb(event)
    from (
      select * from public.trip_events
      where owner_user_id = _owner_user_id and change_seq > _cursor
      order by change_seq
      limit 1501
    ) event
    union all
    select point.change_seq, 'routePoints', point.id, to_jsonb(point)
    from (
      select * from public.trip_route_points
      where owner_user_id = _owner_user_id and change_seq > _cursor
      order by change_seq
      limit 1501
    ) point
    union all
    select report.change_seq, 'reports', report.trip_id, to_jsonb(report)
    from (
      select * from public.report_snapshots
      where owner_user_id = _owner_user_id and change_seq > _cursor
      order by change_seq
      limit 1501
    ) report
    union all
    select tombstone.change_seq, 'deletedTrips', tombstone.trip_id, to_jsonb(tombstone)
    from (
      select * from public.deleted_trip_tombstones
      where owner_user_id = _owner_user_id and change_seq > _cursor
      order by change_seq
      limit 1501
    ) tombstone
    union all
    select tombstone.change_seq, 'deletedEvents', tombstone.event_id, to_jsonb(tombstone)
    from (
      select * from public.deleted_event_tombstones
      where owner_user_id = _owner_user_id and change_seq > _cursor
      order by change_seq
      limit 1501
    ) tombstone
    union all
    select tombstone.change_seq, 'deletedReports', tombstone.trip_id, to_jsonb(tombstone)
    from (
      select * from public.deleted_report_tombstones
      where owner_user_id = _owner_user_id and change_seq > _cursor
      order by change_seq
      limit 1501
    ) tombstone
  ), page as (
    select change_seq, bucket, entity_id, row_data
    from all_changes
    order by change_seq, bucket, entity_id
    limit 1501
  ), selected as (
    select change_seq, bucket, entity_id, row_data
    from page
    order by change_seq, bucket, entity_id
    limit 1500
  )
  select
    coalesce(jsonb_agg(row_data order by change_seq) filter (where bucket = 'trips'), '[]'::jsonb),
    coalesce(jsonb_agg(row_data order by change_seq) filter (where bucket = 'events'), '[]'::jsonb),
    coalesce(jsonb_agg(row_data order by change_seq) filter (where bucket = 'routePoints'), '[]'::jsonb),
    coalesce(jsonb_agg(row_data order by change_seq) filter (where bucket = 'reports'), '[]'::jsonb),
    coalesce(jsonb_agg(row_data order by change_seq) filter (where bucket = 'deletedTrips'), '[]'::jsonb),
    coalesce(jsonb_agg(row_data order by change_seq) filter (where bucket = 'deletedEvents'), '[]'::jsonb),
    coalesce(jsonb_agg(row_data order by change_seq) filter (where bucket = 'deletedReports'), '[]'::jsonb),
    coalesce(max(change_seq), _cursor),
    (select count(*) > 1500 from page)
  into
    v_trips,
    v_events,
    v_route_points,
    v_reports,
    v_deleted_trips,
    v_deleted_events,
    v_deleted_reports,
    v_next_cursor,
    v_has_more
  from selected;

  if not v_has_more then
    select counter.last_change_seq
    into v_owner_head
    from public.tracklog_sync_counters counter
    where counter.owner_user_id = _owner_user_id;
    v_next_cursor := greatest(v_next_cursor, v_owner_head);
  end if;

  return jsonb_build_object(
    'ok', true,
    'data', jsonb_build_object(
      'protocolVersion', 2,
      'cursor', v_next_cursor,
      'hasMore', v_has_more,
      'acks', v_acks,
      'changes', jsonb_build_object(
        'trips', v_trips,
        'events', v_events,
        'routePoints', v_route_points,
        'reports', v_reports,
        'deletedTrips', v_deleted_trips,
        'deletedEvents', v_deleted_events,
        'deletedReports', v_deleted_reports
      )
    )
  );
end;
$$;

revoke all on function public.tracklog_sync_v2(uuid, text, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.tracklog_sync_v2(uuid, text, bigint, jsonb) to service_role;

notify pgrst, 'reload schema';
