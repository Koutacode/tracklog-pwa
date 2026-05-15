create or replace function public.delete_tracklog_trip(_trip_id text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer;
begin
  if not public.is_tracklog_admin() then
    raise exception 'admin privileges are required' using errcode = '42501';
  end if;

  if nullif(trim(_trip_id), '') is null then
    raise exception 'trip_id is required' using errcode = '22023';
  end if;

  delete from public.trip_headers
   where trip_id = _trip_id;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.delete_tracklog_trip(text) from public;
revoke execute on function public.delete_tracklog_trip(text) from anon;
revoke execute on function public.delete_tracklog_trip(text) from service_role;
grant execute on function public.delete_tracklog_trip(text) to authenticated;
