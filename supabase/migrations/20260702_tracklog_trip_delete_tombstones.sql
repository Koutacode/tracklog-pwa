create table if not exists public.deleted_trip_tombstones (
  trip_id text primary key,
  device_id text not null references public.device_profiles (device_id) on delete cascade,
  deleted_by uuid not null references auth.users (id) on delete cascade,
  deleted_at timestamptz not null default now()
);

create index if not exists idx_deleted_trip_tombstones_device_deleted_at
  on public.deleted_trip_tombstones (device_id, deleted_at desc);

create index if not exists idx_deleted_trip_tombstones_deleted_by
  on public.deleted_trip_tombstones (deleted_by);

alter table public.deleted_trip_tombstones enable row level security;

drop policy if exists deleted_trip_tombstones_select on public.deleted_trip_tombstones;
create policy deleted_trip_tombstones_select on public.deleted_trip_tombstones
for select to authenticated
using (
  coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  and (public.owns_tracklog_device(device_id) or deleted_by = (select auth.uid()) or public.is_tracklog_admin())
);

revoke all on table public.deleted_trip_tombstones from public;
revoke all on table public.deleted_trip_tombstones from anon;
grant select on table public.deleted_trip_tombstones to authenticated;

create or replace function public.skip_deleted_trip_tombstone_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
      from public.deleted_trip_tombstones deleted
     where deleted.trip_id = new.trip_id
       and deleted.device_id = new.device_id
  ) then
    return null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_trip_headers_skip_deleted on public.trip_headers;
create trigger trg_trip_headers_skip_deleted
before insert on public.trip_headers
for each row execute function public.skip_deleted_trip_tombstone_row();

drop trigger if exists trg_trip_events_skip_deleted on public.trip_events;
create trigger trg_trip_events_skip_deleted
before insert on public.trip_events
for each row execute function public.skip_deleted_trip_tombstone_row();

drop trigger if exists trg_trip_route_points_skip_deleted on public.trip_route_points;
create trigger trg_trip_route_points_skip_deleted
before insert on public.trip_route_points
for each row execute function public.skip_deleted_trip_tombstone_row();

drop trigger if exists trg_report_snapshots_skip_deleted on public.report_snapshots;
create trigger trg_report_snapshots_skip_deleted
before insert on public.report_snapshots
for each row execute function public.skip_deleted_trip_tombstone_row();

create or replace function public.delete_tracklog_own_trip(_trip_id text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trip_id text := nullif(trim(_trip_id), '');
  v_device_id text;
  v_deleted_count integer;
begin
  if auth.uid() is null then
    raise exception 'auth session is required' using errcode = '42501';
  end if;

  if v_trip_id is null then
    raise exception 'trip_id is required' using errcode = '22023';
  end if;

  select header.device_id
    into v_device_id
    from public.trip_headers header
   where header.trip_id = v_trip_id
     and (
       public.owns_tracklog_device(header.device_id)
       or public.is_tracklog_admin()
     )
   limit 1;

  if v_device_id is null then
    return 0;
  end if;

  insert into public.deleted_trip_tombstones (trip_id, device_id, deleted_by, deleted_at)
  values (v_trip_id, v_device_id, auth.uid(), now())
  on conflict (trip_id) do update
    set device_id = excluded.device_id,
        deleted_by = excluded.deleted_by,
        deleted_at = excluded.deleted_at;

  delete from public.trip_headers header
   where header.trip_id = v_trip_id
     and header.device_id = v_device_id;

  get diagnostics v_deleted_count = row_count;
  return v_deleted_count;
end;
$$;

revoke all on function public.skip_deleted_trip_tombstone_row() from public;
revoke execute on function public.skip_deleted_trip_tombstone_row() from anon;
revoke execute on function public.skip_deleted_trip_tombstone_row() from authenticated;
revoke execute on function public.skip_deleted_trip_tombstone_row() from service_role;

revoke all on function public.delete_tracklog_own_trip(text) from public;
revoke execute on function public.delete_tracklog_own_trip(text) from anon;
revoke execute on function public.delete_tracklog_own_trip(text) from service_role;
grant execute on function public.delete_tracklog_own_trip(text) to authenticated;
