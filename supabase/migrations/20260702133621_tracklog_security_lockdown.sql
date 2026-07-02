create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

alter table public.admin_users enable row level security;

revoke all on table public.admin_users from public, anon, authenticated;
grant select on table public.admin_users to authenticated;

revoke all on table public.tracklog_cloud_maintenance from public, anon, authenticated;
grant select on table public.tracklog_cloud_maintenance to authenticated;

revoke all on table public.device_profiles from public, anon;
revoke all on table public.trip_headers from public, anon;
revoke all on table public.trip_events from public, anon;
revoke all on table public.trip_route_points from public, anon;
revoke all on table public.report_snapshots from public, anon;
revoke all on table public.deleted_trip_tombstones from public, anon;

grant select, insert, update on table public.device_profiles to authenticated;
grant select, insert, update on table public.trip_headers to authenticated;
grant select, insert, update on table public.trip_events to authenticated;
grant select, insert, update on table public.trip_route_points to authenticated;
grant select, insert, update on table public.report_snapshots to authenticated;
grant select on table public.deleted_trip_tombstones to authenticated;

revoke execute on function public.is_tracklog_admin() from public, anon;
grant execute on function public.is_tracklog_admin() to authenticated;

revoke execute on function public.owns_tracklog_device(text) from public, anon;
grant execute on function public.owns_tracklog_device(text) to authenticated;

drop policy if exists admin_users_select on public.admin_users;
create policy admin_users_select on public.admin_users
for select to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and public.is_tracklog_admin()
);

drop policy if exists tracklog_cloud_maintenance_select on public.tracklog_cloud_maintenance;
create policy tracklog_cloud_maintenance_select on public.tracklog_cloud_maintenance
for select to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and public.is_tracklog_admin()
);

drop policy if exists device_profiles_select on public.device_profiles;
create policy device_profiles_select on public.device_profiles
for select to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and ((select auth.uid()) = auth_user_id or public.is_tracklog_admin())
);

drop policy if exists device_profiles_insert on public.device_profiles;
create policy device_profiles_insert on public.device_profiles
for insert to authenticated
with check (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and (select auth.uid()) = auth_user_id
  and approval_status = 'pending'
);

drop policy if exists device_profiles_update on public.device_profiles;
create policy device_profiles_update on public.device_profiles
for update to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and public.is_tracklog_admin()
)
with check (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and public.is_tracklog_admin()
);

drop policy if exists trip_headers_select on public.trip_headers;
create policy trip_headers_select on public.trip_headers
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

drop policy if exists trip_headers_insert on public.trip_headers;
create policy trip_headers_insert on public.trip_headers
for insert to authenticated
with check (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and public.owns_tracklog_device(device_id)
  and public.is_tracklog_device_approved(device_id)
);

drop policy if exists trip_headers_update on public.trip_headers;
create policy trip_headers_update on public.trip_headers
for update to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and public.owns_tracklog_device(device_id)
  and public.is_tracklog_device_approved(device_id)
)
with check (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and public.owns_tracklog_device(device_id)
  and public.is_tracklog_device_approved(device_id)
);

drop policy if exists trip_events_select on public.trip_events;
create policy trip_events_select on public.trip_events
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

drop policy if exists trip_events_insert on public.trip_events;
create policy trip_events_insert on public.trip_events
for insert to authenticated
with check (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and public.owns_tracklog_device(device_id)
  and public.is_tracklog_device_approved(device_id)
);

drop policy if exists trip_events_update on public.trip_events;
create policy trip_events_update on public.trip_events
for update to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and public.owns_tracklog_device(device_id)
  and public.is_tracklog_device_approved(device_id)
)
with check (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and public.owns_tracklog_device(device_id)
  and public.is_tracklog_device_approved(device_id)
);

drop policy if exists trip_route_points_select on public.trip_route_points;
create policy trip_route_points_select on public.trip_route_points
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

drop policy if exists trip_route_points_insert on public.trip_route_points;
create policy trip_route_points_insert on public.trip_route_points
for insert to authenticated
with check (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and public.owns_tracklog_device(device_id)
  and public.is_tracklog_device_approved(device_id)
);

drop policy if exists trip_route_points_update on public.trip_route_points;
create policy trip_route_points_update on public.trip_route_points
for update to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and public.owns_tracklog_device(device_id)
  and public.is_tracklog_device_approved(device_id)
)
with check (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and public.owns_tracklog_device(device_id)
  and public.is_tracklog_device_approved(device_id)
);

drop policy if exists report_snapshots_select on public.report_snapshots;
create policy report_snapshots_select on public.report_snapshots
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

drop policy if exists report_snapshots_insert on public.report_snapshots;
create policy report_snapshots_insert on public.report_snapshots
for insert to authenticated
with check (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and public.owns_tracklog_device(device_id)
  and public.is_tracklog_device_approved(device_id)
);

drop policy if exists report_snapshots_update on public.report_snapshots;
create policy report_snapshots_update on public.report_snapshots
for update to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and public.owns_tracklog_device(device_id)
  and public.is_tracklog_device_approved(device_id)
)
with check (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and public.owns_tracklog_device(device_id)
  and public.is_tracklog_device_approved(device_id)
);

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
