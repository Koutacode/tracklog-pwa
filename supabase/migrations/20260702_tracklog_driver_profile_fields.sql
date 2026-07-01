alter table public.device_profiles
  add column if not exists driver_phone text,
  add column if not exists driver_email text;

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
    last_seen_at
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
    coalesce(_last_seen_at, now())
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
      driver_phone,
      driver_email,
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
      old_profile.driver_phone,
      old_profile.driver_email,
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
           driver_phone = coalesce(new_profile.driver_phone, old_profile.driver_phone),
           driver_email = coalesce(new_profile.driver_email, old_profile.driver_email),
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
