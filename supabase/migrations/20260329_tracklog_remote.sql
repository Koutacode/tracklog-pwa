create extension if not exists pgcrypto;

create table if not exists public.admin_users (
  email text primary key,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.admin_users (email, enabled)
values ('matumurak0623@gmail.com', true)
on conflict (email) do nothing;

create or replace function public.is_tracklog_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_users admin
    where admin.enabled = true
      and lower(admin.email) = lower(coalesce(auth.jwt()->>'email', ''))
  );
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.device_profiles (
  device_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  vehicle_label text,
  platform text not null,
  app_version text,
  latest_status text,
  latest_trip_id text,
  latest_lat double precision,
  latest_lng double precision,
  latest_accuracy double precision,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.trip_headers (
  trip_id text primary key,
  device_id uuid not null references auth.users (id) on delete cascade,
  start_ts timestamptz not null,
  end_ts timestamptz,
  odo_start integer not null,
  odo_end integer,
  total_km integer,
  last_leg_km integer,
  status text not null check (status in ('active', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.trip_events (
  id text primary key,
  trip_id text not null references public.trip_headers (trip_id) on delete cascade,
  device_id uuid not null references auth.users (id) on delete cascade,
  type text not null,
  ts timestamptz not null,
  address text,
  geo jsonb,
  extras jsonb,
  sync_status text not null default 'pending' check (sync_status in ('pending', 'synced', 'error')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.trip_route_points (
  id text primary key,
  trip_id text not null references public.trip_headers (trip_id) on delete cascade,
  device_id uuid not null references auth.users (id) on delete cascade,
  ts timestamptz not null,
  lat double precision not null,
  lng double precision not null,
  accuracy double precision,
  speed double precision,
  heading double precision,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.report_snapshots (
  trip_id text primary key references public.trip_headers (trip_id) on delete cascade,
  device_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null,
  label text not null,
  payload_json jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_trip_headers_device_id on public.trip_headers (device_id, start_ts desc);
create index if not exists idx_trip_events_trip_id on public.trip_events (trip_id, ts);
create index if not exists idx_trip_events_device_id on public.trip_events (device_id, ts desc);
create index if not exists idx_trip_route_points_trip_id on public.trip_route_points (trip_id, ts);
create index if not exists idx_trip_route_points_device_id on public.trip_route_points (device_id, ts desc);
create index if not exists idx_report_snapshots_device_id on public.report_snapshots (device_id, created_at desc);

drop trigger if exists trg_device_profiles_updated_at on public.device_profiles;
create trigger trg_device_profiles_updated_at
before update on public.device_profiles
for each row execute function public.set_updated_at();

drop trigger if exists trg_trip_headers_updated_at on public.trip_headers;
create trigger trg_trip_headers_updated_at
before update on public.trip_headers
for each row execute function public.set_updated_at();

drop trigger if exists trg_trip_events_updated_at on public.trip_events;
create trigger trg_trip_events_updated_at
before update on public.trip_events
for each row execute function public.set_updated_at();

drop trigger if exists trg_trip_route_points_updated_at on public.trip_route_points;
create trigger trg_trip_route_points_updated_at
before update on public.trip_route_points
for each row execute function public.set_updated_at();

drop trigger if exists trg_report_snapshots_updated_at on public.report_snapshots;
create trigger trg_report_snapshots_updated_at
before update on public.report_snapshots
for each row execute function public.set_updated_at();

alter table public.device_profiles enable row level security;
alter table public.trip_headers enable row level security;
alter table public.trip_events enable row level security;
alter table public.trip_route_points enable row level security;
alter table public.report_snapshots enable row level security;

drop policy if exists device_profiles_select on public.device_profiles;
create policy device_profiles_select on public.device_profiles
for select using (auth.uid() = device_id or public.is_tracklog_admin());

drop policy if exists device_profiles_insert on public.device_profiles;
create policy device_profiles_insert on public.device_profiles
for insert with check (auth.uid() = device_id);

drop policy if exists device_profiles_update on public.device_profiles;
create policy device_profiles_update on public.device_profiles
for update using (auth.uid() = device_id or public.is_tracklog_admin())
with check (auth.uid() = device_id or public.is_tracklog_admin());

drop policy if exists trip_headers_select on public.trip_headers;
create policy trip_headers_select on public.trip_headers
for select using (auth.uid() = device_id or public.is_tracklog_admin());

drop policy if exists trip_headers_insert on public.trip_headers;
create policy trip_headers_insert on public.trip_headers
for insert with check (auth.uid() = device_id);

drop policy if exists trip_headers_update on public.trip_headers;
create policy trip_headers_update on public.trip_headers
for update using (auth.uid() = device_id)
with check (auth.uid() = device_id);

drop policy if exists trip_events_select on public.trip_events;
create policy trip_events_select on public.trip_events
for select using (auth.uid() = device_id or public.is_tracklog_admin());

drop policy if exists trip_events_insert on public.trip_events;
create policy trip_events_insert on public.trip_events
for insert with check (auth.uid() = device_id);

drop policy if exists trip_events_update on public.trip_events;
create policy trip_events_update on public.trip_events
for update using (auth.uid() = device_id)
with check (auth.uid() = device_id);

drop policy if exists trip_route_points_select on public.trip_route_points;
create policy trip_route_points_select on public.trip_route_points
for select using (auth.uid() = device_id or public.is_tracklog_admin());

drop policy if exists trip_route_points_insert on public.trip_route_points;
create policy trip_route_points_insert on public.trip_route_points
for insert with check (auth.uid() = device_id);

drop policy if exists trip_route_points_update on public.trip_route_points;
create policy trip_route_points_update on public.trip_route_points
for update using (auth.uid() = device_id)
with check (auth.uid() = device_id);

drop policy if exists report_snapshots_select on public.report_snapshots;
create policy report_snapshots_select on public.report_snapshots
for select using (auth.uid() = device_id or public.is_tracklog_admin());

drop policy if exists report_snapshots_insert on public.report_snapshots;
create policy report_snapshots_insert on public.report_snapshots
for insert with check (auth.uid() = device_id);

drop policy if exists report_snapshots_update on public.report_snapshots;
create policy report_snapshots_update on public.report_snapshots
for update using (auth.uid() = device_id)
with check (auth.uid() = device_id);

