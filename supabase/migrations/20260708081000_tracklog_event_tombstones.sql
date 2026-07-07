create table if not exists public.deleted_event_tombstones (
  event_id text primary key,
  trip_id text not null,
  device_id text not null references public.device_profiles(device_id) on delete cascade,
  event_type text,
  event_ts timestamptz,
  deleted_by uuid not null default auth.uid(),
  deleted_at timestamptz not null default now()
);

create index if not exists idx_deleted_event_tombstones_device_deleted_at
  on public.deleted_event_tombstones (device_id, deleted_at desc);

create index if not exists idx_deleted_event_tombstones_trip_id
  on public.deleted_event_tombstones (trip_id);

create index if not exists idx_deleted_event_tombstones_deleted_by
  on public.deleted_event_tombstones (deleted_by);

alter table public.deleted_event_tombstones enable row level security;

create or replace function public.apply_tracklog_deleted_event_tombstone()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
begin
  if (select auth.uid()) is null then
    raise exception 'authentication required';
  end if;

  if coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception 'anonymous users cannot delete TrackLog events';
  end if;

  v_is_admin := public.is_tracklog_admin();
  if not v_is_admin then
    if new.deleted_by is distinct from (select auth.uid()) then
      raise exception 'deleted_by must match current user';
    end if;

    if not public.owns_tracklog_device(new.device_id)
       or not public.is_tracklog_device_approved(new.device_id) then
      raise exception 'device is not approved for this user';
    end if;
  end if;

  delete from public.trip_events event
  using public.device_profiles profile
  where event.id = new.event_id
    and profile.device_id = event.device_id
    and (v_is_admin or profile.auth_user_id = new.deleted_by);

  delete from public.trip_route_points point
  using public.device_profiles profile
  where point.id = ('event-anchor-' || new.event_id)
    and profile.device_id = point.device_id
    and (v_is_admin or profile.auth_user_id = new.deleted_by);

  delete from public.report_snapshots snapshot
  using public.device_profiles profile
  where snapshot.trip_id = new.trip_id
    and profile.device_id = snapshot.device_id
    and (v_is_admin or profile.auth_user_id = new.deleted_by);

  return new;
end;
$$;

drop trigger if exists trg_apply_tracklog_deleted_event_tombstone on public.deleted_event_tombstones;
create trigger trg_apply_tracklog_deleted_event_tombstone
after insert or update of event_id, trip_id, device_id, deleted_by on public.deleted_event_tombstones
for each row execute function public.apply_tracklog_deleted_event_tombstone();

create or replace function public.skip_deleted_event_tombstone_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_event_id text;
begin
  select profile.auth_user_id
    into v_owner
    from public.device_profiles profile
   where profile.device_id = new.device_id
   limit 1;

  if tg_table_name = 'trip_route_points' then
    v_event_id := regexp_replace(new.id, '^event-anchor-', '');
    if v_event_id = new.id then
      return new;
    end if;
  else
    v_event_id := new.id;
  end if;

  if v_owner is not null and exists (
    select 1
      from public.deleted_event_tombstones deleted
     where deleted.event_id = v_event_id
       and deleted.deleted_by = v_owner
  ) then
    return null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_trip_events_skip_deleted_event on public.trip_events;
create trigger trg_trip_events_skip_deleted_event
before insert or update on public.trip_events
for each row execute function public.skip_deleted_event_tombstone_row();

drop trigger if exists trg_trip_route_points_skip_deleted_event on public.trip_route_points;
create trigger trg_trip_route_points_skip_deleted_event
before insert or update on public.trip_route_points
for each row execute function public.skip_deleted_event_tombstone_row();

revoke all on table public.deleted_event_tombstones from public, anon, authenticated;
grant select, insert, update on table public.deleted_event_tombstones to authenticated;

revoke all on function public.apply_tracklog_deleted_event_tombstone() from public;
revoke execute on function public.apply_tracklog_deleted_event_tombstone() from anon;
revoke execute on function public.apply_tracklog_deleted_event_tombstone() from authenticated;
revoke execute on function public.apply_tracklog_deleted_event_tombstone() from service_role;

revoke all on function public.skip_deleted_event_tombstone_row() from public;
revoke execute on function public.skip_deleted_event_tombstone_row() from anon;
revoke execute on function public.skip_deleted_event_tombstone_row() from authenticated;
revoke execute on function public.skip_deleted_event_tombstone_row() from service_role;

drop policy if exists deleted_event_tombstones_select on public.deleted_event_tombstones;
create policy deleted_event_tombstones_select on public.deleted_event_tombstones
for select to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and (
    (
      public.owns_tracklog_device(device_id)
      and public.is_tracklog_device_approved(device_id)
    )
    or deleted_by = (select auth.uid())
    or public.is_tracklog_admin()
  )
);

drop policy if exists deleted_event_tombstones_insert on public.deleted_event_tombstones;
create policy deleted_event_tombstones_insert on public.deleted_event_tombstones
for insert to authenticated
with check (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and deleted_by = (select auth.uid())
  and public.owns_tracklog_device(device_id)
  and public.is_tracklog_device_approved(device_id)
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
      public.owns_tracklog_device(device_id)
      and public.is_tracklog_device_approved(device_id)
    )
    or public.is_tracklog_admin()
  )
)
with check (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and (
    (
      deleted_by = (select auth.uid())
      and public.owns_tracklog_device(device_id)
      and public.is_tracklog_device_approved(device_id)
    )
    or public.is_tracklog_admin()
  )
);
