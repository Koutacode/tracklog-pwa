-- Draft down migration for tracklog_ops_status.
-- Not in supabase/migrations, so it does not auto-apply.
-- Drops only the function and partial index added by
-- supabase/migrations/20261111140308_tracklog_ops_status.sql.
-- No table, column, or row is changed.

do $$
begin
  if to_regprocedure('public.tracklog_ops_status(text)') is not null then
    revoke all on function public.tracklog_ops_status(text) from public, anon, authenticated, service_role;
  end if;
end;
$$;

drop function if exists public.tracklog_ops_status(text);
drop index if exists public.idx_trip_headers_active_device;
