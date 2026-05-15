-- 1. admin_users テーブルのセキュリティ強化
alter table public.admin_users enable row level security;

-- 管理者のみが管理者リストを参照できるようにする
drop policy if exists admin_users_select on public.admin_users;
create policy admin_users_select on public.admin_users
for select using (public.is_tracklog_admin());

-- 2. メンテナンス関数の実行権限の厳格化
create or replace function public.prune_tracklog_cloud_usage()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_threshold_bytes constant bigint := 419430400; -- 400 MiB
  v_min_retention_days constant integer := 31;
  v_batch_limit constant integer := 50000;
  v_database_bytes bigint;
  v_existing_cutoff timestamptz;
  v_cutoff timestamptz := now() - make_interval(days => v_min_retention_days);
  v_effective_cutoff timestamptz;
  v_triggered boolean := false;
  v_route_points_deleted integer := 0;
  v_reports_deleted integer := 0;
  v_events_deleted integer := 0;
begin
  -- 実行者が管理者であることを厳格にチェック
  if not public.is_tracklog_admin() then
    raise exception 'Access denied. Admin privileges required.';
  end if;

  select coalesce(sum(pg_database_size(datname)), 0)::bigint
    into v_database_bytes
    from pg_database;

  select detail_retention_cutoff
    into v_existing_cutoff
    from public.tracklog_cloud_maintenance
   where id = 'default';

  v_effective_cutoff := v_existing_cutoff;

  if v_database_bytes >= v_threshold_bytes then
    v_triggered := true;
    v_effective_cutoff := greatest(coalesce(v_existing_cutoff, '-infinity'::timestamptz), v_cutoff);

    with target as (
      select point.id
        from public.trip_route_points point
        join public.trip_headers header
          on header.trip_id = point.trip_id
       where header.status = 'closed'
         and coalesce(header.end_ts, point.ts) < v_effective_cutoff
       order by point.ts asc
       limit v_batch_limit
    )
    delete from public.trip_route_points point
      using target
     where point.id = target.id;
    get diagnostics v_route_points_deleted = row_count;

    with target as (
      select report.trip_id
        from public.report_snapshots report
        join public.trip_headers header
          on header.trip_id = report.trip_id
       where header.status = 'closed'
         and coalesce(header.end_ts, report.created_at) < v_effective_cutoff
       order by report.created_at asc
       limit v_batch_limit
    )
    delete from public.report_snapshots report
      using target
     where report.trip_id = target.trip_id;
    get diagnostics v_reports_deleted = row_count;

    with target as (
      select event.id
        from public.trip_events event
        join public.trip_headers header
          on header.trip_id = event.trip_id
       where header.status = 'closed'
         and coalesce(header.end_ts, event.ts) < v_effective_cutoff
       order by event.ts asc
       limit v_batch_limit
    )
    delete from public.trip_events event
      using target
     where event.id = target.id;
    get diagnostics v_events_deleted = row_count;
  end if;

  insert into public.tracklog_cloud_maintenance (
    id,
    detail_retention_cutoff,
    last_checked_at,
    last_pruned_at,
    database_bytes,
    threshold_bytes,
    route_points_deleted,
    events_deleted,
    reports_deleted
  )
  values (
    'default',
    v_effective_cutoff,
    now(),
    case when v_triggered then now() else null end,
    v_database_bytes,
    v_threshold_bytes,
    v_route_points_deleted,
    v_events_deleted,
    v_reports_deleted
  )
  on conflict (id) do update
    set detail_retention_cutoff = excluded.detail_retention_cutoff,
        last_checked_at = excluded.last_checked_at,
        last_pruned_at = coalesce(excluded.last_pruned_at, public.tracklog_cloud_maintenance.last_pruned_at),
        database_bytes = excluded.database_bytes,
        threshold_bytes = excluded.threshold_bytes,
        route_points_deleted = excluded.route_points_deleted,
        events_deleted = excluded.events_deleted,
        reports_deleted = excluded.reports_deleted;

  return jsonb_build_object(
    'database_bytes', v_database_bytes,
    'threshold_bytes', v_threshold_bytes,
    'triggered', v_triggered,
    'minimum_retention_days', v_min_retention_days,
    'detail_retention_cutoff', v_effective_cutoff,
    'route_points_deleted', v_route_points_deleted,
    'events_deleted', v_events_deleted,
    'reports_deleted', v_reports_deleted
  );
end;
$$;
