revoke all on table public.device_profiles from authenticated;
revoke all on table public.trip_headers from authenticated;
revoke all on table public.trip_events from authenticated;
revoke all on table public.trip_route_points from authenticated;
revoke all on table public.report_snapshots from authenticated;
revoke all on table public.deleted_trip_tombstones from authenticated;

grant select, insert, update on table public.device_profiles to authenticated;
grant select, insert, update on table public.trip_headers to authenticated;
grant select, insert, update on table public.trip_events to authenticated;
grant select, insert, update on table public.trip_route_points to authenticated;
grant select, insert, update on table public.report_snapshots to authenticated;
grant select on table public.deleted_trip_tombstones to authenticated;
