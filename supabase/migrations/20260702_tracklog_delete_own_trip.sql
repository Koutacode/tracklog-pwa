create or replace function public.delete_tracklog_own_trip(_trip_id text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trip_id text := nullif(trim(_trip_id), '');
  v_deleted_count integer;
begin
  if auth.uid() is null then
    raise exception 'auth session is required' using errcode = '42501';
  end if;

  if v_trip_id is null then
    raise exception 'trip_id is required' using errcode = '22023';
  end if;

  delete from public.trip_headers header
   where header.trip_id = v_trip_id
     and (
       public.owns_tracklog_device(header.device_id)
       or public.is_tracklog_admin()
     );

  get diagnostics v_deleted_count = row_count;
  return v_deleted_count;
end;
$$;

revoke all on function public.delete_tracklog_own_trip(text) from public;
revoke execute on function public.delete_tracklog_own_trip(text) from anon;
revoke execute on function public.delete_tracklog_own_trip(text) from service_role;
grant execute on function public.delete_tracklog_own_trip(text) to authenticated;
