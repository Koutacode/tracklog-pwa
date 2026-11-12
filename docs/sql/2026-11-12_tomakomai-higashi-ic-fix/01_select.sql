-- 読み取り専用。このファイルは実行用の控えであり、エージェントからは実行しない。
-- 対象は public.trip_events の1行。住所の列、座標の列は出さない。
-- extras の最上段と manualFixPreviousExtras から、住所らしいキーと座標キーも外す。
-- type、revision、extras の IC 関連キーを確認する。

BEGIN READ ONLY;

SELECT
  id,
  ts,
  type,
  trip_id,
  revision,
  device_id,
  change_seq,
  created_at,
  updated_at,
  sync_status,
  owner_user_id,
  (
    CASE
      WHEN jsonb_typeof(extras->'manualFixPreviousExtras') = 'object' THEN
        jsonb_set(
          extras,
          '{manualFixPreviousExtras}',
          (extras->'manualFixPreviousExtras')
            - 'lat' - 'lng' - 'lon' - 'geo' - 'latitude' - 'longitude'
            - 'accuracy' - 'altitude' - 'alt' - 'heading' - 'speed'
            - 'address' - 'formattedAddress' - 'formatted_address'
            - 'streetAddress' - 'locality' - 'postalCode' - 'postal_code'
        )
      ELSE extras
    END
  )
    - 'lat' - 'lng' - 'lon' - 'geo' - 'latitude' - 'longitude'
    - 'accuracy' - 'altitude' - 'alt' - 'heading' - 'speed'
    - 'address' - 'formattedAddress' - 'formatted_address'
    - 'streetAddress' - 'locality' - 'postalCode' - 'postal_code'
    AS extras
FROM public.trip_events
WHERE id = '4533fb3a-0089-46fc-be86-4bab94eff9a3'
  AND trip_id = 'e9dd021b-0a3f-4df9-b555-f220022bfb00';

COMMIT;
