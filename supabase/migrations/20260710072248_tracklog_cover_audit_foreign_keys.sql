create index if not exists idx_tracklog_admin_messages_sent_by
  on public.tracklog_admin_messages (sent_by);

create index if not exists idx_tracklog_runtime_config_updated_by
  on public.tracklog_runtime_config (updated_by);
