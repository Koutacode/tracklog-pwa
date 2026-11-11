# 終わった便の区間

運行係が日報を作るための読み取りです。終わった便を `trip_id` で1回指定し、区間の種類・開始・終了・地名を返します。フェリーは休息にまとめず、`kind` は `ferry` のままです。休息として数えるのは日報側です。時刻は日本時間の生の値で、15分には丸めません。1日を24:00に合わせる合計もしません。運行中の便は返しません。座標、ルート、端末IDは出しません。

運行中の `tracklog-ops-status` の応答はそのままです。合言葉は同じ `TRACKLOG_OPS_STATUS_TOKEN_SHA256` です。この作業では本番への適用とデプロイをしていません。

## 呼び出し

```http
GET /functions/v1/tracklog-ops-closed-trip?trip_id=<TRIP_ID>
Authorization: Bearer dummy-ops-token
```

`dummy-ops-token` は説明用です。本番では 1Password のトークンに置き換え、チャットや git に残しません。

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

このファイルは `migrations` の外なので自動では走らない。消えるのは `tracklog_ops_closed_trip` だけ。
