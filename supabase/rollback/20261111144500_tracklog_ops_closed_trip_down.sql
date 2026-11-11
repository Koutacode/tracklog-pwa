-- Draft down migration for tracklog_ops_closed_trip.
-- Not in supabase/migrations, so it does not auto-apply.
-- Drops only that function. No table, column, or row is changed.

do $$
begin
  if to_regprocedure('public.tracklog_ops_closed_trip(text)') is not null then
    revoke all on function public.tracklog_ops_closed_trip(text) from public, anon, authenticated, service_role;
  end if;
end;
$$;

drop function if exists public.tracklog_ops_closed_trip(text);
