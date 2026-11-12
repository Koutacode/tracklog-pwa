-- 読み取り専用。このファイルは実行用の控えであり、エージェントからは実行しない。
-- 対象は public.trip_events の1行。geo 列と、extras に混ざった座標キーは出さない。
-- 修正前にこの結果を控え、revision が 7、type が expressway_end、
-- extras.icResolveStatus が failed、icName が空であることを確認する。

BEGIN READ ONLY;

SELECT
  id,
  ts,
  type,
  address,
  trip_id,
  revision,
  device_id,
  change_seq,
  created_at,
  updated_at,
  sync_status,
  owner_user_id,
  extras
    - 'lat' - 'lng' - 'lon' - 'geo' - 'latitude' - 'longitude' AS extras
FROM public.trip_events
WHERE id = '4533fb3a-0089-46fc-be86-4bab94eff9a3'
  AND trip_id = 'e9dd021b-0a3f-4df9-b555-f220022bfb00';

COMMIT;
