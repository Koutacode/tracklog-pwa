drop policy if exists deleted_trip_tombstones_select on public.deleted_trip_tombstones;
create policy deleted_trip_tombstones_select on public.deleted_trip_tombstones
for select to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and (
    (
      public.owns_tracklog_device(device_id)
      and public.is_tracklog_device_approved(device_id)
    )
    or public.is_tracklog_admin()
  )
);

revoke execute on function public.claim_tracklog_device_profile(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  double precision,
  double precision,
  double precision,
  timestamptz
) from public, anon;
grant execute on function public.claim_tracklog_device_profile(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  double precision,
  double precision,
  double precision,
  timestamptz
) to authenticated;

revoke execute on function public.set_tracklog_device_approval(text, text) from public, anon;
grant execute on function public.set_tracklog_device_approval(text, text) to authenticated;

revoke execute on function public.is_tracklog_account_approved(uuid) from public, anon;
grant execute on function public.is_tracklog_account_approved(uuid) to authenticated;

revoke execute on function public.is_tracklog_device_approved(text) from public, anon;
grant execute on function public.is_tracklog_device_approved(text) to authenticated;

revoke execute on function public.migrate_tracklog_device_records(text, text) from public, anon;
grant execute on function public.migrate_tracklog_device_records(text, text) to authenticated;
