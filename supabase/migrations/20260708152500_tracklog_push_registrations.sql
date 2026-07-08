create table if not exists public.tracklog_push_registrations (
  id uuid primary key default gen_random_uuid(),
  device_id text not null references public.device_profiles (device_id) on delete cascade,
  auth_user_id uuid references auth.users (id) on delete cascade,
  provider text not null default 'fcm' check (provider in ('fcm')),
  platform text not null check (platform in ('android', 'web')),
  token text not null,
  token_hash text not null,
  enabled boolean not null default true,
  failure_count integer not null default 0 check (failure_count >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (provider, token_hash)
);

create index if not exists idx_tracklog_push_registrations_device
  on public.tracklog_push_registrations (device_id, enabled, last_seen_at desc);

create index if not exists idx_tracklog_push_registrations_auth_user
  on public.tracklog_push_registrations (auth_user_id, enabled, last_seen_at desc);

alter table public.tracklog_push_registrations enable row level security;

revoke all on table public.tracklog_push_registrations from public, anon, authenticated;

grant all on table public.tracklog_push_registrations to service_role;
