alter table public.device_profiles
  add column if not exists latest_location_at timestamptz;

create index if not exists idx_device_profiles_latest_location_at
  on public.device_profiles (latest_location_at desc);
