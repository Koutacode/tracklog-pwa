drop policy if exists deleted_trip_tombstones_select on public.deleted_trip_tombstones;
create policy deleted_trip_tombstones_select on public.deleted_trip_tombstones
for select to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and (public.owns_tracklog_device(device_id) or deleted_by = (select auth.uid()) or public.is_tracklog_admin())
);
