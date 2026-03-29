create or replace function public.drop_fk_if_exists(target_table regclass, target_column text)
returns void
language plpgsql
as $$
declare
  constraint_name text;
begin
  select c.conname
    into constraint_name
    from pg_constraint c
    join pg_attribute a
      on a.attrelid = c.conrelid
     and a.attnum = any (c.conkey)
   where c.conrelid = target_table
     and c.contype = 'f'
     and a.attname = target_column
   limit 1;

  if constraint_name is not null then
    execute format('alter table %s drop constraint %I', target_table, constraint_name);
  end if;
end;
$$;

drop policy if exists device_profiles_select on public.device_profiles;
drop policy if exists device_profiles_insert on public.device_profiles;
drop policy if exists device_profiles_update on public.device_profiles;
drop policy if exists trip_headers_select on public.trip_headers;
drop policy if exists trip_headers_insert on public.trip_headers;
drop policy if exists trip_headers_update on public.trip_headers;
drop policy if exists trip_events_select on public.trip_events;
drop policy if exists trip_events_insert on public.trip_events;
drop policy if exists trip_events_update on public.trip_events;
drop policy if exists trip_route_points_select on public.trip_route_points;
drop policy if exists trip_route_points_insert on public.trip_route_points;
drop policy if exists trip_route_points_update on public.trip_route_points;
drop policy if exists report_snapshots_select on public.report_snapshots;
drop policy if exists report_snapshots_insert on public.report_snapshots;
drop policy if exists report_snapshots_update on public.report_snapshots;

select public.drop_fk_if_exists('public.device_profiles'::regclass, 'device_id');
select public.drop_fk_if_exists('public.device_profiles'::regclass, 'auth_user_id');
select public.drop_fk_if_exists('public.trip_headers'::regclass, 'device_id');
select public.drop_fk_if_exists('public.trip_events'::regclass, 'device_id');
select public.drop_fk_if_exists('public.trip_route_points'::regclass, 'device_id');
select public.drop_fk_if_exists('public.report_snapshots'::regclass, 'device_id');

alter table public.device_profiles
  alter column device_id type text using device_id::text;

alter table public.trip_headers
  alter column device_id type text using device_id::text;

alter table public.trip_events
  alter column device_id type text using device_id::text;

alter table public.trip_route_points
  alter column device_id type text using device_id::text;

alter table public.report_snapshots
  alter column device_id type text using device_id::text;

alter table public.device_profiles
  add column if not exists auth_user_id uuid;

update public.device_profiles
   set auth_user_id = nullif(device_id, '')::uuid
 where auth_user_id is null
   and device_id ~* '^[0-9a-f-]{36}$';

alter table public.device_profiles
  add constraint device_profiles_auth_user_id_fkey
  foreign key (auth_user_id) references auth.users (id) on delete set null;

alter table public.trip_headers
  add constraint trip_headers_device_id_fkey
  foreign key (device_id) references public.device_profiles (device_id) on delete cascade;

alter table public.trip_events
  add constraint trip_events_device_id_fkey
  foreign key (device_id) references public.device_profiles (device_id) on delete cascade;

alter table public.trip_route_points
  add constraint trip_route_points_device_id_fkey
  foreign key (device_id) references public.device_profiles (device_id) on delete cascade;

alter table public.report_snapshots
  add constraint report_snapshots_device_id_fkey
  foreign key (device_id) references public.device_profiles (device_id) on delete cascade;

create index if not exists idx_device_profiles_auth_user_id on public.device_profiles (auth_user_id);

create or replace function public.owns_tracklog_device(target_device_id text)
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
       and profile.auth_user_id = auth.uid()
  );
$$;

create or replace function public.claim_tracklog_device_profile(
  _device_id text,
  _display_name text default null,
  _vehicle_label text default null,
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
begin
  if auth.uid() is null then
    raise exception 'auth session is required';
  end if;

  select *
    into existing_profile
    from public.device_profiles
   where device_id = _device_id;

  resolved_display_name := coalesce(
    nullif(trim(_display_name), ''),
    existing_profile.display_name,
    '端末-' || right(regexp_replace(_device_id, '[^a-zA-Z0-9]', '', 'g'), 8)
  );

  resolved_vehicle_label := coalesce(
    nullif(trim(_vehicle_label), ''),
    existing_profile.vehicle_label
  );

  insert into public.device_profiles (
    device_id,
    auth_user_id,
    display_name,
    vehicle_label,
    platform,
    app_version,
    latest_status,
    latest_trip_id,
    latest_lat,
    latest_lng,
    latest_accuracy,
    last_seen_at
  )
  values (
    _device_id,
    auth.uid(),
    resolved_display_name,
    resolved_vehicle_label,
    coalesce(nullif(trim(_platform), ''), existing_profile.platform, 'unknown'),
    coalesce(nullif(trim(_app_version), ''), existing_profile.app_version),
    coalesce(nullif(trim(_latest_status), ''), existing_profile.latest_status),
    coalesce(nullif(trim(_latest_trip_id), ''), existing_profile.latest_trip_id),
    coalesce(_latest_lat, existing_profile.latest_lat),
    coalesce(_latest_lng, existing_profile.latest_lng),
    coalesce(_latest_accuracy, existing_profile.latest_accuracy),
    coalesce(_last_seen_at, now())
  )
  on conflict (device_id) do update
    set auth_user_id = auth.uid(),
        display_name = excluded.display_name,
        vehicle_label = excluded.vehicle_label,
        platform = excluded.platform,
        app_version = excluded.app_version,
        latest_status = excluded.latest_status,
        latest_trip_id = excluded.latest_trip_id,
        latest_lat = excluded.latest_lat,
        latest_lng = excluded.latest_lng,
        latest_accuracy = excluded.latest_accuracy,
        last_seen_at = excluded.last_seen_at
  returning * into claimed_profile;

  return query select claimed_profile.*;
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

  if new_profile.device_id is null then
    insert into public.device_profiles (
      device_id,
      auth_user_id,
      display_name,
      vehicle_label,
      platform,
      app_version,
      latest_status,
      latest_trip_id,
      latest_lat,
      latest_lng,
      latest_accuracy,
      last_seen_at
    )
    values (
      _new_device_id,
      auth.uid(),
      old_profile.display_name,
      old_profile.vehicle_label,
      old_profile.platform,
      old_profile.app_version,
      old_profile.latest_status,
      old_profile.latest_trip_id,
      old_profile.latest_lat,
      old_profile.latest_lng,
      old_profile.latest_accuracy,
      coalesce(old_profile.last_seen_at, now())
    );
  else
    update public.device_profiles
       set auth_user_id = auth.uid(),
           display_name = coalesce(new_profile.display_name, old_profile.display_name),
           vehicle_label = coalesce(new_profile.vehicle_label, old_profile.vehicle_label),
           latest_status = coalesce(new_profile.latest_status, old_profile.latest_status),
           latest_trip_id = coalesce(new_profile.latest_trip_id, old_profile.latest_trip_id),
           latest_lat = coalesce(new_profile.latest_lat, old_profile.latest_lat),
           latest_lng = coalesce(new_profile.latest_lng, old_profile.latest_lng),
           latest_accuracy = coalesce(new_profile.latest_accuracy, old_profile.latest_accuracy),
           last_seen_at = greatest(coalesce(new_profile.last_seen_at, now()), coalesce(old_profile.last_seen_at, now()))
     where device_id = _new_device_id;
  end if;

  update public.trip_headers set device_id = _new_device_id where device_id = _old_device_id;
  update public.trip_events set device_id = _new_device_id where device_id = _old_device_id;
  update public.trip_route_points set device_id = _new_device_id where device_id = _old_device_id;
  update public.report_snapshots set device_id = _new_device_id where device_id = _old_device_id;
  delete from public.device_profiles where device_id = _old_device_id;
end;
$$;

drop policy if exists device_profiles_select on public.device_profiles;
create policy device_profiles_select on public.device_profiles
for select using (auth.uid() = auth_user_id or public.is_tracklog_admin());

drop policy if exists device_profiles_insert on public.device_profiles;
create policy device_profiles_insert on public.device_profiles
for insert with check (auth.uid() = auth_user_id);

drop policy if exists device_profiles_update on public.device_profiles;
create policy device_profiles_update on public.device_profiles
for update using (auth.uid() = auth_user_id or public.is_tracklog_admin())
with check (auth.uid() = auth_user_id or public.is_tracklog_admin());

drop policy if exists trip_headers_select on public.trip_headers;
create policy trip_headers_select on public.trip_headers
for select using (public.owns_tracklog_device(device_id) or public.is_tracklog_admin());

drop policy if exists trip_headers_insert on public.trip_headers;
create policy trip_headers_insert on public.trip_headers
for insert with check (public.owns_tracklog_device(device_id));

drop policy if exists trip_headers_update on public.trip_headers;
create policy trip_headers_update on public.trip_headers
for update using (public.owns_tracklog_device(device_id))
with check (public.owns_tracklog_device(device_id));

drop policy if exists trip_events_select on public.trip_events;
create policy trip_events_select on public.trip_events
for select using (public.owns_tracklog_device(device_id) or public.is_tracklog_admin());

drop policy if exists trip_events_insert on public.trip_events;
create policy trip_events_insert on public.trip_events
for insert with check (public.owns_tracklog_device(device_id));

drop policy if exists trip_events_update on public.trip_events;
create policy trip_events_update on public.trip_events
for update using (public.owns_tracklog_device(device_id))
with check (public.owns_tracklog_device(device_id));

drop policy if exists trip_route_points_select on public.trip_route_points;
create policy trip_route_points_select on public.trip_route_points
for select using (public.owns_tracklog_device(device_id) or public.is_tracklog_admin());

drop policy if exists trip_route_points_insert on public.trip_route_points;
create policy trip_route_points_insert on public.trip_route_points
for insert with check (public.owns_tracklog_device(device_id));

drop policy if exists trip_route_points_update on public.trip_route_points;
create policy trip_route_points_update on public.trip_route_points
for update using (public.owns_tracklog_device(device_id))
with check (public.owns_tracklog_device(device_id));

drop policy if exists report_snapshots_select on public.report_snapshots;
create policy report_snapshots_select on public.report_snapshots
for select using (public.owns_tracklog_device(device_id) or public.is_tracklog_admin());

drop policy if exists report_snapshots_insert on public.report_snapshots;
create policy report_snapshots_insert on public.report_snapshots
for insert with check (public.owns_tracklog_device(device_id));

drop policy if exists report_snapshots_update on public.report_snapshots;
create policy report_snapshots_update on public.report_snapshots
for update using (public.owns_tracklog_device(device_id))
with check (public.owns_tracklog_device(device_id));

drop function if exists public.drop_fk_if_exists(regclass, text);
