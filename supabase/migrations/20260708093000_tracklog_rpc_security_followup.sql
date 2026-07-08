-- Follow-up hardening for SECURITY DEFINER RPCs exposed through PostgREST.
-- Keep app-facing sync paths intact while preventing cross-account migration and
-- regular user-triggered global retention pruning.

create or replace function public.migrate_tracklog_device_records(
  _old_device_id text,
  _new_device_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  old_profile public.device_profiles;
  new_profile public.device_profiles;
  next_approval_status text;
  next_approval_decided_at timestamptz;
  next_approval_decided_by uuid;
  v_is_admin boolean := public.is_tracklog_admin();
begin
  if auth.uid() is null then
    raise exception 'auth session is required' using errcode = '42501';
  end if;

  if _old_device_id is null or _new_device_id is null or _old_device_id = _new_device_id then
    return;
  end if;

  select * into old_profile
    from public.device_profiles
   where device_id = _old_device_id
   for update;

  if old_profile.device_id is null then
    return;
  end if;

  if old_profile.auth_user_id is not null
     and old_profile.auth_user_id <> auth.uid()
     and not v_is_admin then
    raise exception 'old device profile is assigned to another account' using errcode = '42501';
  end if;

  select * into new_profile
    from public.device_profiles
   where device_id = _new_device_id
   for update;

  if new_profile.device_id is not null
     and new_profile.auth_user_id is not null
     and new_profile.auth_user_id <> auth.uid()
     and not v_is_admin then
    raise exception 'new device profile is assigned to another account' using errcode = '42501';
  end if;

  next_approval_status := case
    when new_profile.approval_status = 'approved' or old_profile.approval_status = 'approved' then 'approved'
    when new_profile.approval_status = 'rejected' then 'rejected'
    else coalesce(old_profile.approval_status, new_profile.approval_status, 'pending')
  end;
  next_approval_decided_at := coalesce(new_profile.approval_decided_at, old_profile.approval_decided_at);
  next_approval_decided_by := coalesce(new_profile.approval_decided_by, old_profile.approval_decided_by);

  if new_profile.device_id is null then
    insert into public.device_profiles (
      device_id,
      auth_user_id,
      display_name,
      vehicle_label,
      driver_phone,
      driver_email,
      platform,
      app_version,
      latest_status,
      latest_trip_id,
      latest_lat,
      latest_lng,
      latest_accuracy,
      last_seen_at,
      approval_status,
      approval_requested_at,
      approval_decided_at,
      approval_decided_by
    )
    values (
      _new_device_id,
      auth.uid(),
      old_profile.display_name,
      old_profile.vehicle_label,
      old_profile.driver_phone,
      old_profile.driver_email,
      old_profile.platform,
      old_profile.app_version,
      old_profile.latest_status,
      old_profile.latest_trip_id,
      old_profile.latest_lat,
      old_profile.latest_lng,
      old_profile.latest_accuracy,
      coalesce(old_profile.last_seen_at, now()),
      next_approval_status,
      coalesce(old_profile.approval_requested_at, now()),
      next_approval_decided_at,
      next_approval_decided_by
    );
  else
    update public.device_profiles
       set auth_user_id = auth.uid(),
           display_name = coalesce(new_profile.display_name, old_profile.display_name),
           vehicle_label = coalesce(new_profile.vehicle_label, old_profile.vehicle_label),
           driver_phone = coalesce(new_profile.driver_phone, old_profile.driver_phone),
           driver_email = coalesce(new_profile.driver_email, old_profile.driver_email),
           latest_status = coalesce(new_profile.latest_status, old_profile.latest_status),
           latest_trip_id = coalesce(new_profile.latest_trip_id, old_profile.latest_trip_id),
           latest_lat = coalesce(new_profile.latest_lat, old_profile.latest_lat),
           latest_lng = coalesce(new_profile.latest_lng, old_profile.latest_lng),
           latest_accuracy = coalesce(new_profile.latest_accuracy, old_profile.latest_accuracy),
           last_seen_at = greatest(coalesce(new_profile.last_seen_at, now()), coalesce(old_profile.last_seen_at, now())),
           approval_status = next_approval_status,
           approval_requested_at = coalesce(new_profile.approval_requested_at, old_profile.approval_requested_at, now()),
           approval_decided_at = next_approval_decided_at,
           approval_decided_by = next_approval_decided_by
     where device_id = _new_device_id;
  end if;

  update public.trip_headers set device_id = _new_device_id where device_id = _old_device_id;
  update public.trip_events set device_id = _new_device_id where device_id = _old_device_id;
  update public.trip_route_points set device_id = _new_device_id where device_id = _old_device_id;
  update public.report_snapshots set device_id = _new_device_id where device_id = _old_device_id;
  delete from public.device_profiles where device_id = _old_device_id;
end;
$$;

revoke execute on function public.migrate_tracklog_device_records(text, text) from public, anon;
grant execute on function public.migrate_tracklog_device_records(text, text) to authenticated;

revoke all on function public.prune_tracklog_cloud_usage() from public;
revoke execute on function public.prune_tracklog_cloud_usage() from anon;
revoke execute on function public.prune_tracklog_cloud_usage() from authenticated;
grant execute on function public.prune_tracklog_cloud_usage() to service_role;
