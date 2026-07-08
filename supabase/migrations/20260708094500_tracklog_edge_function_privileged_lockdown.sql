create schema if not exists tracklog_private;

revoke all on schema tracklog_private from public;
revoke all on schema tracklog_private from anon;
grant usage on schema tracklog_private to authenticated, service_role;

create or replace function tracklog_private.is_tracklog_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.admin_users admin
     where admin.enabled = true
       and lower(admin.email) = lower(coalesce((select auth.jwt()) ->> 'email', ''))
  );
$$;

create or replace function tracklog_private.owns_tracklog_device(target_device_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.device_profiles profile
     where profile.device_id = target_device_id
       and profile.auth_user_id = (select auth.uid())
  );
$$;

create or replace function tracklog_private.is_tracklog_account_approved(target_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.device_profiles profile
     where profile.auth_user_id = target_user_id
       and profile.approval_status = 'approved'
  );
$$;

create or replace function tracklog_private.is_tracklog_device_approved(target_device_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.device_profiles profile
     where profile.device_id = target_device_id
       and profile.approval_status = 'approved'
       and profile.auth_user_id = (select auth.uid())
  );
$$;

revoke all on function tracklog_private.is_tracklog_admin() from public, anon;
revoke all on function tracklog_private.owns_tracklog_device(text) from public, anon;
revoke all on function tracklog_private.is_tracklog_account_approved(uuid) from public, anon;
revoke all on function tracklog_private.is_tracklog_device_approved(text) from public, anon;
grant execute on function tracklog_private.is_tracklog_admin() to authenticated, service_role;
grant execute on function tracklog_private.owns_tracklog_device(text) to authenticated, service_role;
grant execute on function tracklog_private.is_tracklog_account_approved(uuid) to authenticated, service_role;
grant execute on function tracklog_private.is_tracklog_device_approved(text) to authenticated, service_role;

drop policy if exists admin_users_select on public.admin_users;
create policy admin_users_select on public.admin_users
for select to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and tracklog_private.is_tracklog_admin()
);

drop policy if exists tracklog_cloud_maintenance_select on public.tracklog_cloud_maintenance;
create policy tracklog_cloud_maintenance_select on public.tracklog_cloud_maintenance
for select to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and tracklog_private.is_tracklog_admin()
);

drop policy if exists device_profiles_select on public.device_profiles;
create policy device_profiles_select on public.device_profiles
for select to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and ((select auth.uid()) = auth_user_id or tracklog_private.is_tracklog_admin())
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
  and tracklog_private.is_tracklog_admin()
)
with check (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and tracklog_private.is_tracklog_admin()
);

drop policy if exists trip_headers_select on public.trip_headers;
create policy trip_headers_select on public.trip_headers
for select to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and (
    (
      tracklog_private.owns_tracklog_device(device_id)
      and tracklog_private.is_tracklog_device_approved(device_id)
    )
    or tracklog_private.is_tracklog_admin()
  )
);

drop policy if exists trip_headers_insert on public.trip_headers;
create policy trip_headers_insert on public.trip_headers
for insert to authenticated
with check (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and tracklog_private.owns_tracklog_device(device_id)
  and tracklog_private.is_tracklog_device_approved(device_id)
);

drop policy if exists trip_headers_update on public.trip_headers;
create policy trip_headers_update on public.trip_headers
for update to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and tracklog_private.owns_tracklog_device(device_id)
  and tracklog_private.is_tracklog_device_approved(device_id)
)
with check (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and tracklog_private.owns_tracklog_device(device_id)
  and tracklog_private.is_tracklog_device_approved(device_id)
);

drop policy if exists trip_events_select on public.trip_events;
create policy trip_events_select on public.trip_events
for select to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and (
    (
      tracklog_private.owns_tracklog_device(device_id)
      and tracklog_private.is_tracklog_device_approved(device_id)
    )
    or tracklog_private.is_tracklog_admin()
  )
);

drop policy if exists trip_events_insert on public.trip_events;
create policy trip_events_insert on public.trip_events
for insert to authenticated
with check (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and tracklog_private.owns_tracklog_device(device_id)
  and tracklog_private.is_tracklog_device_approved(device_id)
);

drop policy if exists trip_events_update on public.trip_events;
create policy trip_events_update on public.trip_events
for update to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and tracklog_private.owns_tracklog_device(device_id)
  and tracklog_private.is_tracklog_device_approved(device_id)
)
with check (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and tracklog_private.owns_tracklog_device(device_id)
  and tracklog_private.is_tracklog_device_approved(device_id)
);

drop policy if exists trip_route_points_select on public.trip_route_points;
create policy trip_route_points_select on public.trip_route_points
for select to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and (
    (
      tracklog_private.owns_tracklog_device(device_id)
      and tracklog_private.is_tracklog_device_approved(device_id)
    )
    or tracklog_private.is_tracklog_admin()
  )
);

drop policy if exists trip_route_points_insert on public.trip_route_points;
create policy trip_route_points_insert on public.trip_route_points
for insert to authenticated
with check (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and tracklog_private.owns_tracklog_device(device_id)
  and tracklog_private.is_tracklog_device_approved(device_id)
);

drop policy if exists trip_route_points_update on public.trip_route_points;
create policy trip_route_points_update on public.trip_route_points
for update to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and tracklog_private.owns_tracklog_device(device_id)
  and tracklog_private.is_tracklog_device_approved(device_id)
)
with check (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and tracklog_private.owns_tracklog_device(device_id)
  and tracklog_private.is_tracklog_device_approved(device_id)
);

drop policy if exists report_snapshots_select on public.report_snapshots;
create policy report_snapshots_select on public.report_snapshots
for select to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and (
    (
      tracklog_private.owns_tracklog_device(device_id)
      and tracklog_private.is_tracklog_device_approved(device_id)
    )
    or tracklog_private.is_tracklog_admin()
  )
);

drop policy if exists report_snapshots_insert on public.report_snapshots;
create policy report_snapshots_insert on public.report_snapshots
for insert to authenticated
with check (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and tracklog_private.owns_tracklog_device(device_id)
  and tracklog_private.is_tracklog_device_approved(device_id)
);

drop policy if exists report_snapshots_update on public.report_snapshots;
create policy report_snapshots_update on public.report_snapshots
for update to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and tracklog_private.owns_tracklog_device(device_id)
  and tracklog_private.is_tracklog_device_approved(device_id)
)
with check (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and tracklog_private.owns_tracklog_device(device_id)
  and tracklog_private.is_tracklog_device_approved(device_id)
);

drop policy if exists deleted_trip_tombstones_select on public.deleted_trip_tombstones;
create policy deleted_trip_tombstones_select on public.deleted_trip_tombstones
for select to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and (
    (
      tracklog_private.owns_tracklog_device(device_id)
      and tracklog_private.is_tracklog_device_approved(device_id)
    )
    or deleted_by = (select auth.uid())
    or tracklog_private.is_tracklog_admin()
  )
);

drop policy if exists deleted_event_tombstones_select on public.deleted_event_tombstones;
create policy deleted_event_tombstones_select on public.deleted_event_tombstones
for select to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and (
    (
      tracklog_private.owns_tracklog_device(device_id)
      and tracklog_private.is_tracklog_device_approved(device_id)
    )
    or deleted_by = (select auth.uid())
    or tracklog_private.is_tracklog_admin()
  )
);

drop policy if exists deleted_event_tombstones_insert on public.deleted_event_tombstones;
create policy deleted_event_tombstones_insert on public.deleted_event_tombstones
for insert to authenticated
with check (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and deleted_by = (select auth.uid())
  and tracklog_private.owns_tracklog_device(device_id)
  and tracklog_private.is_tracklog_device_approved(device_id)
);

drop policy if exists deleted_event_tombstones_update on public.deleted_event_tombstones;
create policy deleted_event_tombstones_update on public.deleted_event_tombstones
for update to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and (
    deleted_by = (select auth.uid())
    or
    (
      tracklog_private.owns_tracklog_device(device_id)
      and tracklog_private.is_tracklog_device_approved(device_id)
    )
    or tracklog_private.is_tracklog_admin()
  )
)
with check (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and (
    (
      deleted_by = (select auth.uid())
      and tracklog_private.owns_tracklog_device(device_id)
      and tracklog_private.is_tracklog_device_approved(device_id)
    )
    or tracklog_private.is_tracklog_admin()
  )
);

revoke execute on function public.claim_tracklog_device_profile(text,text,text,text,text,text,text,text,text,double precision,double precision,double precision,timestamptz) from public, anon, authenticated;
revoke execute on function public.delete_tracklog_device(text) from public, anon, authenticated;
revoke execute on function public.delete_tracklog_own_trip(text) from public, anon, authenticated;
revoke execute on function public.delete_tracklog_trip(text) from public, anon, authenticated;
revoke execute on function public.is_tracklog_account_approved(uuid) from public, anon, authenticated;
revoke execute on function public.is_tracklog_admin() from public, anon, authenticated;
revoke execute on function public.is_tracklog_device_approved(text) from public, anon, authenticated;
revoke execute on function public.migrate_tracklog_device_records(text,text) from public, anon, authenticated;
revoke execute on function public.owns_tracklog_device(text) from public, anon, authenticated;
revoke execute on function public.set_tracklog_device_approval(text,text) from public, anon, authenticated;
grant execute on function public.prune_tracklog_cloud_usage() to service_role;
