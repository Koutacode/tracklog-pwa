-- Read-only aggregate snapshots. Run once before/after comparable workload windows.
-- Do not reset statistics. Never select raw queries, location rows, IDs, JWTs or secrets.
-- Exact counts scan data/index pages: do not schedule frequent COUNT(*) polling.
select now() measured_at, pg_database_size(current_database()) database_bytes,
       pg_postmaster_start_time() database_started_at;
select 'trip_route_points' table_name, count(*) exact_rows from public.trip_route_points
union all
select 'tracklog_sync_mutations', count(*) from public.tracklog_sync_mutations;
select relname, n_live_tup estimated_rows, n_dead_tup, n_tup_ins, n_tup_upd, n_tup_del,
       pg_table_size(relid) table_bytes, pg_indexes_size(relid) index_bytes,
       pg_total_relation_size(relid) total_bytes
from pg_stat_user_tables
where schemaname='public' and relname in ('trip_route_points','tracklog_sync_mutations','device_profiles');
select now() measured_at, queryid, calls, total_exec_time, mean_exec_time,
       shared_blks_read, shared_blks_dirtied, shared_blks_written, wal_bytes, stats_since
from pg_stat_statements
where query like '%tracklog_sync_v2%'
  and query not like '%pg_stat_statements%'
  and query not ilike '%explain%'
  and query not ilike '%create%function%';
select relname, indexrelname, idx_scan, pg_relation_size(indexrelid) index_bytes
from pg_stat_user_indexes
where schemaname='public' and relname in ('trip_route_points','tracklog_sync_mutations');
-- Use a bounded time window and aggregate only. Counts are not normalized by active driving time.
select source, count(*) points_last_24h
from public.trip_route_points where ts >= now()-interval '24 hours' group by source;
