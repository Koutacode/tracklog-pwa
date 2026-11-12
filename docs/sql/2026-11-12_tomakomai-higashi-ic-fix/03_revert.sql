-- 02_fix.sql の手動修正を、残してある extras へ戻す。エージェントからは実行しない。
-- supabase/migrations/20261112143000_tracklog_preserve_manual_ic_source.sql を先に適用する。
-- 未適用だと、更新件数は1でもトリガーが IC名を残す。その場合はこの手続きが例外を出して ROLLBACK する。
-- 戻す extras には icResolveManualClearedAt を足す。これが無いと手動修正を消せない。
-- revision / change_seq / updated_at は既存トリガーが上げる。

BEGIN;

DO $body$
DECLARE
  v_id constant text := '4533fb3a-0089-46fc-be86-4bab94eff9a3';
  v_trip constant text := 'e9dd021b-0a3f-4df9-b555-f220022bfb00';
  v_row public.trip_events%ROWTYPE;
  v_previous jsonb;
  v_restored jsonb;
  v_cleared_at text;
  v_updated integer;
  v_after public.trip_events%ROWTYPE;
BEGIN
  SELECT * INTO v_row
  FROM public.trip_events
  WHERE id = v_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'target event was not found';
  END IF;

  v_previous := v_row.extras->'manualFixPreviousExtras';
  IF v_row.trip_id IS DISTINCT FROM v_trip
     OR v_row.type IS DISTINCT FROM 'expressway_end'
     OR v_row.extras->>'icName' IS DISTINCT FROM '苫小牧東IC'
     OR v_row.extras->>'icResolveStatus' IS DISTINCT FROM 'resolved'
     OR v_row.extras->>'icResolveSource' IS DISTINCT FROM 'manual'
     OR (v_row.extras->'icResolvedManually') IS DISTINCT FROM 'true'::jsonb
     OR jsonb_typeof(v_previous) IS DISTINCT FROM 'object'
     OR v_previous->>'icResolveStatus' IS DISTINCT FROM 'failed'
     OR nullif(btrim(coalesce(v_previous->>'icName', '')), '') IS NOT NULL
  THEN
    RAISE EXCEPTION 'target event is not the manual Tomakomai-Higashi correction';
  END IF;

  v_cleared_at := to_char(
    greatest(
      clock_timestamp(),
      coalesce((v_row.extras->>'icResolveManualUpdatedAt')::timestamptz, clock_timestamp())
    ) AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  v_restored := (v_previous
    - 'lat' - 'lng' - 'lon' - 'geo' - 'latitude' - 'longitude'
    - 'manualFixPreviousExtras' - 'icResolveSource' - 'icResolvedManually'
    - 'icName' - 'icResolveManualUpdatedAt' - 'icDistanceM'
    - 'icResolveGeoSource' - 'icResolveGeoOffsetSeconds')
    || jsonb_build_object('icResolveManualClearedAt', v_cleared_at);

  UPDATE public.trip_events
  SET extras = v_restored
  WHERE id = v_id
    AND trip_id = v_trip
    AND type = 'expressway_end'
    AND revision = v_row.revision
    AND extras->>'icResolveSource' = 'manual'
    AND extras->>'icName' = '苫小牧東IC'
    AND extras->>'icResolveStatus' = 'resolved';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'update count was %, expected 1', v_updated;
  END IF;

  SELECT * INTO v_after
  FROM public.trip_events
  WHERE id = v_id;

  IF v_after.revision IS DISTINCT FROM v_row.revision + 1
     OR v_after.change_seq IS NULL
     OR v_after.change_seq <= v_row.change_seq
     OR nullif(btrim(coalesce(v_after.extras->>'icName', '')), '') IS NOT NULL
     OR v_after.extras->>'icResolveStatus' IS DISTINCT FROM 'failed'
     OR v_after.extras->>'icResolveSource' IS NOT NULL
     OR v_after.extras ? 'icResolvedManually'
     OR v_after.extras ? 'manualFixPreviousExtras'
     OR v_after.extras->>'icResolveManualClearedAt' IS DISTINCT FROM v_cleared_at
     OR v_after.extras->>'expresswaySessionId' IS DISTINCT FROM v_previous->>'expresswaySessionId'
  THEN
    RAISE EXCEPTION 'revert did not restore the saved failure; apply 20261112143000 first';
  END IF;
END
$body$;

COMMIT;
