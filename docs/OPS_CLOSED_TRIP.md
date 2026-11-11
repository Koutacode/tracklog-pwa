# 終わった便の区間

運行係が日報を作るための読み取りです。終わった便を `trip_id` で1回指定し、区間の種類・開始・終了・地名を返します。フェリーは休息にまとめず、`kind` は `ferry` のままです。休息として数えるのは日報側です。時刻は日本時間の生の値で、15分には丸めません。1日を24:00に合わせる合計もしません。運行中の便は返しません。座標、ルート、端末IDは出しません。

運行中の `tracklog-ops-status` の応答はそのままです。合言葉は同じ `TRACKLOG_OPS_STATUS_TOKEN_SHA256` です。この作業では本番への適用とデプロイをしていません。

## 呼び出し

```http
GET /functions/v1/tracklog-ops-closed-trip?trip_id=<TRIP_ID>
Authorization: Bearer dummy-ops-token
```

`dummy-ops-token` は説明用です。本番では 1Password のトークンに置き換え、チャットや git に残しません。

日付で、その日本時間の日にかかる終わった便をまとめて取る。1回は1日だけ。`trip_id` と `date` は同時に指定しない。

```http
GET /functions/v1/tracklog-ops-closed-trip?date=2026-11-11
Authorization: Bearer dummy-ops-token
```

```json
{
  "date": "2026-11-11",
  "trips": [
    {
      "closed": true,
      "trip_id": "11111111-1111-4111-8111-111111111111",
      "trip_started_at": "2026-11-11T19:00:00.000+09:00",
      "trip_ended_at": "2026-11-12T11:00:00.000+09:00",
      "segments": [
        {
          "kind": "ferry",
          "label": "フェリー",
          "start_at": "2026-11-11T19:00:00.000+09:00",
          "end_at": "2026-11-12T11:00:00.000+09:00",
          "place": { "kind": "municipality", "name": "神奈川県横須賀市" },
          "overlaps": false
        }
      ],
      "gaps": []
    }
  ]
}
```

日をまたぐ便は、開始がその日より前でも、終了がその日より後でも、その日と重なれば入る。区間の開始と終了は切らない。11月11日の呼び出しでも、11月11日 19:00 から 11月12日 11:00 のフェリーはその生の時刻のまま入る。その日と重ならない区間は出さない。翌日の呼び出しにも、同じ区間が生の時刻のまま入る。1日に終わった便が21件を超えるときは区間を返さず、`too_many: true` と `trip_count` だけを返す。運行中の便は入らない。

終わった便:

```json
{
  "closed": true,
  "trip_id": "11111111-1111-4111-8111-111111111111",
  "trip_started_at": "2026-11-11T00:00:00.000+09:00",
  "trip_ended_at": "2026-11-11T21:00:00.000+09:00",
  "segments": [
    {
      "kind": "rest",
      "label": "休息",
      "start_at": "2026-11-11T12:00:00.000+09:00",
      "end_at": "2026-11-11T15:07:00.000+09:00",
      "place": { "kind": "municipality", "name": "神奈川県横須賀市" },
      "overlaps": true
    },
    {
      "kind": "ferry",
      "label": "フェリー",
      "start_at": "2026-11-11T12:30:00.000+09:00",
      "end_at": "2026-11-11T15:07:00.000+09:00",
      "place": { "kind": "municipality", "name": "神奈川県横須賀市" },
      "overlaps": true
    }
  ],
  "gaps": [
    { "start_at": "2026-11-11T00:00:00.000+09:00", "end_at": "2026-11-11T12:00:00.000+09:00" },
    { "start_at": "2026-11-11T15:07:00.000+09:00", "end_at": "2026-11-11T21:00:00.000+09:00" }
  ]
}
```

無い便と、まだ運行中の便はどちらも次だけです。中身は返しません。

```json
{ "closed": false }
```

| 項目 | 型 | 意味 |
| --- | --- | --- |
| `closed` | boolean | `true` のときだけ区間がある |
| `trip_id` | string | 指定した便。`closed: false` のときは無い |
| `trip_started_at` | string | 便の開始。日本時間 `+09:00`、ミリ秒3桁 |
| `trip_ended_at` | string または null | 便の終了。日本時間。記録が無ければ null |
| `segments` | array | 運行開始からの区間と点の出来事 |
| `segments[].kind` | string | `rest` `break` `load` `unload` `work` `ferry` `expressway` `wait` `drive` `trip_start` `trip_end` `refuel` `point_mark` |
| `segments[].label` | string | 休息、休憩、積込、荷卸、その他作業、フェリー、高速道路、待機、走行、運行開始、運行終了、給油、地点記録 |
| `segments[].start_at` | string | 開始。日本時間 |
| `segments[].end_at` | string または null | 区間の終了。終了記録が無いときは null。点の出来事は `segments` に入れない |
| `segments[].place` | object または null | `kind` は `ic` または `municipality`。`name` は IC 名、または都道府県＋市区町村。町名と番地は捨てる |
| `segments[].overlaps` | boolean | 他の区間と時間が重なるとき true。フェリーと休息が重なっても、どちらも残す |
| `gaps` | array | 便の開始から終了までで、終了時刻のある区間が覆っていない時間。`start_at` と `end_at` だけ。種類は付けない |
| `gaps[].start_at` | string | 穴の開始。日本時間の生の時刻 |
| `gaps[].end_at` | string | 穴の終了。日本時間の生の時刻 |
| `date` | string | 日付指定のときだけ。`YYYY-MM-DD` の日本時間 |
| `trips` | array | その日にかかる終わった便。各要素は便指定と同じ `trip_id` から `gaps` まで |
| `too_many` | boolean | その日の終わった便が21件以上のとき true。このときは `trips` が無い |
| `trip_count` | number | `too_many` のときの件数 |

`segments` は開始時刻の順です。同じ開始時刻は終了が早い順、その次に `kind` です。穴と重なりは消さず、丸めもしません。走行へ割り当てるかどうかは日報側で決めます。便の終了時刻が無いときは `gaps` は空です。

合言葉が違う、または無いときは 401。`trip_id` が無い、または形式が違うときは 400。

## 本番に出す

停車中で、同期が止まっているときに行う。`project_id` は `supabase/config.toml` の値。`<SUPABASE_PROJECT_REF>` もそれと同じ。

秘密は既存の `TRACKLOG_OPS_STATUS_TOKEN_SHA256` をそのまま使う。新しく作らない。`SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` は関数に自動で入る。

### psql（supabase CLI は使わない）

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261111144500_tracklog_ops_closed_trip.sql
```

`DATABASE_URL` は所有者の接続文字列。この文書には書かない。

### Supabase コネクタ

`apply_migration`

| 引数 | 値 |
| --- | --- |
| `name` | `tracklog_ops_closed_trip` |
| `query` | `supabase/migrations/20261111144500_tracklog_ops_closed_trip.sql` の全文 |

psql のメタコマンドは無い。`CREATE INDEX CONCURRENTLY` も無い。列も行も変えない。

`deploy_edge_function`

| 引数 | 値 |
| --- | --- |
| `name` | `tracklog-ops-closed-trip` |
| `entrypoint_path` | `supabase/functions/tracklog-ops-closed-trip/index.ts` |
| `verify_jwt` | `false` |
| `import_map_path` | 渡さない |

`files[].name` は次の6つ。中身はそのパスのファイル。`derive.test.ts` と `closedTrip.test.ts` は入れない。

1. `supabase/functions/tracklog-ops-closed-trip/index.ts`
2. `supabase/functions/tracklog-ops-closed-trip/handler.ts`
3. `supabase/functions/tracklog-ops-status/auth.ts`
4. `supabase/functions/tracklog-ops-status/derive.ts`
5. `src/domain/jst.ts`
6. `src/domain/togglePairing.ts`

### 確認

失敗は本文を出さない。成功はキー名だけ出す。

```bash
URL="https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/tracklog-ops-closed-trip?trip_id=<TRIP_ID>"
curl -s -o /dev/null -w '%{http_code}\n' "$URL"
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ANON_KEY" "$URL"
curl -s -o /tmp/ops-closed.json -w '%{http_code}\n' -H "Authorization: Bearer $OPS_TOKEN" "$URL"
jq 'keys' /tmp/ops-closed.json
rm -f /tmp/ops-closed.json
```

トークン無しと anon key は 401。正しいトークンは 200。終わった便なら `closed` がキーにあり、`device_id` は無い。運行中の便IDでは `{ "closed": false }` だけ。

```sql
select to_regprocedure('public.tracklog_ops_closed_trip(text)') is not null as function_ok,
       has_function_privilege('service_role', 'public.tracklog_ops_closed_trip(text)', 'execute') as service_role,
       has_function_privilege('anon', 'public.tracklog_ops_closed_trip(text)', 'execute') as anon;
```

`function_ok` と `service_role` が true、`anon` が false。

## 戻し方

データを触らない。関数を止めるだけなら Dashboard で `tracklog-ops-closed-trip` を無効化し、秘密は消さない（運行中APIが同じ秘密を使う）。

データベースから関数だけ外す:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/rollback/20261111144500_tracklog_ops_closed_trip_down.sql
```

このファイルは `migrations` の外なので自動では走らない。消えるのは `tracklog_ops_closed_trip` と `tracklog_ops_closed_day` だけ。

## 記録が残る期間

コード上、便と区間を年齢だけで毎日消す処理はない。

- `prune_tracklog_cloud_usage`（`supabase/migrations/20260427_tracklog_cloud_retention.sql` と `20260515_security_hardening.sql`）は、データベースが 400 MiB 以上のときだけ動く。対象は終わった便で、終了が「いまから31日以上前」かつ、それまでに記録した削除境界より古いもの。消すのは経路点、日報スナップショット、`trip_events` で、`trip_headers` は消さない。データベースが小さければこの削除は走らない。
- 運転者や管理者が便を削除したときは、年齢に関係なくその便のヘッダと区間が tombstone で消える（`20260710043340_tracklog_sync_v2.sql` など）。

したがって「何日前まで残っているか」は固定の日数ではない。本番で次の SELECT を読むと、いま残っている範囲が分かる。座標の列は選んでいない。

```sql
select min(start_ts) as oldest_trip_start,
       max(end_ts) as newest_trip_end,
       count(*) filter (where status = 'closed') as closed_trips,
       count(*) filter (where status = 'active') as active_trips
from public.trip_headers;

select to_char(date_trunc('month', start_ts at time zone 'Asia/Tokyo'), 'YYYY-MM') as month,
       count(*) as closed_trips
from public.trip_headers
where status = 'closed'
group by 1
order by 1;

select min(ts) as oldest_event,
       max(ts) as newest_event,
       count(*) as events
from public.trip_events;

select detail_retention_cutoff,
       last_pruned_at,
       events_deleted,
       route_points_deleted
from public.tracklog_cloud_maintenance
where id = 'default';
```

`oldest_event` が `oldest_trip_start` より新しいときは、それより前の区間が容量対策で消えている。便のヘッダだけ残っていることがある。
