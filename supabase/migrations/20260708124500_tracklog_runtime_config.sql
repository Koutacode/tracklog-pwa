create table if not exists public.tracklog_runtime_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

insert into public.tracklog_runtime_config (key, value)
values ('location_notification_text', '位置記録中')
on conflict (key) do nothing;

alter table public.tracklog_runtime_config enable row level security;

revoke all on table public.tracklog_runtime_config from public, anon, authenticated;
