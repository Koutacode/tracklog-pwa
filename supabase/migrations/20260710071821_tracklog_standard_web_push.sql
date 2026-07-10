alter table public.tracklog_push_registrations
  drop constraint if exists tracklog_push_registrations_provider_check;

alter table public.tracklog_push_registrations
  add constraint tracklog_push_registrations_provider_check
  check (provider in ('fcm', 'webpush'));
