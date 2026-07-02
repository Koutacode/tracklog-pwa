create or replace function public.claim_tracklog_device_profile(
  _device_id text,
  _display_name text default null,
  _vehicle_label text default null,
  _driver_phone text default null,
  _driver_email text default null,
  _platform text default null,
  _app_version text default null,
  _latest_status text default null,
  _latest_trip_id text default null,
  _latest_lat double precision default null,
  _latest_lng double precision default null,
  _latest_accuracy double precision default null,
  _last_seen_at timestamptz default now()
)
returns setof public.device_profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_profile public.device_profiles;
  claimed_profile public.device_profiles;
  resolved_display_name text;
  resolved_vehicle_label text;
  resolved_driver_phone text;
  resolved_driver_email text;
  next_approval_status text;
  next_approval_requested_at timestamptz;
  next_approval_decided_at timestamptz;
  next_approval_decided_by uuid;
begin
  if auth.uid() is null then
    raise exception 'auth session is required';
  end if;

  if nullif(trim(_device_id), '') is null then
    raise exception 'device_id is required';
  end if;

  select *
    into existing_profile
    from public.device_profiles
   where device_id = _device_id
   for update;

  if existing_profile.device_id is not null
     and existing_profile.auth_user_id is not null
     and existing_profile.auth_user_id <> auth.uid()
     and not public.is_tracklog_admin() then
    raise exception 'device profile is already assigned to another account' using errcode = '42501';
  end if;

  next_approval_status := coalesce(existing_profile.approval_status, 'pending');
  next_approval_requested_at := coalesce(existing_profile.approval_requested_at, now());
  next_approval_decided_at := existing_profile.approval_decided_at;
  next_approval_decided_by := existing_profile.approval_decided_by;

  resolved_display_name := coalesce(
    nullif(trim(_display_name), ''),
    existing_profile.display_name,
    '端末-' || right(regexp_replace(_device_id, '[^a-zA-Z0-9]', '', 'g'), 8)
  );

  resolved_vehicle_label := coalesce(
    nullif(trim(_vehicle_label), ''),
    existing_profile.vehicle_label
  );

  resolved_driver_phone := coalesce(
    nullif(trim(_driver_phone), ''),
    existing_profile.driver_phone
  );

  resolved_driver_email := coalesce(
    nullif(trim(_driver_email), ''),
    existing_profile.driver_email
  );

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
    _device_id,
    auth.uid(),
    resolved_display_name,
    resolved_vehicle_label,
    resolved_driver_phone,
    resolved_driver_email,
    coalesce(nullif(trim(_platform), ''), existing_profile.platform, 'unknown'),
    coalesce(nullif(trim(_app_version), ''), existing_profile.app_version),
    coalesce(nullif(trim(_latest_status), ''), existing_profile.latest_status),
    coalesce(nullif(trim(_latest_trip_id), ''), existing_profile.latest_trip_id),
    coalesce(_latest_lat, existing_profile.latest_lat),
    coalesce(_latest_lng, existing_profile.latest_lng),
    coalesce(_latest_accuracy, existing_profile.latest_accuracy),
    coalesce(_last_seen_at, now()),
    next_approval_status,
    next_approval_requested_at,
    next_approval_decided_at,
    next_approval_decided_by
  )
  on conflict (device_id) do update
    set auth_user_id = auth.uid(),
        display_name = excluded.display_name,
        vehicle_label = excluded.vehicle_label,
        driver_phone = excluded.driver_phone,
        driver_email = excluded.driver_email,
        platform = excluded.platform,
        app_version = excluded.app_version,
        latest_status = excluded.latest_status,
        latest_trip_id = excluded.latest_trip_id,
        latest_lat = excluded.latest_lat,
        latest_lng = excluded.latest_lng,
        latest_accuracy = excluded.latest_accuracy,
        last_seen_at = excluded.last_seen_at,
        approval_status = next_approval_status,
        approval_requested_at = next_approval_requested_at,
        approval_decided_at = next_approval_decided_at,
        approval_decided_by = next_approval_decided_by
  returning * into claimed_profile;

  return query select claimed_profile.*;
end;
$$;

drop policy if exists trip_headers_select on public.trip_headers;
create policy trip_headers_select on public.trip_headers
for select to authenticated
using ((public.owns_tracklog_device(device_id) and public.is_tracklog_device_approved(device_id)) or public.is_tracklog_admin());

drop policy if exists trip_headers_insert on public.trip_headers;
create policy trip_headers_insert on public.trip_headers
for insert to authenticated
with check (public.owns_tracklog_device(device_id) and public.is_tracklog_device_approved(device_id));

drop policy if exists trip_headers_update on public.trip_headers;
create policy trip_headers_update on public.trip_headers
for update to authenticated
using (public.owns_tracklog_device(device_id) and public.is_tracklog_device_approved(device_id))
with check (public.owns_tracklog_device(device_id) and public.is_tracklog_device_approved(device_id));

drop policy if exists trip_events_select on public.trip_events;
create policy trip_events_select on public.trip_events
for select to authenticated
using ((public.owns_tracklog_device(device_id) and public.is_tracklog_device_approved(device_id)) or public.is_tracklog_admin());

drop policy if exists trip_events_insert on public.trip_events;
create policy trip_events_insert on public.trip_events
for insert to authenticated
with check (public.owns_tracklog_device(device_id) and public.is_tracklog_device_approved(device_id));

drop policy if exists trip_events_update on public.trip_events;
create policy trip_events_update on public.trip_events
for update to authenticated
using (public.owns_tracklog_device(device_id) and public.is_tracklog_device_approved(device_id))
with check (public.owns_tracklog_device(device_id) and public.is_tracklog_device_approved(device_id));

drop policy if exists trip_route_points_select on public.trip_route_points;
create policy trip_route_points_select on public.trip_route_points
for select to authenticated
using ((public.owns_tracklog_device(device_id) and public.is_tracklog_device_approved(device_id)) or public.is_tracklog_admin());

drop policy if exists trip_route_points_insert on public.trip_route_points;
create policy trip_route_points_insert on public.trip_route_points
for insert to authenticated
with check (public.owns_tracklog_device(device_id) and public.is_tracklog_device_approved(device_id));

drop policy if exists trip_route_points_update on public.trip_route_points;
create policy trip_route_points_update on public.trip_route_points
for update to authenticated
using (public.owns_tracklog_device(device_id) and public.is_tracklog_device_approved(device_id))
with check (public.owns_tracklog_device(device_id) and public.is_tracklog_device_approved(device_id));

drop policy if exists report_snapshots_select on public.report_snapshots;
create policy report_snapshots_select on public.report_snapshots
for select to authenticated
using ((public.owns_tracklog_device(device_id) and public.is_tracklog_device_approved(device_id)) or public.is_tracklog_admin());

drop policy if exists report_snapshots_insert on public.report_snapshots;
create policy report_snapshots_insert on public.report_snapshots
for insert to authenticated
with check (public.owns_tracklog_device(device_id) and public.is_tracklog_device_approved(device_id));

drop policy if exists report_snapshots_update on public.report_snapshots;
create policy report_snapshots_update on public.report_snapshots
for update to authenticated
using (public.owns_tracklog_device(device_id) and public.is_tracklog_device_approved(device_id))
with check (public.owns_tracklog_device(device_id) and public.is_tracklog_device_approved(device_id));
