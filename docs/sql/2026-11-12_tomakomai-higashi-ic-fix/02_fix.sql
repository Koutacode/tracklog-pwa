-- 苫小牧東IC の手動修正。このファイルは実行用の控えであり、エージェントからは実行しない。
-- 対象は id の1行だけ。extras.icResolveStatus が failed で、IC名がまだ無いときだけ直す。
-- 直す前の extras は extras.manualFixPreviousExtras に残す。座標キーはそこへコピーしない。
-- icResolvedManually と icResolveSource=manual が、端末の再取得・algorithm version の上げ直しを止める。
-- revision / change_seq / updated_at は既存の BEFORE UPDATE トリガーが上げる。ここでは代入しない。
-- 件数が1件でない、または修正が残らないときは例外になり、トランザクションは ROLLBACK される。
--
-- 先に supabase/migrations/20261112143000_tracklog_preserve_manual_ic_source.sql を適用する。
-- 未適用でも IC名と手動印は現行トリガーが守る。未適用のままだと、端末が古い extras を
-- 送ったときに manualFixPreviousExtras と icResolveSource だけ落ちることがある。
-- 戻す SQL は、この migration 適用後でないと名前を戻せない（現行トリガーが名前を戻してしまう）。

BEGIN;

DO $body$
DECLARE
  v_id constant text := '4533fb3a-0089-46fc-be86-4bab94eff9a3';
  v_trip constant text := 'e9dd021b-0a3f-4df9-b555-f220022bfb00';
  v_row public.trip_events%ROWTYPE;
  v_previous jsonb;
  v_next jsonb;
  v_fixed_at text;
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

  IF v_row.trip_id IS DISTINCT FROM v_trip
     OR v_row.type IS DISTINCT FROM 'expressway_end'
     OR v_row.revision IS DISTINCT FROM 7
     OR coalesce(v_row.extras->>'icResolveStatus', '') IS DISTINCT FROM 'failed'
     OR coalesce(v_row.extras->>'icResolvedManually', '') = 'true'
     OR coalesce(v_row.extras->>'icResolveSource', '') = 'manual'
     OR nullif(btrim(coalesce(v_row.extras->>'icName', '')), '') IS NOT NULL
  THEN
    RAISE EXCEPTION 'target event is not the expected failed unnamed expressway_end row';
  END IF;

  v_fixed_at := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_previous := coalesce(v_row.extras, '{}'::jsonb)
    - 'lat' - 'lng' - 'lon' - 'geo' - 'latitude' - 'longitude'
    - 'manualFixPreviousExtras';
  v_next := (v_previous || jsonb_build_object(
    'icName', '苫小牧東IC',
    'icResolveStatus', 'resolved',
    'icResolvedManually', true,
    'icResolveSource', 'manual',
    'icResolveManualUpdatedAt', v_fixed_at,
    'icResolveAlgorithmVersion', 16,
    'icResolveRetryCount', 0,
    'manualFixPreviousExtras', v_previous
  ))
    - 'icResolveError'
    - 'icResolveNextRetryAt'
    - 'icResolveLastAttemptAt'
    - 'icDistanceM'
    - 'icResolveGeoSource'
    - 'icResolveGeoOffsetSeconds';

  UPDATE public.trip_events
  SET extras = v_next
  WHERE id = v_id
    AND trip_id = v_trip
    AND type = 'expressway_end'
    AND revision = 7
    AND coalesce(extras->>'icResolveStatus', '') = 'failed'
    AND nullif(btrim(coalesce(extras->>'icName', '')), '') IS NULL;

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
     OR v_after.extras->>'icName' IS DISTINCT FROM '苫小牧東IC'
     OR v_after.extras->>'icResolveStatus' IS DISTINCT FROM 'resolved'
     OR v_after.extras->>'icResolveSource' IS DISTINCT FROM 'manual'
     OR (v_after.extras->'icResolvedManually') IS DISTINCT FROM 'true'::jsonb
     OR v_after.extras->>'icResolveManualUpdatedAt' IS DISTINCT FROM v_fixed_at
     OR v_after.extras->>'expresswaySessionId' IS DISTINCT FROM v_row.extras->>'expresswaySessionId'
     OR v_after.extras->'manualFixPreviousExtras'->>'icResolveStatus' IS DISTINCT FROM 'failed'
     OR v_after.extras ? 'icResolveError'
     OR v_after.extras ? 'icResolveNextRetryAt'
  THEN
    RAISE EXCEPTION 'manual IC correction did not persist with a newer revision';
  END IF;
END
$body$;

COMMIT;
