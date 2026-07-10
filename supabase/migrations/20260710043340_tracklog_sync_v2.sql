-- TrackLog sync protocol v2.
--
-- The per-owner counter row is the serialization point for every row in the
-- change feed. A transaction cannot allocate a change_seq until the previous
-- transaction for that owner commits or rolls back, so a cursor can never skip
-- a late commit with a lower sequence number.

alter table public.device_profiles
  add column if not exists sync_protocol_version integer not null default 1,
  add column if not exists last_sync_v2_at timestamptz;

alter table public.trip_headers
  add column if not exists owner_user_id uuid,
  add column if not exists revision bigint not null default 1,
  add column if not exists change_seq bigint not null default 0;

alter table public.trip_events
  add column if not exists owner_user_id uuid,
  add column if not exists revision bigint not null default 1,
  add column if not exists change_seq bigint not null default 0;

alter table public.trip_route_points
  add column if not exists owner_user_id uuid,
  add column if not exists revision bigint not null default 1,
  add column if not exists change_seq bigint not null default 0;

alter table public.report_snapshots
  add column if not exists owner_user_id uuid,
  add column if not exists revision bigint not null default 1,
  add column if not exists change_seq bigint not null default 0;

alter table public.deleted_trip_tombstones
  add column if not exists owner_user_id uuid,
  add column if not exists revision bigint not null default 1,
  add column if not exists change_seq bigint not null default 0,
  add column if not exists updated_at timestamptz not null default now();

alter table public.deleted_event_tombstones
  add column if not exists owner_user_id uuid,
  add column if not exists revision bigint not null default 1,
  add column if not exists change_seq bigint not null default 0,
  add column if not exists updated_at timestamptz not null default now();

create table public.deleted_report_tombstones (
  trip_id text primary key,
  device_id text not null,
  owner_user_id uuid not null,
  reason text not null default 'invalidated',
  deleted_at timestamptz not null,
  updated_at timestamptz not null default now(),
  revision bigint not null default 1,
  change_seq bigint not null default 0
);

-- The legacy trigger calls auth.uid() and rejects service-role writes. Remove
-- it before touching tombstone rows; a NEW-based compatible trigger is created
-- below after owner backfill and counter setup.
drop trigger if exists trg_apply_tracklog_deleted_event_tombstone on public.deleted_event_tombstones;
drop function if exists public.apply_tracklog_deleted_event_tombstone();

update public.deleted_trip_tombstones
set updated_at = deleted_at
where updated_at is distinct from deleted_at;

update public.deleted_event_tombstones
set updated_at = deleted_at
where updated_at is distinct from deleted_at;

-- Remove any draft v2 trigger/default before deterministic backfill. The
-- sequence is intentionally not used by the cursor protocol.
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'trip_headers',
    'trip_events',
    'trip_route_points',
    'report_snapshots',
    'deleted_trip_tombstones',
    'deleted_event_tombstones',
    'deleted_report_tombstones'
  ] loop
    execute format(
      'drop trigger if exists %I on public.%I',
      'tracklog_sync_touch_' || v_table,
      v_table
    );
  end loop;
end;
$$;

drop function if exists tracklog_private.touch_sync_row();

alter table public.trip_headers alter column change_seq drop default;
alter table public.trip_events alter column change_seq drop default;
alter table public.trip_route_points alter column change_seq drop default;
alter table public.report_snapshots alter column change_seq drop default;
alter table public.deleted_trip_tombstones alter column change_seq drop default;
alter table public.deleted_event_tombstones alter column change_seq drop default;
alter table public.deleted_report_tombstones alter column change_seq drop default;
drop sequence if exists public.tracklog_change_seq;

update public.trip_headers target
set owner_user_id = profile.auth_user_id
from public.device_profiles profile
where profile.device_id = target.device_id
  and target.owner_user_id is null;

update public.trip_events target
set owner_user_id = profile.auth_user_id
from public.device_profiles profile
where profile.device_id = target.device_id
  and target.owner_user_id is null;

update public.trip_route_points target
set owner_user_id = profile.auth_user_id
from public.device_profiles profile
where profile.device_id = target.device_id
  and target.owner_user_id is null;

update public.report_snapshots target
set owner_user_id = profile.auth_user_id
from public.device_profiles profile
where profile.device_id = target.device_id
  and target.owner_user_id is null;

update public.deleted_trip_tombstones target
set owner_user_id = profile.auth_user_id
from public.device_profiles profile
where profile.device_id = target.device_id
  and target.owner_user_id is null;

update public.deleted_event_tombstones target
set owner_user_id = profile.auth_user_id
from public.device_profiles profile
where profile.device_id = target.device_id
  and target.owner_user_id is null;

do $$
begin
  if exists (
    select 1
    from (
      select owner_user_id from public.trip_headers
      union all select owner_user_id from public.trip_events
      union all select owner_user_id from public.trip_route_points
      union all select owner_user_id from public.report_snapshots
      union all select owner_user_id from public.deleted_trip_tombstones
      union all select owner_user_id from public.deleted_event_tombstones
    ) rows
    where owner_user_id is null
  ) then
    raise exception 'TrackLog sync v2 owner backfill found orphan rows';
  end if;

  if exists (
    select owner_user_id
    from public.trip_headers
    where status = 'active'
    group by owner_user_id
    having count(*) > 1
  ) then
    raise exception 'TrackLog sync v2 found more than one active trip for an account';
  end if;
end;
$$;

alter table public.trip_headers alter column owner_user_id set not null;
alter table public.trip_events alter column owner_user_id set not null;
alter table public.trip_route_points alter column owner_user_id set not null;
alter table public.report_snapshots alter column owner_user_id set not null;
alter table public.deleted_trip_tombstones alter column owner_user_id set not null;
alter table public.deleted_event_tombstones alter column owner_user_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'device_profiles_device_owner_key'
  ) then
    alter table public.device_profiles
      add constraint device_profiles_device_owner_key unique (device_id, auth_user_id);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'trip_headers_trip_device_owner_key'
  ) then
    alter table public.trip_headers
      add constraint trip_headers_trip_device_owner_key
      unique (trip_id, device_id, owner_user_id);
  end if;
end;
$$;

-- Replace legacy ON DELETE CASCADE device constraints. Device migration may
-- change device_id, but deleting a profile must never erase driving history.
alter table public.trip_headers drop constraint if exists trip_headers_device_id_fkey;
alter table public.trip_events drop constraint if exists trip_events_device_id_fkey;
alter table public.trip_events drop constraint if exists trip_events_trip_id_fkey;
alter table public.trip_route_points drop constraint if exists trip_route_points_device_id_fkey;
alter table public.trip_route_points drop constraint if exists trip_route_points_trip_id_fkey;
alter table public.report_snapshots drop constraint if exists report_snapshots_device_id_fkey;
alter table public.report_snapshots drop constraint if exists report_snapshots_trip_id_fkey;
alter table public.deleted_trip_tombstones drop constraint if exists deleted_trip_tombstones_device_id_fkey;
alter table public.deleted_event_tombstones drop constraint if exists deleted_event_tombstones_device_id_fkey;

alter table public.trip_headers drop constraint if exists trip_headers_device_owner_fkey;
alter table public.trip_events drop constraint if exists trip_events_trip_device_owner_fkey;
alter table public.trip_route_points drop constraint if exists trip_route_points_trip_device_owner_fkey;
alter table public.report_snapshots drop constraint if exists report_snapshots_trip_device_owner_fkey;
alter table public.deleted_trip_tombstones drop constraint if exists deleted_trip_tombstones_device_owner_fkey;
alter table public.deleted_event_tombstones drop constraint if exists deleted_event_tombstones_device_owner_fkey;

alter table public.trip_headers
  add constraint trip_headers_device_owner_fkey
  foreign key (device_id, owner_user_id)
  references public.device_profiles (device_id, auth_user_id)
  on update cascade on delete restrict not valid;

alter table public.trip_events
  add constraint trip_events_trip_device_owner_fkey
  foreign key (trip_id, device_id, owner_user_id)
  references public.trip_headers (trip_id, device_id, owner_user_id)
  on update cascade on delete cascade not valid;

alter table public.trip_route_points
  add constraint trip_route_points_trip_device_owner_fkey
  foreign key (trip_id, device_id, owner_user_id)
  references public.trip_headers (trip_id, device_id, owner_user_id)
  on update cascade on delete cascade not valid;

alter table public.report_snapshots
  add constraint report_snapshots_trip_device_owner_fkey
  foreign key (trip_id, device_id, owner_user_id)
  references public.trip_headers (trip_id, device_id, owner_user_id)
  on update cascade on delete cascade not valid;

alter table public.deleted_trip_tombstones
  add constraint deleted_trip_tombstones_device_owner_fkey
  foreign key (device_id, owner_user_id)
  references public.device_profiles (device_id, auth_user_id)
  on update cascade on delete restrict not valid;

alter table public.deleted_event_tombstones
  add constraint deleted_event_tombstones_device_owner_fkey
  foreign key (device_id, owner_user_id)
  references public.device_profiles (device_id, auth_user_id)
  on update cascade on delete restrict not valid;

alter table public.deleted_report_tombstones
  add constraint deleted_report_tombstones_device_owner_fkey
  foreign key (device_id, owner_user_id)
  references public.device_profiles (device_id, auth_user_id)
  on update cascade on delete restrict not valid;

alter table public.trip_headers validate constraint trip_headers_device_owner_fkey;
alter table public.trip_events validate constraint trip_events_trip_device_owner_fkey;
alter table public.trip_route_points validate constraint trip_route_points_trip_device_owner_fkey;
alter table public.report_snapshots validate constraint report_snapshots_trip_device_owner_fkey;
alter table public.deleted_trip_tombstones validate constraint deleted_trip_tombstones_device_owner_fkey;
alter table public.deleted_event_tombstones validate constraint deleted_event_tombstones_device_owner_fkey;
alter table public.deleted_report_tombstones validate constraint deleted_report_tombstones_device_owner_fkey;

create table public.tracklog_sync_counters (
  owner_user_id uuid primary key references auth.users(id) on delete cascade,
  last_change_seq bigint not null default 0 check (last_change_seq >= 0),
  updated_at timestamptz not null default now()
);

-- Backfill one total order per owner across every change-feed table.
create temporary table tracklog_sync_v2_backfill on commit drop as
select
  table_name,
  entity_id,
  owner_user_id,
  row_number() over (
    partition by owner_user_id
    order by changed_at, table_name, entity_id
  )::bigint as change_seq
from (
  select 'trip_headers'::text table_name, trip_id entity_id, owner_user_id, updated_at changed_at
  from public.trip_headers
  union all
  select 'trip_events', id, owner_user_id, updated_at
  from public.trip_events
  union all
  select 'trip_route_points', id, owner_user_id, updated_at
  from public.trip_route_points
  union all
  select 'report_snapshots', trip_id, owner_user_id, updated_at
  from public.report_snapshots
  union all
  select 'deleted_trip_tombstones', trip_id, owner_user_id, updated_at
  from public.deleted_trip_tombstones
  union all
  select 'deleted_event_tombstones', event_id, owner_user_id, updated_at
  from public.deleted_event_tombstones
  union all
  select 'deleted_report_tombstones', trip_id, owner_user_id, updated_at
  from public.deleted_report_tombstones
) source_rows;

update public.trip_headers target
set change_seq = source.change_seq
from tracklog_sync_v2_backfill source
where source.table_name = 'trip_headers'
  and source.entity_id = target.trip_id;

update public.trip_events target
set change_seq = source.change_seq
from tracklog_sync_v2_backfill source
where source.table_name = 'trip_events'
  and source.entity_id = target.id;

update public.trip_route_points target
set change_seq = source.change_seq
from tracklog_sync_v2_backfill source
where source.table_name = 'trip_route_points'
  and source.entity_id = target.id;

update public.report_snapshots target
set change_seq = source.change_seq
from tracklog_sync_v2_backfill source
where source.table_name = 'report_snapshots'
  and source.entity_id = target.trip_id;

update public.deleted_trip_tombstones target
set change_seq = source.change_seq
from tracklog_sync_v2_backfill source
where source.table_name = 'deleted_trip_tombstones'
  and source.entity_id = target.trip_id;

update public.deleted_event_tombstones target
set change_seq = source.change_seq
from tracklog_sync_v2_backfill source
where source.table_name = 'deleted_event_tombstones'
  and source.entity_id = target.event_id;

update public.deleted_report_tombstones target
set change_seq = source.change_seq
from tracklog_sync_v2_backfill source
where source.table_name = 'deleted_report_tombstones'
  and source.entity_id = target.trip_id;

insert into public.tracklog_sync_counters (owner_user_id, last_change_seq)
select owner_user_id, max(change_seq)
from tracklog_sync_v2_backfill
group by owner_user_id;

create table public.tracklog_sync_mutations (
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  mutation_id uuid not null,
  device_id text not null,
  entity_type text not null,
  entity_id text not null,
  response_json jsonb not null,
  processed_at timestamptz not null default now(),
  primary key (owner_user_id, mutation_id),
  constraint tracklog_sync_mutations_device_owner_fkey
    foreign key (device_id, owner_user_id)
    references public.device_profiles (device_id, auth_user_id)
    on update cascade on delete restrict
);

create unique index idx_tracklog_one_active_trip_per_owner
  on public.trip_headers (owner_user_id)
  where status = 'active';

create index idx_trip_headers_owner_change
  on public.trip_headers (owner_user_id, change_seq);
create index idx_trip_events_owner_change
  on public.trip_events (owner_user_id, change_seq);
create index idx_trip_route_points_owner_change
  on public.trip_route_points (owner_user_id, change_seq);
create index idx_report_snapshots_owner_change
  on public.report_snapshots (owner_user_id, change_seq);
create index idx_deleted_trip_tombstones_owner_change
  on public.deleted_trip_tombstones (owner_user_id, change_seq);
create index idx_deleted_event_tombstones_owner_change
  on public.deleted_event_tombstones (owner_user_id, change_seq);
create index idx_deleted_report_tombstones_owner_change
  on public.deleted_report_tombstones (owner_user_id, change_seq);
create index idx_tracklog_sync_mutations_processed
  on public.tracklog_sync_mutations (processed_at);
create index idx_tracklog_trip_headers_device_owner
  on public.trip_headers (device_id, owner_user_id);
create index idx_tracklog_trip_events_trip_device_owner
  on public.trip_events (trip_id, device_id, owner_user_id);
create index idx_tracklog_route_points_trip_device_owner
  on public.trip_route_points (trip_id, device_id, owner_user_id);
create index idx_tracklog_reports_trip_device_owner
  on public.report_snapshots (trip_id, device_id, owner_user_id);
create index idx_tracklog_deleted_trips_device_owner
  on public.deleted_trip_tombstones (device_id, owner_user_id);
create index idx_tracklog_deleted_events_device_owner
  on public.deleted_event_tombstones (device_id, owner_user_id);
create index idx_tracklog_deleted_reports_device_owner
  on public.deleted_report_tombstones (device_id, owner_user_id);
create index idx_tracklog_mutations_device_owner
  on public.tracklog_sync_mutations (device_id, owner_user_id);

alter table public.tracklog_sync_counters enable row level security;
alter table public.tracklog_sync_mutations enable row level security;
alter table public.deleted_report_tombstones enable row level security;

revoke all on table public.tracklog_sync_counters from public, anon, authenticated;
revoke all on table public.tracklog_sync_mutations from public, anon, authenticated;
revoke all on table public.deleted_report_tombstones from public, anon, authenticated;
grant select, insert, update, delete on table public.tracklog_sync_counters to service_role;
grant select, insert, update, delete on table public.tracklog_sync_mutations to service_role;
grant select, insert, update, delete on table public.deleted_report_tombstones to service_role;

create or replace function tracklog_private.next_tracklog_change_seq(_owner_user_id uuid)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, tracklog_private
as $$
declare
  v_next bigint;
begin
  if _owner_user_id is null then
    raise exception 'owner_user_id is required' using errcode = '23502';
  end if;

  insert into public.tracklog_sync_counters (owner_user_id, last_change_seq)
  values (_owner_user_id, 0)
  on conflict (owner_user_id) do nothing;

  update public.tracklog_sync_counters
  set last_change_seq = last_change_seq + 1,
      updated_at = clock_timestamp()
  where owner_user_id = _owner_user_id
  returning last_change_seq into v_next;

  if v_next is null then
    raise exception 'could not allocate TrackLog change sequence';
  end if;
  return v_next;
end;
$$;

create or replace function tracklog_private.touch_sync_row()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, tracklog_private
as $$
declare
  v_profile_owner uuid;
begin
  if new.owner_user_id is null then
    select profile.auth_user_id
    into v_profile_owner
    from public.device_profiles profile
    where profile.device_id = new.device_id;
    new.owner_user_id := v_profile_owner;
  end if;

  select profile.auth_user_id
  into v_profile_owner
  from public.device_profiles profile
  where profile.device_id = new.device_id;

  if v_profile_owner is null or v_profile_owner <> new.owner_user_id then
    raise exception 'device owner does not match sync row owner' using errcode = '23503';
  end if;

  if tg_op = 'UPDATE' then
    if new.owner_user_id <> old.owner_user_id then
      raise exception 'sync row owner is immutable' using errcode = '42501';
    end if;
    new.revision := old.revision + 1;
  else
    new.revision := 1;
  end if;

  new.change_seq := tracklog_private.next_tracklog_change_seq(new.owner_user_id);
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'trip_headers',
    'trip_events',
    'trip_route_points',
    'report_snapshots',
    'deleted_trip_tombstones',
    'deleted_event_tombstones',
    'deleted_report_tombstones'
  ] loop
    execute format(
      'create trigger %I before insert or update on public.%I for each row execute function tracklog_private.touch_sync_row()',
      'tracklog_sync_touch_' || v_table,
      v_table
    );
  end loop;
end;
$$;

revoke all on function tracklog_private.next_tracklog_change_seq(uuid) from public, anon, authenticated;
revoke all on function tracklog_private.touch_sync_row() from public, anon, authenticated;

create or replace function tracklog_private.strict_sync_timestamp(
  _value jsonb,
  _field_name text,
  _required boolean default true
)
returns timestamptz
language plpgsql
immutable
security invoker
set search_path = pg_catalog
as $$
declare
  v_text text;
  v_result timestamptz;
begin
  if _value is null or jsonb_typeof(_value) = 'null' then
    if _required then
      raise exception '% is required', _field_name using errcode = '22023';
    end if;
    return null;
  end if;

  if jsonb_typeof(_value) <> 'string' then
    raise exception '% must be an ISO-8601 string', _field_name using errcode = '22023';
  end if;

  v_text := _value #>> '{}';
  if v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' then
    raise exception '% must be a complete ISO-8601 timestamp', _field_name using errcode = '22023';
  end if;

  v_result := v_text::timestamptz;
  if not isfinite(v_result) then
    raise exception '% must be finite', _field_name using errcode = '22023';
  end if;
  return v_result;
exception
  when invalid_datetime_format or datetime_field_overflow then
    raise exception '% is not a valid timestamp', _field_name using errcode = '22023';
end;
$$;

create or replace function tracklog_private.strict_sync_integer(
  _value jsonb,
  _field_name text,
  _required boolean default true
)
returns integer
language plpgsql
immutable
security invoker
set search_path = pg_catalog
as $$
declare
  v_text text;
  v_result bigint;
begin
  if _value is null or jsonb_typeof(_value) = 'null' then
    if _required then
      raise exception '% is required', _field_name using errcode = '22023';
    end if;
    return null;
  end if;

  if jsonb_typeof(_value) <> 'number' then
    raise exception '% must be an integer', _field_name using errcode = '22023';
  end if;
  v_text := _value #>> '{}';
  if v_text !~ '^(0|[1-9][0-9]*)$' then
    raise exception '% must be a non-negative integer', _field_name using errcode = '22023';
  end if;
  v_result := v_text::bigint;
  if v_result > 2147483647 then
    raise exception '% exceeds the supported range', _field_name using errcode = '22023';
  end if;
  return v_result::integer;
exception
  when numeric_value_out_of_range then
    raise exception '% exceeds the supported range', _field_name using errcode = '22023';
end;
$$;

create or replace function tracklog_private.strict_sync_float(
  _value jsonb,
  _field_name text,
  _required boolean default true
)
returns double precision
language plpgsql
immutable
security invoker
set search_path = pg_catalog
as $$
declare
  v_result double precision;
begin
  if _value is null or jsonb_typeof(_value) = 'null' then
    if _required then
      raise exception '% is required', _field_name using errcode = '22023';
    end if;
    return null;
  end if;

  if jsonb_typeof(_value) <> 'number' then
    raise exception '% must be numeric', _field_name using errcode = '22023';
  end if;
  v_result := (_value #>> '{}')::double precision;
  if v_result::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception '% must be finite', _field_name using errcode = '22023';
  end if;
  return v_result;
exception
  when numeric_value_out_of_range or invalid_text_representation then
    raise exception '% must be a finite number', _field_name using errcode = '22023';
end;
$$;

create or replace function tracklog_private.invalidate_tracklog_report(
  _owner_user_id uuid,
  _trip_id text,
  _device_id text,
  _reason text,
  _deleted_at timestamptz default clock_timestamp()
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, tracklog_private
as $$
begin
  if _owner_user_id is null or nullif(btrim(_trip_id), '') is null
     or nullif(btrim(_device_id), '') is null then
    raise exception 'report invalidation identity is incomplete' using errcode = '22023';
  end if;

  insert into public.deleted_report_tombstones (
    trip_id,
    device_id,
    owner_user_id,
    reason,
    deleted_at
  )
  values (
    _trip_id,
    _device_id,
    _owner_user_id,
    left(coalesce(nullif(btrim(_reason), ''), 'invalidated'), 80),
    _deleted_at
  )
  on conflict (trip_id) do update
  set device_id = excluded.device_id,
      owner_user_id = excluded.owner_user_id,
      reason = excluded.reason,
      deleted_at = excluded.deleted_at;

  delete from public.report_snapshots report
  where report.trip_id = _trip_id
    and report.owner_user_id = _owner_user_id;
end;
$$;

create or replace function tracklog_private.invalidate_report_after_event_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, tracklog_private
as $$
begin
  if tg_op = 'INSERT'
     or new.trip_id is distinct from old.trip_id
     or new.type is distinct from old.type
     or new.ts is distinct from old.ts
     or new.address is distinct from old.address
     or new.geo is distinct from old.geo
     or new.extras is distinct from old.extras then
    perform tracklog_private.invalidate_tracklog_report(
      new.owner_user_id,
      new.trip_id,
      new.device_id,
      'event_changed',
      clock_timestamp()
    );
  end if;
  return new;
end;
$$;

create or replace function tracklog_private.clear_report_tombstone_after_upsert()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, tracklog_private
as $$
declare
  v_tombstone public.deleted_report_tombstones%rowtype;
  v_expected_token text;
  v_legacy_owner_restore boolean := false;
begin
  select * into v_tombstone
  from public.deleted_report_tombstones tombstone
  where tombstone.trip_id = new.trip_id
    and tombstone.owner_user_id = new.owner_user_id
  for update;

  if found then
    v_expected_token := new.trip_id || ':' || v_tombstone.change_seq::text;
    if current_setting('tracklog.report_restore_token', true) is distinct from v_expected_token then
      select exists (
        select 1
        from public.device_profiles profile
        where profile.device_id = new.device_id
          and profile.auth_user_id = new.owner_user_id
          and profile.auth_user_id = auth.uid()
          and profile.approval_status = 'approved'
          and profile.sync_protocol_version = 1
          and v_tombstone.reason = 'event_changed'
      ) into v_legacy_owner_restore;

      if not v_legacy_owner_restore then
        raise exception 'report restore requires the latest tombstone token' using errcode = '40001';
      end if;
    end if;
  end if;

  delete from public.deleted_report_tombstones tombstone
  where tombstone.trip_id = new.trip_id
    and tombstone.owner_user_id = new.owner_user_id;
  perform set_config('tracklog.report_restore_token', '', true);
  return new;
end;
$$;

create or replace function tracklog_private.guard_terminal_trip_tombstone()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, tracklog_private
as $$
begin
  if exists (
    select 1
    from public.deleted_trip_tombstones tombstone
    where tombstone.trip_id = new.trip_id
  ) then
    raise exception 'trip was permanently deleted' using errcode = '40001';
  end if;
  return new;
end;
$$;

create or replace function tracklog_private.guard_terminal_event_tombstone()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, tracklog_private
as $$
begin
  if exists (
    select 1
    from public.deleted_trip_tombstones tombstone
    where tombstone.trip_id = new.trip_id
  ) or exists (
    select 1
    from public.deleted_event_tombstones tombstone
    where tombstone.event_id = new.id
  ) then
    raise exception 'event or parent trip was permanently deleted' using errcode = '40001';
  end if;
  return new;
end;
$$;

create or replace function tracklog_private.guard_terminal_route_anchor()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, tracklog_private
as $$
begin
  if new.id like 'event-anchor-%'
     and exists (
       select 1
       from public.deleted_event_tombstones tombstone
       where tombstone.event_id = substring(new.id from 14)
     ) then
    raise exception 'event route anchor was permanently deleted' using errcode = '40001';
  end if;
  return new;
end;
$$;

create or replace function tracklog_private.apply_event_tombstone()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, tracklog_private
as $$
begin
  if tg_op = 'UPDATE' and new.deleted_by is distinct from old.deleted_by then
    raise exception 'event tombstone actor is immutable' using errcode = '42501';
  end if;
  if tg_op = 'INSERT'
     and new.deleted_by <> new.owner_user_id
     and (auth.uid() is null or new.deleted_by <> auth.uid())
     and current_setting('tracklog.admin_delete_actor', true) is distinct from new.deleted_by::text then
    raise exception 'event tombstone actor does not match its owner or JWT user'
      using errcode = '42501';
  end if;

  perform tracklog_private.invalidate_tracklog_report(
    new.owner_user_id,
    new.trip_id,
    new.device_id,
    'event_deleted',
    new.deleted_at
  );

  delete from public.trip_route_points point
  where point.id = 'event-anchor-' || new.event_id
    and point.owner_user_id = new.owner_user_id;

  delete from public.trip_events event
  where event.id = new.event_id
    and event.owner_user_id = new.owner_user_id;
  return new;
end;
$$;

create or replace function tracklog_private.apply_trip_tombstone()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, tracklog_private
as $$
begin
  if tg_op = 'UPDATE' and new.deleted_by is distinct from old.deleted_by then
    raise exception 'trip tombstone actor is immutable' using errcode = '42501';
  end if;
  if tg_op = 'INSERT'
     and new.deleted_by <> new.owner_user_id
     and (auth.uid() is null or new.deleted_by <> auth.uid())
     and current_setting('tracklog.admin_delete_actor', true) is distinct from new.deleted_by::text then
    raise exception 'trip tombstone actor does not match its owner or JWT user'
      using errcode = '42501';
  end if;

  delete from public.trip_headers trip
  where trip.trip_id = new.trip_id
    and trip.owner_user_id = new.owner_user_id;
  return new;
end;
$$;

drop trigger if exists trg_tracklog_invalidate_report_after_event_change on public.trip_events;
create trigger trg_tracklog_invalidate_report_after_event_change
after insert or update on public.trip_events
for each row execute function tracklog_private.invalidate_report_after_event_change();

drop trigger if exists trg_tracklog_clear_report_tombstone_after_upsert on public.report_snapshots;
create trigger trg_tracklog_clear_report_tombstone_after_upsert
after insert or update on public.report_snapshots
for each row execute function tracklog_private.clear_report_tombstone_after_upsert();

drop trigger if exists trg_tracklog_guard_terminal_trip_tombstone on public.trip_headers;
create trigger trg_tracklog_guard_terminal_trip_tombstone
before insert or update on public.trip_headers
for each row execute function tracklog_private.guard_terminal_trip_tombstone();

drop trigger if exists trg_tracklog_guard_terminal_event_tombstone on public.trip_events;
create trigger trg_tracklog_guard_terminal_event_tombstone
before insert or update on public.trip_events
for each row execute function tracklog_private.guard_terminal_event_tombstone();

drop trigger if exists trg_tracklog_guard_terminal_route_anchor on public.trip_route_points;
create trigger trg_tracklog_guard_terminal_route_anchor
before insert or update on public.trip_route_points
for each row execute function tracklog_private.guard_terminal_route_anchor();

drop trigger if exists trg_apply_tracklog_deleted_event_tombstone on public.deleted_event_tombstones;
drop function if exists public.apply_tracklog_deleted_event_tombstone();
create trigger trg_apply_tracklog_deleted_event_tombstone
after insert or update on public.deleted_event_tombstones
for each row execute function tracklog_private.apply_event_tombstone();

drop trigger if exists trg_apply_tracklog_deleted_trip_tombstone on public.deleted_trip_tombstones;
create trigger trg_apply_tracklog_deleted_trip_tombstone
after insert or update on public.deleted_trip_tombstones
for each row execute function tracklog_private.apply_trip_tombstone();

revoke all on function tracklog_private.strict_sync_timestamp(jsonb, text, boolean) from public, anon, authenticated;
revoke all on function tracklog_private.strict_sync_integer(jsonb, text, boolean) from public, anon, authenticated;
revoke all on function tracklog_private.strict_sync_float(jsonb, text, boolean) from public, anon, authenticated;
revoke all on function tracklog_private.invalidate_tracklog_report(uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function tracklog_private.invalidate_report_after_event_change() from public, anon, authenticated;
revoke all on function tracklog_private.clear_report_tombstone_after_upsert() from public, anon, authenticated;
revoke all on function tracklog_private.guard_terminal_trip_tombstone() from public, anon, authenticated;
revoke all on function tracklog_private.guard_terminal_event_tombstone() from public, anon, authenticated;
revoke all on function tracklog_private.guard_terminal_route_anchor() from public, anon, authenticated;
revoke all on function tracklog_private.apply_event_tombstone() from public, anon, authenticated;
revoke all on function tracklog_private.apply_trip_tombstone() from public, anon, authenticated;

create or replace function public.tracklog_admin_delete_trip_v2(
  _actor_user_id uuid,
  _trip_id text
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, tracklog_private, auth
as $$
declare
  v_trip public.trip_headers%rowtype;
begin
  if _actor_user_id is null or nullif(btrim(_trip_id), '') is null then
    raise exception 'actor and trip_id are required' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from auth.users account
    join public.admin_users admin
      on lower(admin.email) = lower(account.email)
    where account.id = _actor_user_id
      and admin.enabled = true
  ) then
    raise exception 'admin privileges are required' using errcode = '42501';
  end if;

  select * into v_trip
  from public.trip_headers trip
  where trip.trip_id = btrim(_trip_id)
  for update;
  if not found then
    return 0;
  end if;

  perform set_config('tracklog.admin_delete_actor', _actor_user_id::text, true);
  insert into public.deleted_trip_tombstones (
    trip_id,
    device_id,
    owner_user_id,
    deleted_by,
    deleted_at
  ) values (
    v_trip.trip_id,
    v_trip.device_id,
    v_trip.owner_user_id,
    _actor_user_id,
    clock_timestamp()
  )
  on conflict (trip_id) do nothing;
  perform set_config('tracklog.admin_delete_actor', '', true);
  return 1;
end;
$$;

revoke all on function public.tracklog_admin_delete_trip_v2(uuid, text) from public, anon, authenticated;
grant execute on function public.tracklog_admin_delete_trip_v2(uuid, text) to service_role;

create or replace function tracklog_private.apply_tracklog_sync_mutation(
  _owner_user_id uuid,
  _device_id text,
  _mutation jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, tracklog_private
as $$
declare
  v_mutation_id text := coalesce(_mutation ->> 'mutationId', '');
  v_entity_type text := coalesce(_mutation ->> 'entityType', '');
  v_entity_id text := btrim(coalesce(_mutation ->> 'entityId', ''));
  v_operation text := coalesce(_mutation ->> 'operation', '');
  v_payload jsonb;
  v_base_revision bigint;
  v_ack jsonb;
  v_current jsonb;
  v_trip public.trip_headers%rowtype;
  v_event public.trip_events%rowtype;
  v_point public.trip_route_points%rowtype;
  v_report public.report_snapshots%rowtype;
  v_trip_tombstone public.deleted_trip_tombstones%rowtype;
  v_event_tombstone public.deleted_event_tombstones%rowtype;
  v_report_tombstone public.deleted_report_tombstones%rowtype;
  v_has_trip boolean;
  v_has_event boolean;
  v_has_point boolean;
  v_has_report boolean;
  v_has_trip_tombstone boolean;
  v_has_event_tombstone boolean;
  v_has_report_tombstone boolean;
  v_trip_id text;
  v_event_type text;
  v_status text;
  v_source text;
  v_address text;
  v_label text;
  v_start_ts timestamptz;
  v_end_ts timestamptz;
  v_event_ts timestamptz;
  v_created_at timestamptz;
  v_deleted_at timestamptz;
  v_odo_start integer;
  v_odo_end integer;
  v_total_km integer;
  v_last_leg_km integer;
  v_lat double precision;
  v_lng double precision;
  v_accuracy double precision;
  v_speed double precision;
  v_heading double precision;
  v_geo jsonb;
  v_extras jsonb;
  v_report_payload jsonb;
  v_revision bigint;
  v_change_seq bigint;
  v_restore_from_change_seq bigint;
begin
  v_ack := jsonb_build_object(
    'mutationId', v_mutation_id,
    'entityType', v_entity_type,
    'entityId', v_entity_id
  );

  if jsonb_typeof(_mutation) is distinct from 'object' then
    return v_ack || jsonb_build_object('status', 'rejected', 'message', 'Mutation must be an object');
  end if;
  if length(v_entity_id) < 1 or length(v_entity_id) > 180 or v_entity_id ~ '[[:cntrl:]]' then
    return v_ack || jsonb_build_object('status', 'rejected', 'message', 'Invalid entityId');
  end if;
  if v_entity_type not in ('trip', 'event', 'routePoint', 'report', 'tripDelete', 'eventDelete', 'reportDelete') then
    return v_ack || jsonb_build_object('status', 'rejected', 'message', 'Unsupported entityType');
  end if;
  if v_operation not in ('upsert', 'delete') then
    return v_ack || jsonb_build_object('status', 'rejected', 'message', 'Unsupported operation');
  end if;
  if (v_entity_type in ('trip', 'event', 'routePoint') and v_operation <> 'upsert')
     or (v_entity_type in ('tripDelete', 'eventDelete', 'reportDelete') and v_operation <> 'delete') then
    return v_ack || jsonb_build_object('status', 'rejected', 'message', 'Operation does not match entityType');
  end if;

  if _mutation ? 'baseRevision'
     and jsonb_typeof(_mutation -> 'baseRevision') <> 'null' then
    if jsonb_typeof(_mutation -> 'baseRevision') <> 'number'
       or (_mutation ->> 'baseRevision') !~ '^(0|[1-9][0-9]*)$' then
      return v_ack || jsonb_build_object('status', 'rejected', 'message', 'baseRevision must be a non-negative integer');
    end if;
    begin
      v_base_revision := (_mutation ->> 'baseRevision')::bigint;
    exception
      when numeric_value_out_of_range then
        return v_ack || jsonb_build_object('status', 'rejected', 'message', 'baseRevision exceeds the supported range');
    end;
  end if;

  if not (_mutation ? 'payload') or jsonb_typeof(_mutation -> 'payload') = 'null' then
    v_payload := '{}'::jsonb;
  elsif jsonb_typeof(_mutation -> 'payload') = 'object' then
    v_payload := _mutation -> 'payload';
  else
    return v_ack || jsonb_build_object('status', 'rejected', 'message', 'payload must be an object');
  end if;
  if pg_column_size(v_payload) > 2500000 then
    return v_ack || jsonb_build_object('status', 'rejected', 'message', 'payload is too large');
  end if;

  begin
    if v_entity_type = 'trip' then
      v_start_ts := tracklog_private.strict_sync_timestamp(v_payload -> 'start_ts', 'start_ts');
      v_end_ts := tracklog_private.strict_sync_timestamp(v_payload -> 'end_ts', 'end_ts', false);
      if v_end_ts is not null and v_end_ts < v_start_ts then
        raise exception 'end_ts must not precede start_ts' using errcode = '22023';
      end if;
      v_odo_start := tracklog_private.strict_sync_integer(v_payload -> 'odo_start', 'odo_start');
      v_odo_end := tracklog_private.strict_sync_integer(v_payload -> 'odo_end', 'odo_end', false);
      v_total_km := tracklog_private.strict_sync_integer(v_payload -> 'total_km', 'total_km', false);
      v_last_leg_km := tracklog_private.strict_sync_integer(v_payload -> 'last_leg_km', 'last_leg_km', false);
      v_status := v_payload ->> 'status';
      if v_status is null or v_status not in ('active', 'closed') then
        raise exception 'status must be active or closed' using errcode = '22023';
      end if;

      select * into v_trip_tombstone
      from public.deleted_trip_tombstones
      where trip_id = v_entity_id
      for share;
      v_has_trip_tombstone := found;
      if v_has_trip_tombstone then
        if v_trip_tombstone.owner_user_id <> _owner_user_id then
          return v_ack || jsonb_build_object('status', 'rejected', 'message', 'Entity belongs to another account');
        end if;
        return v_ack || jsonb_build_object(
          'status', 'deleted',
          'revision', v_trip_tombstone.revision,
          'changeSeq', v_trip_tombstone.change_seq,
          'message', 'Trip was permanently deleted'
        );
      end if;

      select * into v_trip
      from public.trip_headers
      where trip_id = v_entity_id
      for update;
      v_has_trip := found;
      if v_has_trip and v_trip.owner_user_id <> _owner_user_id then
        return v_ack || jsonb_build_object('status', 'rejected', 'message', 'Entity belongs to another account');
      end if;

      if v_has_trip then
        if v_base_revision is null or v_base_revision <> v_trip.revision then
          return v_ack || jsonb_build_object(
            'status', 'conflict',
            'revision', v_trip.revision,
            'changeSeq', v_trip.change_seq,
            'message', 'A newer cloud revision already exists',
            'currentRow', to_jsonb(v_trip)
          );
        end if;
        begin
          update public.trip_headers
          set start_ts = v_start_ts,
              end_ts = v_end_ts,
              odo_start = v_odo_start,
              odo_end = v_odo_end,
              total_km = v_total_km,
              last_leg_km = v_last_leg_km,
              status = v_status
          where trip_id = v_entity_id
            and owner_user_id = _owner_user_id
            and revision = v_base_revision
          returning revision, change_seq into v_revision, v_change_seq;
        exception
          when unique_violation then
            select to_jsonb(active_trip), active_trip.revision, active_trip.change_seq
            into v_current, v_revision, v_change_seq
            from public.trip_headers active_trip
            where active_trip.owner_user_id = _owner_user_id
              and active_trip.status = 'active'
            limit 1;
            return v_ack || jsonb_build_object(
              'status', 'conflict',
              'revision', v_revision,
              'changeSeq', v_change_seq,
              'message', 'Another active trip already exists',
              'currentRow', v_current
            );
        end;
        if v_revision is null then
          select * into v_trip from public.trip_headers where trip_id = v_entity_id;
          return v_ack || jsonb_build_object(
            'status', 'conflict',
            'revision', v_trip.revision,
            'changeSeq', v_trip.change_seq,
            'message', 'A newer cloud revision already exists',
            'currentRow', to_jsonb(v_trip)
          );
        end if;
      else
        if coalesce(v_base_revision, 0) <> 0 then
          return v_ack || jsonb_build_object('status', 'conflict', 'message', 'Cloud trip no longer exists');
        end if;
        begin
          insert into public.trip_headers (
            trip_id, device_id, owner_user_id, start_ts, end_ts,
            odo_start, odo_end, total_km, last_leg_km, status
          ) values (
            v_entity_id, _device_id, _owner_user_id, v_start_ts, v_end_ts,
            v_odo_start, v_odo_end, v_total_km, v_last_leg_km, v_status
          )
          returning revision, change_seq into v_revision, v_change_seq;
        exception
          when unique_violation then
            select to_jsonb(active_trip), active_trip.revision, active_trip.change_seq
            into v_current, v_revision, v_change_seq
            from public.trip_headers active_trip
            where active_trip.owner_user_id = _owner_user_id
              and active_trip.status = 'active'
            limit 1;
            return v_ack || jsonb_build_object(
              'status', 'conflict',
              'revision', v_revision,
              'changeSeq', v_change_seq,
              'message', 'Another active trip already exists',
              'currentRow', v_current
            );
        end;
      end if;
      return v_ack || jsonb_build_object('status', 'applied', 'revision', v_revision, 'changeSeq', v_change_seq);

    elsif v_entity_type = 'event' then
      v_trip_id := btrim(coalesce(v_payload ->> 'trip_id', ''));
      v_event_type := v_payload ->> 'type';
      if length(v_trip_id) < 1 or length(v_trip_id) > 180 or v_trip_id ~ '[[:cntrl:]]' then
        raise exception 'trip_id is required' using errcode = '22023';
      end if;
      if v_event_type is null or v_event_type not in (
        'trip_start', 'trip_end', 'rest_start', 'rest_end', 'break_start', 'break_end',
        'load_start', 'load_end', 'unload_start', 'unload_end', 'refuel', 'boarding',
        'disembark', 'expressway', 'expressway_start', 'expressway_end', 'point_mark'
      ) then
        raise exception 'Unsupported event type' using errcode = '22023';
      end if;
      v_event_ts := tracklog_private.strict_sync_timestamp(v_payload -> 'ts', 'ts');

      if v_payload ? 'address' and jsonb_typeof(v_payload -> 'address') <> 'null' then
        if jsonb_typeof(v_payload -> 'address') <> 'string' then
          raise exception 'address must be a string' using errcode = '22023';
        end if;
        v_address := nullif(btrim(v_payload ->> 'address'), '');
        if length(v_address) > 500 then
          raise exception 'address is too long' using errcode = '22023';
        end if;
      end if;

      if v_payload ? 'geo' and jsonb_typeof(v_payload -> 'geo') <> 'null' then
        v_geo := v_payload -> 'geo';
        if jsonb_typeof(v_geo) <> 'object' or pg_column_size(v_geo) > 4096 then
          raise exception 'geo must be a small object' using errcode = '22023';
        end if;
        v_lat := tracklog_private.strict_sync_float(v_geo -> 'lat', 'geo.lat');
        v_lng := tracklog_private.strict_sync_float(v_geo -> 'lng', 'geo.lng');
        v_accuracy := tracklog_private.strict_sync_float(v_geo -> 'accuracy', 'geo.accuracy', false);
        if v_lat < -90 or v_lat > 90 or v_lng < -180 or v_lng > 180
           or (v_accuracy is not null and (v_accuracy < 0 or v_accuracy > 100000)) then
          raise exception 'geo coordinates are outside the supported range' using errcode = '22023';
        end if;
        v_geo := jsonb_strip_nulls(jsonb_build_object('lat', v_lat, 'lng', v_lng, 'accuracy', v_accuracy));
      else
        v_geo := null;
      end if;

      if v_payload ? 'extras' and jsonb_typeof(v_payload -> 'extras') <> 'null' then
        v_extras := v_payload -> 'extras';
        if jsonb_typeof(v_extras) <> 'object' or pg_column_size(v_extras) > 65536 then
          raise exception 'extras must be an object no larger than 64 KiB' using errcode = '22023';
        end if;
      else
        v_extras := null;
      end if;

      select * into v_trip_tombstone from public.deleted_trip_tombstones
      where trip_id = v_trip_id for share;
      v_has_trip_tombstone := found;
      if v_has_trip_tombstone then
        if v_trip_tombstone.owner_user_id <> _owner_user_id then
          return v_ack || jsonb_build_object('status', 'rejected', 'message', 'Trip belongs to another account');
        end if;
        return v_ack || jsonb_build_object(
          'status', 'deleted', 'revision', v_trip_tombstone.revision,
          'changeSeq', v_trip_tombstone.change_seq, 'message', 'Trip was permanently deleted'
        );
      end if;

      select * into v_event_tombstone from public.deleted_event_tombstones
      where event_id = v_entity_id for share;
      v_has_event_tombstone := found;
      if v_has_event_tombstone then
        if v_event_tombstone.owner_user_id <> _owner_user_id then
          return v_ack || jsonb_build_object('status', 'rejected', 'message', 'Entity belongs to another account');
        end if;
        return v_ack || jsonb_build_object(
          'status', 'deleted', 'revision', v_event_tombstone.revision,
          'changeSeq', v_event_tombstone.change_seq, 'message', 'Event was permanently deleted'
        );
      end if;

      select * into v_trip from public.trip_headers where trip_id = v_trip_id for share;
      v_has_trip := found;
      if not v_has_trip or v_trip.owner_user_id <> _owner_user_id then
        return v_ack || jsonb_build_object('status', 'conflict', 'message', 'Trip header is missing or belongs to another account');
      end if;

      select * into v_event from public.trip_events where id = v_entity_id for update;
      v_has_event := found;
      if v_has_event and v_event.owner_user_id <> _owner_user_id then
        return v_ack || jsonb_build_object('status', 'rejected', 'message', 'Entity belongs to another account');
      end if;
      if v_has_event and v_event.trip_id <> v_trip_id then
        return v_ack || jsonb_build_object('status', 'rejected', 'message', 'event trip_id is immutable');
      end if;

      if v_has_event then
        if v_base_revision is null or v_base_revision <> v_event.revision then
          return v_ack || jsonb_build_object(
            'status', 'conflict', 'revision', v_event.revision,
            'changeSeq', v_event.change_seq, 'message', 'A newer cloud revision already exists',
            'currentRow', to_jsonb(v_event)
          );
        end if;
        update public.trip_events
        set type = v_event_type,
            ts = v_event_ts,
            address = v_address,
            geo = v_geo,
            extras = v_extras,
            sync_status = 'synced'
        where id = v_entity_id
          and owner_user_id = _owner_user_id
          and revision = v_base_revision
        returning revision, change_seq into v_revision, v_change_seq;
        if v_revision is null then
          select * into v_event from public.trip_events where id = v_entity_id;
          return v_ack || jsonb_build_object(
            'status', 'conflict', 'revision', v_event.revision,
            'changeSeq', v_event.change_seq, 'message', 'A newer cloud revision already exists',
            'currentRow', to_jsonb(v_event)
          );
        end if;
      else
        if coalesce(v_base_revision, 0) <> 0 then
          return v_ack || jsonb_build_object('status', 'conflict', 'message', 'Cloud event no longer exists');
        end if;
        insert into public.trip_events (
          id, trip_id, device_id, owner_user_id, type, ts, address, geo, extras, sync_status
        ) values (
          v_entity_id, v_trip_id, v_trip.device_id, _owner_user_id,
          v_event_type, v_event_ts, v_address, v_geo, v_extras, 'synced'
        )
        returning revision, change_seq into v_revision, v_change_seq;
      end if;
      return v_ack || jsonb_build_object('status', 'applied', 'revision', v_revision, 'changeSeq', v_change_seq);

    elsif v_entity_type = 'routePoint' then
      v_trip_id := btrim(coalesce(v_payload ->> 'trip_id', ''));
      if length(v_trip_id) < 1 or length(v_trip_id) > 180 or v_trip_id ~ '[[:cntrl:]]' then
        raise exception 'trip_id is required' using errcode = '22023';
      end if;
      v_event_ts := tracklog_private.strict_sync_timestamp(v_payload -> 'ts', 'ts');
      v_lat := tracklog_private.strict_sync_float(v_payload -> 'lat', 'lat');
      v_lng := tracklog_private.strict_sync_float(v_payload -> 'lng', 'lng');
      v_accuracy := tracklog_private.strict_sync_float(v_payload -> 'accuracy', 'accuracy', false);
      v_speed := tracklog_private.strict_sync_float(v_payload -> 'speed', 'speed', false);
      v_heading := tracklog_private.strict_sync_float(v_payload -> 'heading', 'heading', false);
      if v_lat < -90 or v_lat > 90 or v_lng < -180 or v_lng > 180 then
        raise exception 'route coordinates are outside the supported range' using errcode = '22023';
      end if;
      if v_accuracy is not null and (v_accuracy < 0 or v_accuracy > 100000) then
        raise exception 'accuracy is outside the supported range' using errcode = '22023';
      end if;
      if v_speed is not null and (v_speed < 0 or v_speed > 500) then
        raise exception 'speed is outside the supported range' using errcode = '22023';
      end if;
      if v_heading is not null and (v_heading < 0 or v_heading > 360) then
        raise exception 'heading is outside the supported range' using errcode = '22023';
      end if;
      if v_payload ? 'source' and jsonb_typeof(v_payload -> 'source') <> 'null' then
        if jsonb_typeof(v_payload -> 'source') <> 'string' then
          raise exception 'source must be a string' using errcode = '22023';
        end if;
        v_source := v_payload ->> 'source';
        if v_source not in ('foreground', 'background', 'event') then
          raise exception 'Unsupported route point source' using errcode = '22023';
        end if;
      end if;

      select * into v_trip_tombstone from public.deleted_trip_tombstones
      where trip_id = v_trip_id for share;
      v_has_trip_tombstone := found;
      if v_has_trip_tombstone then
        if v_trip_tombstone.owner_user_id <> _owner_user_id then
          return v_ack || jsonb_build_object('status', 'rejected', 'message', 'Trip belongs to another account');
        end if;
        return v_ack || jsonb_build_object(
          'status', 'deleted', 'revision', v_trip_tombstone.revision,
          'changeSeq', v_trip_tombstone.change_seq, 'message', 'Trip was permanently deleted'
        );
      end if;

      if v_entity_id like 'event-anchor-%' then
        select * into v_event_tombstone
        from public.deleted_event_tombstones
        where event_id = substring(v_entity_id from 14)
        for share;
        v_has_event_tombstone := found;
        if v_has_event_tombstone then
          if v_event_tombstone.owner_user_id <> _owner_user_id then
            return v_ack || jsonb_build_object('status', 'rejected', 'message', 'Entity belongs to another account');
          end if;
          return v_ack || jsonb_build_object(
            'status', 'deleted', 'revision', v_event_tombstone.revision,
            'changeSeq', v_event_tombstone.change_seq, 'message', 'Event anchor was permanently deleted'
          );
        end if;
      end if;

      select * into v_trip from public.trip_headers where trip_id = v_trip_id for share;
      v_has_trip := found;
      if not v_has_trip or v_trip.owner_user_id <> _owner_user_id then
        return v_ack || jsonb_build_object('status', 'conflict', 'message', 'Trip header is missing or belongs to another account');
      end if;

      select * into v_point from public.trip_route_points where id = v_entity_id for update;
      v_has_point := found;
      if v_has_point and v_point.owner_user_id <> _owner_user_id then
        return v_ack || jsonb_build_object('status', 'rejected', 'message', 'Entity belongs to another account');
      end if;
      if v_has_point and v_point.trip_id <> v_trip_id then
        return v_ack || jsonb_build_object('status', 'rejected', 'message', 'route point trip_id is immutable');
      end if;

      if v_has_point then
        if v_base_revision is null or v_base_revision <> v_point.revision then
          return v_ack || jsonb_build_object(
            'status', 'conflict', 'revision', v_point.revision,
            'changeSeq', v_point.change_seq, 'message', 'A newer cloud revision already exists',
            'currentRow', to_jsonb(v_point)
          );
        end if;
        update public.trip_route_points
        set ts = v_event_ts,
            lat = v_lat,
            lng = v_lng,
            accuracy = v_accuracy,
            speed = v_speed,
            heading = v_heading,
            source = v_source
        where id = v_entity_id
          and owner_user_id = _owner_user_id
          and revision = v_base_revision
        returning revision, change_seq into v_revision, v_change_seq;
        if v_revision is null then
          select * into v_point from public.trip_route_points where id = v_entity_id;
          return v_ack || jsonb_build_object(
            'status', 'conflict', 'revision', v_point.revision,
            'changeSeq', v_point.change_seq, 'message', 'A newer cloud revision already exists',
            'currentRow', to_jsonb(v_point)
          );
        end if;
      else
        if coalesce(v_base_revision, 0) <> 0 then
          return v_ack || jsonb_build_object('status', 'conflict', 'message', 'Cloud route point no longer exists');
        end if;
        insert into public.trip_route_points (
          id, trip_id, device_id, owner_user_id, ts, lat, lng,
          accuracy, speed, heading, source
        ) values (
          v_entity_id, v_trip_id, v_trip.device_id, _owner_user_id, v_event_ts,
          v_lat, v_lng, v_accuracy, v_speed, v_heading, v_source
        )
        returning revision, change_seq into v_revision, v_change_seq;
      end if;
      return v_ack || jsonb_build_object('status', 'applied', 'revision', v_revision, 'changeSeq', v_change_seq);

    elsif v_entity_type in ('report', 'reportDelete') then
      v_trip_id := btrim(coalesce(v_payload ->> 'trip_id', v_entity_id));
      if v_trip_id <> v_entity_id then
        raise exception 'report trip_id must equal entityId' using errcode = '22023';
      end if;

      select * into v_trip_tombstone from public.deleted_trip_tombstones
      where trip_id = v_trip_id for share;
      v_has_trip_tombstone := found;
      if v_has_trip_tombstone then
        if v_trip_tombstone.owner_user_id <> _owner_user_id then
          return v_ack || jsonb_build_object('status', 'rejected', 'message', 'Trip belongs to another account');
        end if;
        return v_ack || jsonb_build_object(
          'status', 'deleted', 'revision', v_trip_tombstone.revision,
          'changeSeq', v_trip_tombstone.change_seq, 'message', 'Trip was permanently deleted'
        );
      end if;
      select * into v_trip from public.trip_headers where trip_id = v_trip_id for share;
      v_has_trip := found;
      if not v_has_trip or v_trip.owner_user_id <> _owner_user_id then
        return v_ack || jsonb_build_object('status', 'conflict', 'message', 'Trip header is missing or belongs to another account');
      end if;

      select * into v_report from public.report_snapshots where trip_id = v_trip_id for update;
      v_has_report := found;
      if v_has_report and v_report.owner_user_id <> _owner_user_id then
        return v_ack || jsonb_build_object('status', 'rejected', 'message', 'Entity belongs to another account');
      end if;
      select * into v_report_tombstone from public.deleted_report_tombstones
      where trip_id = v_trip_id for share;
      v_has_report_tombstone := found;
      if v_has_report_tombstone and v_report_tombstone.owner_user_id <> _owner_user_id then
        return v_ack || jsonb_build_object('status', 'rejected', 'message', 'Entity belongs to another account');
      end if;

      if v_operation = 'delete' then
        v_deleted_at := tracklog_private.strict_sync_timestamp(v_payload -> 'deleted_at', 'deleted_at');
        if v_has_report then
          if v_base_revision is null or v_base_revision <> v_report.revision then
            return v_ack || jsonb_build_object(
              'status', 'conflict', 'revision', v_report.revision,
              'changeSeq', v_report.change_seq, 'message', 'A newer cloud revision already exists',
              'currentRow', to_jsonb(v_report)
            );
          end if;
          perform tracklog_private.invalidate_tracklog_report(
            _owner_user_id, v_trip_id, v_report.device_id, 'user_deleted', v_deleted_at
          );
          select * into v_report_tombstone from public.deleted_report_tombstones where trip_id = v_trip_id;
        elsif v_has_report_tombstone then
          return v_ack || jsonb_build_object(
            'status', 'deleted', 'revision', v_report_tombstone.revision,
            'changeSeq', v_report_tombstone.change_seq, 'message', 'Report was deleted'
          );
        else
          if coalesce(v_base_revision, 0) <> 0 then
            return v_ack || jsonb_build_object('status', 'conflict', 'message', 'Cloud report no longer exists');
          end if;
          perform tracklog_private.invalidate_tracklog_report(
            _owner_user_id, v_trip_id, v_trip.device_id, 'user_deleted', v_deleted_at
          );
          select * into v_report_tombstone from public.deleted_report_tombstones where trip_id = v_trip_id;
        end if;
        return v_ack || jsonb_build_object(
          'status', 'deleted', 'revision', v_report_tombstone.revision,
          'changeSeq', v_report_tombstone.change_seq, 'message', 'Report was deleted'
        );
      end if;

      v_created_at := tracklog_private.strict_sync_timestamp(v_payload -> 'created_at', 'created_at');
      if jsonb_typeof(v_payload -> 'label') is distinct from 'string' then
        raise exception 'label must be a string' using errcode = '22023';
      end if;
      v_label := btrim(v_payload ->> 'label');
      if length(v_label) < 1 or length(v_label) > 160 then
        raise exception 'label length is invalid' using errcode = '22023';
      end if;
      v_report_payload := v_payload -> 'payload_json';
      if jsonb_typeof(v_report_payload) is distinct from 'object' or pg_column_size(v_report_payload) > 2000000 then
        raise exception 'payload_json must be an object no larger than 2 MB' using errcode = '22023';
      end if;
      v_restore_from_change_seq := null;
      if v_payload ? 'restore_from_change_seq'
         and jsonb_typeof(v_payload -> 'restore_from_change_seq') <> 'null' then
        if jsonb_typeof(v_payload -> 'restore_from_change_seq') <> 'number'
           or (v_payload ->> 'restore_from_change_seq') !~ '^[1-9][0-9]*$' then
          raise exception 'restore_from_change_seq must be a positive integer' using errcode = '22023';
        end if;
        begin
          v_restore_from_change_seq := (v_payload ->> 'restore_from_change_seq')::bigint;
        exception
          when numeric_value_out_of_range then
            raise exception 'restore_from_change_seq exceeds the supported range' using errcode = '22023';
        end;
      end if;

      if v_has_report then
        if v_base_revision is null or v_base_revision <> v_report.revision then
          return v_ack || jsonb_build_object(
            'status', 'conflict', 'revision', v_report.revision,
            'changeSeq', v_report.change_seq, 'message', 'A newer cloud revision already exists',
            'currentRow', to_jsonb(v_report)
          );
        end if;
        update public.report_snapshots
        set created_at = v_created_at,
            label = v_label,
            payload_json = v_report_payload
        where trip_id = v_trip_id
          and owner_user_id = _owner_user_id
          and revision = v_base_revision
        returning revision, change_seq into v_revision, v_change_seq;
      else
        if v_has_report_tombstone then
          if coalesce(v_payload ->> 'restore', 'false') <> 'true'
             or v_restore_from_change_seq is null
             or v_restore_from_change_seq <> v_report_tombstone.change_seq then
            return v_ack || jsonb_build_object(
              'status', 'conflict', 'revision', v_report_tombstone.revision,
              'changeSeq', v_report_tombstone.change_seq, 'message', 'Report was invalidated by a newer change',
              'currentRow', to_jsonb(v_report_tombstone)
            );
          end if;
          perform set_config(
            'tracklog.report_restore_token',
            v_trip_id || ':' || v_report_tombstone.change_seq::text,
            true
          );
        elsif coalesce(v_base_revision, 0) <> 0 then
          return v_ack || jsonb_build_object('status', 'conflict', 'message', 'Cloud report no longer exists');
        end if;
        insert into public.report_snapshots (
          trip_id, device_id, owner_user_id, created_at, label, payload_json
        ) values (
          v_trip_id, v_trip.device_id, _owner_user_id, v_created_at, v_label, v_report_payload
        )
        returning revision, change_seq into v_revision, v_change_seq;
      end if;
      return v_ack || jsonb_build_object('status', 'applied', 'revision', v_revision, 'changeSeq', v_change_seq);

    elsif v_entity_type = 'tripDelete' then
      v_deleted_at := tracklog_private.strict_sync_timestamp(v_payload -> 'deleted_at', 'deleted_at');
      select * into v_trip_tombstone from public.deleted_trip_tombstones
      where trip_id = v_entity_id for share;
      v_has_trip_tombstone := found;
      if v_has_trip_tombstone then
        if v_trip_tombstone.owner_user_id <> _owner_user_id then
          return v_ack || jsonb_build_object('status', 'rejected', 'message', 'Entity belongs to another account');
        end if;
        return v_ack || jsonb_build_object(
          'status', 'deleted', 'revision', v_trip_tombstone.revision,
          'changeSeq', v_trip_tombstone.change_seq, 'message', 'Trip was permanently deleted'
        );
      end if;

      select * into v_trip from public.trip_headers where trip_id = v_entity_id for update;
      v_has_trip := found;
      if v_has_trip and v_trip.owner_user_id <> _owner_user_id then
        return v_ack || jsonb_build_object('status', 'rejected', 'message', 'Entity belongs to another account');
      end if;
      if v_has_trip and (v_base_revision is null or v_base_revision <> v_trip.revision) then
        return v_ack || jsonb_build_object(
          'status', 'conflict', 'revision', v_trip.revision,
          'changeSeq', v_trip.change_seq, 'message', 'A newer cloud revision already exists',
          'currentRow', to_jsonb(v_trip)
        );
      end if;
      if not v_has_trip and coalesce(v_base_revision, 0) <> 0 then
        return v_ack || jsonb_build_object('status', 'conflict', 'message', 'Cloud trip no longer exists');
      end if;

      insert into public.deleted_trip_tombstones (
        trip_id, device_id, owner_user_id, deleted_by, deleted_at
      ) values (
        v_entity_id,
        case when v_has_trip then v_trip.device_id else _device_id end,
        _owner_user_id,
        _owner_user_id,
        v_deleted_at
      )
      returning revision, change_seq into v_revision, v_change_seq;
      return v_ack || jsonb_build_object(
        'status', 'deleted', 'revision', v_revision,
        'changeSeq', v_change_seq, 'message', 'Trip was permanently deleted'
      );

    elsif v_entity_type = 'eventDelete' then
      v_trip_id := btrim(coalesce(v_payload ->> 'trip_id', ''));
      if length(v_trip_id) < 1 or length(v_trip_id) > 180 or v_trip_id ~ '[[:cntrl:]]' then
        raise exception 'trip_id is required' using errcode = '22023';
      end if;
      v_deleted_at := tracklog_private.strict_sync_timestamp(v_payload -> 'deleted_at', 'deleted_at');
      v_event_ts := tracklog_private.strict_sync_timestamp(v_payload -> 'event_ts', 'event_ts', false);
      if v_payload ? 'event_type' and jsonb_typeof(v_payload -> 'event_type') <> 'null' then
        if jsonb_typeof(v_payload -> 'event_type') <> 'string' then
          raise exception 'event_type must be a string' using errcode = '22023';
        end if;
        v_event_type := v_payload ->> 'event_type';
        if v_event_type not in (
          'trip_start', 'trip_end', 'rest_start', 'rest_end', 'break_start', 'break_end',
          'load_start', 'load_end', 'unload_start', 'unload_end', 'refuel', 'boarding',
          'disembark', 'expressway', 'expressway_start', 'expressway_end', 'point_mark'
        ) then
          raise exception 'Unsupported event type' using errcode = '22023';
        end if;
      end if;

      select * into v_trip_tombstone from public.deleted_trip_tombstones
      where trip_id = v_trip_id for share;
      v_has_trip_tombstone := found;
      if v_has_trip_tombstone then
        if v_trip_tombstone.owner_user_id <> _owner_user_id then
          return v_ack || jsonb_build_object('status', 'rejected', 'message', 'Trip belongs to another account');
        end if;
        return v_ack || jsonb_build_object(
          'status', 'deleted', 'revision', v_trip_tombstone.revision,
          'changeSeq', v_trip_tombstone.change_seq, 'message', 'Trip was permanently deleted'
        );
      end if;

      select * into v_event_tombstone from public.deleted_event_tombstones
      where event_id = v_entity_id for share;
      v_has_event_tombstone := found;
      if v_has_event_tombstone then
        if v_event_tombstone.owner_user_id <> _owner_user_id then
          return v_ack || jsonb_build_object('status', 'rejected', 'message', 'Entity belongs to another account');
        end if;
        return v_ack || jsonb_build_object(
          'status', 'deleted', 'revision', v_event_tombstone.revision,
          'changeSeq', v_event_tombstone.change_seq, 'message', 'Event was permanently deleted'
        );
      end if;

      select * into v_event from public.trip_events where id = v_entity_id for update;
      v_has_event := found;
      if v_has_event and v_event.owner_user_id <> _owner_user_id then
        return v_ack || jsonb_build_object('status', 'rejected', 'message', 'Entity belongs to another account');
      end if;
      if v_has_event then
        if v_base_revision is null or v_base_revision <> v_event.revision then
          return v_ack || jsonb_build_object(
            'status', 'conflict', 'revision', v_event.revision,
            'changeSeq', v_event.change_seq, 'message', 'A newer cloud revision already exists',
            'currentRow', to_jsonb(v_event)
          );
        end if;
        v_trip_id := v_event.trip_id;
        v_event_type := v_event.type;
        v_event_ts := v_event.ts;
      else
        if coalesce(v_base_revision, 0) <> 0 then
          return v_ack || jsonb_build_object('status', 'conflict', 'message', 'Cloud event no longer exists');
        end if;
      end if;

      select * into v_trip from public.trip_headers where trip_id = v_trip_id for share;
      v_has_trip := found;
      if not v_has_trip or v_trip.owner_user_id <> _owner_user_id then
        return v_ack || jsonb_build_object('status', 'conflict', 'message', 'Trip header is missing or belongs to another account');
      end if;

      insert into public.deleted_event_tombstones (
        event_id, trip_id, device_id, owner_user_id,
        event_type, event_ts, deleted_by, deleted_at
      ) values (
        v_entity_id, v_trip_id,
        case when v_has_event then v_event.device_id else v_trip.device_id end,
        _owner_user_id, v_event_type, v_event_ts, _owner_user_id, v_deleted_at
      )
      returning revision, change_seq into v_revision, v_change_seq;
      return v_ack || jsonb_build_object(
        'status', 'deleted', 'revision', v_revision,
        'changeSeq', v_change_seq, 'message', 'Event was permanently deleted'
      );
    end if;

    return v_ack || jsonb_build_object('status', 'rejected', 'message', 'Unsupported mutation');
  exception
    when invalid_parameter_value
      or numeric_value_out_of_range
      or invalid_datetime_format
      or datetime_field_overflow then
      return v_ack || jsonb_build_object('status', 'rejected', 'message', sqlerrm);
    when unique_violation then
      return v_ack || jsonb_build_object('status', 'conflict', 'message', 'A conflicting cloud entity already exists');
  end;
end;
$$;

revoke all on function tracklog_private.apply_tracklog_sync_mutation(uuid, text, jsonb) from public, anon, authenticated;
grant usage on schema tracklog_private to service_role;
grant execute on function tracklog_private.strict_sync_timestamp(jsonb, text, boolean) to service_role;
grant execute on function tracklog_private.strict_sync_integer(jsonb, text, boolean) to service_role;
grant execute on function tracklog_private.strict_sync_float(jsonb, text, boolean) to service_role;
grant execute on function tracklog_private.invalidate_tracklog_report(uuid, text, text, text, timestamptz) to service_role;
grant execute on function tracklog_private.apply_tracklog_sync_mutation(uuid, text, jsonb) to service_role;

grant select, insert, update, delete on table public.trip_headers to service_role;
grant select, insert, update, delete on table public.trip_events to service_role;
grant select, insert, update, delete on table public.trip_route_points to service_role;
grant select, insert, update, delete on table public.report_snapshots to service_role;
grant select, insert, update, delete on table public.deleted_trip_tombstones to service_role;
grant select, insert, update, delete on table public.deleted_event_tombstones to service_role;
grant select, update on table public.device_profiles to service_role;

create or replace function public.tracklog_sync_v2(
  _owner_user_id uuid,
  _device_id text,
  _cursor bigint,
  _mutations jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, tracklog_private
as $$
declare
  v_owner_head bigint;
  v_mutation jsonb;
  v_mutation_id_text text;
  v_mutation_id uuid;
  v_entity_type text;
  v_entity_id text;
  v_ack jsonb;
  v_receipt jsonb;
  v_acks jsonb := '[]'::jsonb;
  v_trips jsonb;
  v_events jsonb;
  v_route_points jsonb;
  v_reports jsonb;
  v_deleted_trips jsonb;
  v_deleted_events jsonb;
  v_deleted_reports jsonb;
  v_next_cursor bigint;
  v_has_more boolean;
begin
  if _owner_user_id is null then
    raise exception 'owner_user_id is required' using errcode = '22023';
  end if;
  if nullif(btrim(_device_id), '') is null or length(_device_id) > 180 then
    raise exception 'device_id is invalid' using errcode = '22023';
  end if;
  if _cursor is null or _cursor < 0 then
    raise exception 'cursor must be a non-negative integer' using errcode = '22023';
  end if;
  if _mutations is null or jsonb_typeof(_mutations) <> 'array' then
    raise exception 'mutations must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(_mutations) > 420 then
    raise exception 'at most 420 mutations are allowed' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.device_profiles profile
    where profile.device_id = _device_id
      and profile.auth_user_id = _owner_user_id
      and profile.approval_status = 'approved'
  ) then
    raise exception 'approved device is required' using errcode = '42501';
  end if;

  insert into public.tracklog_sync_counters (owner_user_id, last_change_seq)
  values (_owner_user_id, 0)
  on conflict (owner_user_id) do nothing;

  -- Held until the RPC transaction commits. All v1/v2 writers for this owner
  -- acquire this same row through the BEFORE trigger.
  select counter.last_change_seq
  into v_owner_head
  from public.tracklog_sync_counters counter
  where counter.owner_user_id = _owner_user_id
  for update;

  if _cursor > v_owner_head then
    raise exception 'cursor is ahead of the owner change feed' using errcode = '22023';
  end if;

  for v_mutation in
    select item.value
    from jsonb_array_elements(_mutations) with ordinality item(value, position)
    order by item.position
  loop
    v_mutation_id_text := coalesce(v_mutation ->> 'mutationId', '');
    v_entity_type := coalesce(v_mutation ->> 'entityType', '');
    v_entity_id := btrim(coalesce(v_mutation ->> 'entityId', ''));
    v_ack := jsonb_build_object(
      'mutationId', v_mutation_id_text,
      'entityType', v_entity_type,
      'entityId', v_entity_id
    );

    if v_mutation_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      v_ack := v_ack || jsonb_build_object(
        'status', 'rejected',
        'message', 'mutationId must be a UUID'
      );
      v_acks := v_acks || jsonb_build_array(v_ack);
      continue;
    end if;

    begin
      v_mutation_id := v_mutation_id_text::uuid;
    exception
      when invalid_text_representation then
        v_ack := v_ack || jsonb_build_object(
          'status', 'rejected',
          'message', 'mutationId must be a UUID'
        );
        v_acks := v_acks || jsonb_build_array(v_ack);
        continue;
    end;

    select receipt.response_json
    into v_receipt
    from public.tracklog_sync_mutations receipt
    where receipt.owner_user_id = _owner_user_id
      and receipt.mutation_id = v_mutation_id;

    if found then
      v_ack := v_receipt || jsonb_build_object('status', 'duplicate');
      v_acks := v_acks || jsonb_build_array(v_ack);
      continue;
    end if;

    v_ack := tracklog_private.apply_tracklog_sync_mutation(
      _owner_user_id,
      _device_id,
      v_mutation
    );

    if v_ack ->> 'status' = 'conflict' and not (v_ack ? 'code') then
      v_ack := v_ack || jsonb_build_object(
        'code',
        case v_ack ->> 'message'
          when 'A newer cloud revision already exists' then 'revision_conflict'
          when 'Report was invalidated by a newer change' then 'report_tombstone_conflict'
          when 'Another active trip already exists' then 'active_trip_conflict'
          when 'Cloud trip no longer exists' then 'entity_deleted'
          when 'Cloud event no longer exists' then 'entity_deleted'
          when 'Cloud route point no longer exists' then 'entity_deleted'
          when 'Cloud report no longer exists' then 'entity_deleted'
          when 'Trip header is missing or belongs to another account' then 'missing_parent'
          else 'conflict'
        end
      );
    end if;

    -- A conflict is deliberately not receipted. Explicit deletes may retry
    -- after rebasing, while upserts either accept currentRow or retry only
    -- when a newer local mutation replaced the request snapshot.
    if v_ack ->> 'status' in ('applied', 'deleted') then
      insert into public.tracklog_sync_mutations (
        owner_user_id,
        mutation_id,
        device_id,
        entity_type,
        entity_id,
        response_json
      ) values (
        _owner_user_id,
        v_mutation_id,
        _device_id,
        v_entity_type,
        v_entity_id,
        v_ack
      );
    end if;

    v_acks := v_acks || jsonb_build_array(v_ack);
  end loop;

  update public.device_profiles
  set sync_protocol_version = 2,
      last_sync_v2_at = clock_timestamp(),
      last_seen_at = clock_timestamp()
  where device_id = _device_id
    and auth_user_id = _owner_user_id;

  with all_changes as (
    select trip.change_seq, 'trips'::text bucket, trip.trip_id entity_id, to_jsonb(trip) row_data
    from public.trip_headers trip
    where trip.owner_user_id = _owner_user_id and trip.change_seq > _cursor
    union all
    select event.change_seq, 'events', event.id, to_jsonb(event)
    from public.trip_events event
    where event.owner_user_id = _owner_user_id and event.change_seq > _cursor
    union all
    select point.change_seq, 'routePoints', point.id, to_jsonb(point)
    from public.trip_route_points point
    where point.owner_user_id = _owner_user_id and point.change_seq > _cursor
    union all
    select report.change_seq, 'reports', report.trip_id, to_jsonb(report)
    from public.report_snapshots report
    where report.owner_user_id = _owner_user_id and report.change_seq > _cursor
    union all
    select tombstone.change_seq, 'deletedTrips', tombstone.trip_id, to_jsonb(tombstone)
    from public.deleted_trip_tombstones tombstone
    where tombstone.owner_user_id = _owner_user_id and tombstone.change_seq > _cursor
    union all
    select tombstone.change_seq, 'deletedEvents', tombstone.event_id, to_jsonb(tombstone)
    from public.deleted_event_tombstones tombstone
    where tombstone.owner_user_id = _owner_user_id and tombstone.change_seq > _cursor
    union all
    select tombstone.change_seq, 'deletedReports', tombstone.trip_id, to_jsonb(tombstone)
    from public.deleted_report_tombstones tombstone
    where tombstone.owner_user_id = _owner_user_id and tombstone.change_seq > _cursor
  ), page as (
    select change_seq, bucket, entity_id, row_data
    from all_changes
    order by change_seq, bucket, entity_id
    limit 1501
  ), selected as (
    select change_seq, bucket, entity_id, row_data
    from page
    order by change_seq, bucket, entity_id
    limit 1500
  )
  select
    coalesce(jsonb_agg(row_data order by change_seq) filter (where bucket = 'trips'), '[]'::jsonb),
    coalesce(jsonb_agg(row_data order by change_seq) filter (where bucket = 'events'), '[]'::jsonb),
    coalesce(jsonb_agg(row_data order by change_seq) filter (where bucket = 'routePoints'), '[]'::jsonb),
    coalesce(jsonb_agg(row_data order by change_seq) filter (where bucket = 'reports'), '[]'::jsonb),
    coalesce(jsonb_agg(row_data order by change_seq) filter (where bucket = 'deletedTrips'), '[]'::jsonb),
    coalesce(jsonb_agg(row_data order by change_seq) filter (where bucket = 'deletedEvents'), '[]'::jsonb),
    coalesce(jsonb_agg(row_data order by change_seq) filter (where bucket = 'deletedReports'), '[]'::jsonb),
    coalesce(max(change_seq), _cursor),
    (select count(*) > 1500 from page)
  into
    v_trips,
    v_events,
    v_route_points,
    v_reports,
    v_deleted_trips,
    v_deleted_events,
    v_deleted_reports,
    v_next_cursor,
    v_has_more
  from selected;

  if not v_has_more then
    select counter.last_change_seq
    into v_owner_head
    from public.tracklog_sync_counters counter
    where counter.owner_user_id = _owner_user_id;
    v_next_cursor := greatest(v_next_cursor, v_owner_head);
  end if;

  return jsonb_build_object(
    'ok', true,
    'data', jsonb_build_object(
      'protocolVersion', 2,
      'cursor', v_next_cursor,
      'hasMore', v_has_more,
      'acks', v_acks,
      'changes', jsonb_build_object(
        'trips', v_trips,
        'events', v_events,
        'routePoints', v_route_points,
        'reports', v_reports,
        'deletedTrips', v_deleted_trips,
        'deletedEvents', v_deleted_events,
        'deletedReports', v_deleted_reports
      )
    )
  );
end;
$$;

revoke all on function public.tracklog_sync_v2(uuid, text, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.tracklog_sync_v2(uuid, text, bigint, jsonb) to service_role;

-- Keep device migration compatible with the v2 ownership graph. Moving the
-- profile alone would leave tombstones, receipts, push registrations, and
-- mutation receipts pointing at the old key and ON DELETE RESTRICT would roll
-- the migration back.
create or replace function tracklog_private.migrate_tracklog_device_records_for_actor(
  _actor_user_id uuid,
  _actor_is_admin boolean,
  _old_device_id text,
  _new_device_id text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, tracklog_private
as $$
declare
  old_profile public.device_profiles%rowtype;
  new_profile public.device_profiles%rowtype;
  target_owner uuid;
  next_approval_status text;
  next_approval_decided_at timestamptz;
  next_approval_decided_by uuid;
  v_is_admin boolean := coalesce(_actor_is_admin, false);
begin
  if _actor_user_id is null then
    raise exception 'auth session is required' using errcode = '42501';
  end if;
  if nullif(btrim(_old_device_id), '') is null
     or nullif(btrim(_new_device_id), '') is null
     or _old_device_id = _new_device_id then
    return;
  end if;

  select * into old_profile
  from public.device_profiles
  where device_id = _old_device_id
  for update;
  if not found then return; end if;

  select * into new_profile
  from public.device_profiles
  where device_id = _new_device_id
  for update;

  target_owner := coalesce(old_profile.auth_user_id, new_profile.auth_user_id, _actor_user_id);
  if not v_is_admin and target_owner <> _actor_user_id then
    raise exception 'old device profile is assigned to another account' using errcode = '42501';
  end if;
  if new_profile.device_id is not null
     and new_profile.auth_user_id is not null
     and new_profile.auth_user_id <> target_owner then
    raise exception 'new device profile is assigned to another account' using errcode = '42501';
  end if;

  next_approval_status := case
    when new_profile.approval_status = 'approved' or old_profile.approval_status = 'approved' then 'approved'
    when new_profile.approval_status = 'rejected' then 'rejected'
    else coalesce(old_profile.approval_status, new_profile.approval_status, 'pending')
  end;
  next_approval_decided_at := coalesce(new_profile.approval_decided_at, old_profile.approval_decided_at);
  next_approval_decided_by := coalesce(new_profile.approval_decided_by, old_profile.approval_decided_by);

  if new_profile.device_id is null then
    insert into public.device_profiles (
      device_id, auth_user_id, display_name, vehicle_label, driver_phone,
      driver_email, platform, app_version, latest_status, latest_trip_id,
      latest_lat, latest_lng, latest_accuracy, latest_location_at, last_seen_at,
      approval_status, approval_requested_at, approval_decided_at,
      approval_decided_by, sync_protocol_version, last_sync_v2_at
    ) values (
      _new_device_id, target_owner, old_profile.display_name,
      old_profile.vehicle_label, old_profile.driver_phone,
      old_profile.driver_email, old_profile.platform, old_profile.app_version,
      old_profile.latest_status, old_profile.latest_trip_id,
      old_profile.latest_lat, old_profile.latest_lng, old_profile.latest_accuracy,
      old_profile.latest_location_at, coalesce(old_profile.last_seen_at, now()),
      next_approval_status, coalesce(old_profile.approval_requested_at, now()),
      next_approval_decided_at, next_approval_decided_by,
      old_profile.sync_protocol_version, old_profile.last_sync_v2_at
    );
  else
    update public.device_profiles
    set auth_user_id = target_owner,
        display_name = coalesce(new_profile.display_name, old_profile.display_name),
        vehicle_label = coalesce(new_profile.vehicle_label, old_profile.vehicle_label),
        driver_phone = coalesce(new_profile.driver_phone, old_profile.driver_phone),
        driver_email = coalesce(new_profile.driver_email, old_profile.driver_email),
        latest_status = coalesce(new_profile.latest_status, old_profile.latest_status),
        latest_trip_id = coalesce(new_profile.latest_trip_id, old_profile.latest_trip_id),
        latest_lat = coalesce(new_profile.latest_lat, old_profile.latest_lat),
        latest_lng = coalesce(new_profile.latest_lng, old_profile.latest_lng),
        latest_accuracy = coalesce(new_profile.latest_accuracy, old_profile.latest_accuracy),
        latest_location_at = greatest(new_profile.latest_location_at, old_profile.latest_location_at),
        last_seen_at = greatest(
          coalesce(new_profile.last_seen_at, '-infinity'::timestamptz),
          coalesce(old_profile.last_seen_at, '-infinity'::timestamptz)
        ),
        approval_status = next_approval_status,
        approval_requested_at = coalesce(new_profile.approval_requested_at, old_profile.approval_requested_at, now()),
        approval_decided_at = next_approval_decided_at,
        approval_decided_by = next_approval_decided_by,
        sync_protocol_version = greatest(new_profile.sync_protocol_version, old_profile.sync_protocol_version),
        last_sync_v2_at = greatest(new_profile.last_sync_v2_at, old_profile.last_sync_v2_at)
    where device_id = _new_device_id;
  end if;

  update public.tracklog_admin_messages
  set target_device_id = _new_device_id
  where target_device_id = _old_device_id;

  delete from public.tracklog_admin_message_receipts old_receipt
  using public.tracklog_admin_message_receipts new_receipt
  where old_receipt.device_id = _old_device_id
    and new_receipt.device_id = _new_device_id
    and new_receipt.message_id = old_receipt.message_id;
  update public.tracklog_admin_message_receipts
  set device_id = _new_device_id
  where device_id = _old_device_id;

  update public.tracklog_push_registrations
  set device_id = _new_device_id,
      auth_user_id = target_owner,
      updated_at = clock_timestamp()
  where device_id = _old_device_id;

  update public.tracklog_sync_mutations
  set device_id = _new_device_id
  where device_id = _old_device_id;
  update public.deleted_trip_tombstones
  set device_id = _new_device_id
  where device_id = _old_device_id;
  update public.deleted_event_tombstones
  set device_id = _new_device_id
  where device_id = _old_device_id;
  update public.deleted_report_tombstones
  set device_id = _new_device_id
  where device_id = _old_device_id;

  -- Child live rows follow through the composite ON UPDATE CASCADE keys.
  update public.trip_headers
  set device_id = _new_device_id
  where device_id = _old_device_id;

  delete from public.device_profiles
  where device_id = _old_device_id;
end;
$$;

revoke all on function tracklog_private.migrate_tracklog_device_records_for_actor(uuid, boolean, text, text)
  from public, anon, authenticated;

create or replace function public.migrate_tracklog_device_records(
  _old_device_id text,
  _new_device_id text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, tracklog_private
as $$
begin
  if auth.uid() is null then
    raise exception 'auth session is required' using errcode = '42501';
  end if;
  perform tracklog_private.migrate_tracklog_device_records_for_actor(
    auth.uid(),
    public.is_tracklog_admin(),
    _old_device_id,
    _new_device_id
  );
end;
$$;

revoke all on function public.migrate_tracklog_device_records(text, text) from public, anon;
grant execute on function public.migrate_tracklog_device_records(text, text) to authenticated;

create or replace function public.tracklog_migrate_device_v2(
  _actor_user_id uuid,
  _old_device_id text,
  _new_device_id text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, auth, tracklog_private
as $$
declare
  v_actor_email text;
  v_actor_is_admin boolean := false;
begin
  select lower(btrim(users.email))
  into v_actor_email
  from auth.users users
  where users.id = _actor_user_id;

  if v_actor_email is null then
    raise exception 'actor account does not exist' using errcode = '42501';
  end if;

  select exists (
    select 1
    from public.admin_users admin
    where admin.enabled = true
      and lower(btrim(admin.email)) = v_actor_email
  ) into v_actor_is_admin;

  perform tracklog_private.migrate_tracklog_device_records_for_actor(
    _actor_user_id,
    v_actor_is_admin,
    _old_device_id,
    _new_device_id
  );
end;
$$;

revoke all on function public.tracklog_migrate_device_v2(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.tracklog_migrate_device_v2(uuid, text, text) to service_role;

-- Keep all existing v1 table grants and RLS policies during the rollout.
-- Their INSERT/UPDATE paths now receive owner/revision/change_seq in the same
-- trigger as v2, while only service_role can call the v2 RPC or internal tables.
notify pgrst, 'reload schema';
