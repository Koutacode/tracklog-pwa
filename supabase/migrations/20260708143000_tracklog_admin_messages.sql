create table if not exists public.tracklog_admin_messages (
  id uuid primary key default gen_random_uuid(),
  target_device_id text references public.device_profiles (device_id) on delete cascade,
  body text not null check (char_length(trim(body)) between 1 and 200),
  request_location boolean not null default true,
  sent_by uuid references auth.users (id) on delete set null,
  sent_at timestamptz not null default now()
);

create table if not exists public.tracklog_admin_message_receipts (
  message_id uuid not null references public.tracklog_admin_messages (id) on delete cascade,
  device_id text not null references public.device_profiles (device_id) on delete cascade,
  received_at timestamptz not null default now(),
  location_requested_at timestamptz,
  primary key (message_id, device_id)
);

create index if not exists idx_tracklog_admin_messages_target_sent
  on public.tracklog_admin_messages (target_device_id, sent_at desc);

create index if not exists idx_tracklog_admin_messages_sent
  on public.tracklog_admin_messages (sent_at desc);

create index if not exists idx_tracklog_admin_message_receipts_device
  on public.tracklog_admin_message_receipts (device_id, received_at desc);

alter table public.tracklog_admin_messages enable row level security;
alter table public.tracklog_admin_message_receipts enable row level security;

revoke all on table public.tracklog_admin_messages from public, anon, authenticated;
revoke all on table public.tracklog_admin_message_receipts from public, anon, authenticated;

grant all on table public.tracklog_admin_messages to service_role;
grant all on table public.tracklog_admin_message_receipts to service_role;
