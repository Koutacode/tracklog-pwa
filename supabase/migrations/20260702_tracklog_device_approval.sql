alter table public.device_profiles
  add column if not exists approval_status text,
  add column if not exists approval_requested_at timestamptz,
  add column if not exists approval_decided_at timestamptz,
  add column if not exists approval_decided_by uuid;

update public.device_profiles
   set approval_status = 'approved',
       approval_requested_at = coalesce(approval_requested_at, created_at, now()),
       approval_decided_at = coalesce(approval_decided_at, updated_at, now())
 where approval_status is null;

alter table public.device_profiles
  alter column approval_status set default 'pending',
  alter column approval_status set not null,
  alter column approval_requested_at set default now();

do $$
begin
  alter table public.device_profiles
    add constraint device_profiles_approval_status_check
    check (approval_status in ('pending', 'approved', 'rejected'));
exception
  when duplicate_object then null;
end;
$$;

create index if not exists idx_device_profiles_approval_status
  on public.device_profiles (approval_status, approval_requested_at desc);

create or replace function public.is_tracklog_account_approved(target_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.device_profiles profile
     where profile.auth_user_id = target_user_id
       and profile.approval_status = 'approved'
  );
$$;

create or replace function public.is_tracklog_device_approved(target_device_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.device_profiles profile
     where profile.device_id = target_device_id
       and profile.approval_status = 'approved'
       and profile.auth_user_id = auth.uid()
  );
$$;

drop function if exists public.claim_tracklog_device_profile(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  double precision,
  double precision,
  double precision,
  timestamptz
);

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
  account_is_approved boolean;
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

  account_is_approved := public.is_tracklog_account_approved(auth.uid());

  next_approval_status := coalesce(
    existing_profile.approval_status,
    case when account_is_approved then 'approved' else 'pending' end
  );
  next_approval_requested_at := coalesce(existing_profile.approval_requested_at, now());
  next_approval_decided_at := case
    when existing_profile.approval_status is not null then existing_profile.approval_decided_at
    when account_is_approved then now()
    else null
  end;
  next_approval_decided_by := case
    when existing_profile.approval_status is not null then existing_profile.approval_decided_by
    else null
  end;

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

create or replace function public.set_tracklog_device_approval(
  _device_id text,
  _approval_status text
)
returns setof public.device_profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_profile public.device_profiles;
  normalized_status text := lower(nullif(trim(_approval_status), ''));
begin
  if not public.is_tracklog_admin() then
    raise exception 'Access denied. Admin privileges required.' using errcode = '42501';
  end if;

  if normalized_status not in ('approved', 'rejected') then
    raise exception 'approval_status must be approved or rejected' using errcode = '22023';
  end if;

  update public.device_profiles
     set approval_status = normalized_status,
         approval_decided_at = now(),
         approval_decided_by = auth.uid()
   where device_id = _device_id
  returning * into updated_profile;

  if updated_profile.device_id is null then
    raise exception 'device profile not found' using errcode = '02000';
  end if;

  return query select updated_profile.*;
end;
$$;

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
begin
  if auth.uid() is null then
    raise exception 'auth session is required';
  end if;

  if _old_device_id is null or _new_device_id is null or _old_device_id = _new_device_id then
    return;
  end if;

  select * into old_profile from public.device_profiles where device_id = _old_device_id;
  if old_profile.device_id is null then
    return;
  end if;

  select * into new_profile from public.device_profiles where device_id = _new_device_id;
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

drop policy if exists device_profiles_insert on public.device_profiles;
create policy device_profiles_insert on public.device_profiles
for insert to authenticated
with check ((select auth.uid()) = auth_user_id and approval_status = 'pending');

drop policy if exists device_profiles_update on public.device_profiles;
create policy device_profiles_update on public.device_profiles
for update to authenticated
using (public.is_tracklog_admin())
with check (public.is_tracklog_admin());

drop policy if exists trip_headers_select on public.trip_headers;
create policy trip_headers_select on public.trip_headers
for select to authenticated
using ((public.owns_tracklog_device(device_id) and public.is_tracklog_account_approved()) or public.is_tracklog_admin());

drop policy if exists trip_headers_insert on public.trip_headers;
create policy trip_headers_insert on public.trip_headers
for insert to authenticated
with check (public.owns_tracklog_device(device_id) and public.is_tracklog_account_approved());

drop policy if exists trip_headers_update on public.trip_headers;
create policy trip_headers_update on public.trip_headers
for update to authenticated
using (public.owns_tracklog_device(device_id) and public.is_tracklog_account_approved())
with check (public.owns_tracklog_device(device_id) and public.is_tracklog_account_approved());

drop policy if exists trip_events_select on public.trip_events;
create policy trip_events_select on public.trip_events
for select to authenticated
using ((public.owns_tracklog_device(device_id) and public.is_tracklog_account_approved()) or public.is_tracklog_admin());

drop policy if exists trip_events_insert on public.trip_events;
create policy trip_events_insert on public.trip_events
for insert to authenticated
with check (public.owns_tracklog_device(device_id) and public.is_tracklog_account_approved());

drop policy if exists trip_events_update on public.trip_events;
create policy trip_events_update on public.trip_events
for update to authenticated
using (public.owns_tracklog_device(device_id) and public.is_tracklog_account_approved())
with check (public.owns_tracklog_device(device_id) and public.is_tracklog_account_approved());

drop policy if exists trip_route_points_select on public.trip_route_points;
create policy trip_route_points_select on public.trip_route_points
for select to authenticated
using ((public.owns_tracklog_device(device_id) and public.is_tracklog_account_approved()) or public.is_tracklog_admin());

drop policy if exists trip_route_points_insert on public.trip_route_points;
create policy trip_route_points_insert on public.trip_route_points
for insert to authenticated
with check (public.owns_tracklog_device(device_id) and public.is_tracklog_account_approved());

drop policy if exists trip_route_points_update on public.trip_route_points;
create policy trip_route_points_update on public.trip_route_points
for update to authenticated
using (public.owns_tracklog_device(device_id) and public.is_tracklog_account_approved())
with check (public.owns_tracklog_device(device_id) and public.is_tracklog_account_approved());

drop policy if exists report_snapshots_select on public.report_snapshots;
create policy report_snapshots_select on public.report_snapshots
for select to authenticated
using ((public.owns_tracklog_device(device_id) and public.is_tracklog_account_approved()) or public.is_tracklog_admin());

drop policy if exists report_snapshots_insert on public.report_snapshots;
create policy report_snapshots_insert on public.report_snapshots
for insert to authenticated
with check (public.owns_tracklog_device(device_id) and public.is_tracklog_account_approved());

drop policy if exists report_snapshots_update on public.report_snapshots;
create policy report_snapshots_update on public.report_snapshots
for update to authenticated
using (public.owns_tracklog_device(device_id) and public.is_tracklog_account_approved())
with check (public.owns_tracklog_device(device_id) and public.is_tracklog_account_approved());

revoke execute on function public.claim_tracklog_device_profile(text,text,text,text,text,text,text,text,text,double precision,double precision,double precision,timestamptz) from public;
revoke execute on function public.claim_tracklog_device_profile(text,text,text,text,text,text,text,text,text,double precision,double precision,double precision,timestamptz) from anon;
grant execute on function public.claim_tracklog_device_profile(text,text,text,text,text,text,text,text,text,double precision,double precision,double precision,timestamptz) to authenticated;

revoke execute on function public.set_tracklog_device_approval(text,text) from public;
revoke execute on function public.set_tracklog_device_approval(text,text) from anon;
grant execute on function public.set_tracklog_device_approval(text,text) to authenticated;

grant select, insert, update on table public.device_profiles to authenticated;
grant select, insert, update on table public.trip_headers to authenticated;
grant select, insert, update on table public.trip_events to authenticated;
grant select, insert, update on table public.trip_route_points to authenticated;
grant select, insert, update on table public.report_snapshots to authenticated;
