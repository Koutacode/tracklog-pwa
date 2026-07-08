create table if not exists public.tracklog_server_secrets (
  key text primary key,
  value text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tracklog_server_secrets enable row level security;

revoke all on table public.tracklog_server_secrets from public, anon, authenticated;
grant select, insert, update, delete on table public.tracklog_server_secrets to service_role;
