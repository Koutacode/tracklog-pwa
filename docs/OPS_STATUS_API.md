# 運行状況の読み取り API

とら運行などの運用補助が、運行中の運転者の状態を数分おきに読むための読み取り専用エンドポイント。書き込み、正確な座標、経路点、電話番号、メールアドレス、生のオドメーターは返さない。

この文書は契約と設定手順。マイグレーションの適用と Edge Function のデプロイは、この変更を入れた時点では行っていない。

## エンドポイント

```http
GET /functions/v1/tracklog-ops-status
Authorization: Bearer <TOKEN>
```

任意の絞り込み:

```http
GET /functions/v1/tracklog-ops-status?device_id=<DEVICE_ID>
```

- メソッドは `GET` のみ。トークンをクエリ文字列に載せない。
- `Cache-Control: no-store`。ブラウザ向け CORS は付けない。
- ゲートウェイの JWT 検証は無効（`verify_jwt = false`）。通すのは下の専用トークンだけで、管理者 JWT、運転者 JWT、anon key、service_role key は拒否する。
- 1 回の呼び出しで RPC `tracklog_ops_status` を 1 回だけ実行する。場所が IC 名にも市区町村にも落ちないときだけ、HeartRails Geo API で都道府県＋市区町村を引き、座標は捨てる。

### 認証エラー

| 状態 | HTTP | JSON |
| --- | --- | --- |
| トークン不一致・欠落 | 401 | `{"ok":false,"error":"unauthorized"}` |
| ハッシュ秘密が未設定、または DB 接続が無い | 503 | `{"ok":false,"error":"ops_reader_not_configured"}` |
| `device_id` の形式が不正 | 400 | `{"ok":false,"error":"invalid_device_id"}` |
| GET 以外 | 405 | `{"ok":false,"error":"method_not_allowed"}` |
| 内部失敗 | 500 | `{"ok":false,"error":"status_unavailable"}` |

500 の本文にデータベースのメッセージは入れない。

## 運行の有無

運行中かどうかは `trip_headers.status = 'active'` だけで決める。`device_profiles.latest_trip_id` や `latest_lat` が残っていても、終了済みの運行は返さない。

### 運行なし（HTTP 200）

指定した端末に進行中の運行が無い、または進行中の運行が一つも無い。

```json
{
  "trip_active": false,
  "synced_at": "2026-11-12T10:00:00.000+09:00",
  "stale": false
}
```

この形に `trip_id` は含まれない。`stale` は常に `false`（生きた運行が無いので、古い心拍は状態の古さではない）。

### 運行が複数で端末未指定（HTTP 200）

`device_id` を省略し、進行中の運行が 2 件以上あるときは、どれか一つを選ばない。

```json
{
  "trip_active": false,
  "selection_required": true,
  "active_count": 2,
  "devices": [
    { "device_id": "device-1", "display_name": "運転者A", "vehicle_label": "品川800" }
  ],
  "synced_at": "2026-11-12T10:00:00.000+09:00",
  "stale": false
}
```

`display_name` または `vehicle_label` がメールアドレス、電話番号、座標のように見える場合は `null` にする。電話番号・メールアドレスの列は読まない。

端末を指定したあとの呼び出しは、その端末の進行中の運行だけを見る。他の端末が運行中でも混ぜない。

## 運行中（HTTP 200）

時刻はすべて日本時間の ISO 8601（ミリ秒、`+09:00`）。

```json
{
  "trip_active": true,
  "trip_id": "trip-1",
  "device_id": "device-1",
  "trip_started_at": "2026-11-11T00:00:00.000+09:00",
  "state": "フェリー",
  "state_label": "フェリー中",
  "state_started_at": "2026-11-11T19:00:00.000+09:00",
  "flags": { "ferry": true, "expressway": false },
  "place": { "kind": "municipality", "name": "神奈川県横須賀市" },
  "events_today": [
    {
      "kind": "ferry",
      "label": "フェリー",
      "start_at": "2026-11-11T19:00:00.000+09:00",
      "end_at": null,
      "place": { "kind": "municipality", "name": "神奈川県横須賀市" }
    }
  ],
  "trip_events": [
    {
      "kind": "trip_start",
      "label": "運行開始",
      "start_at": "2026-11-11T00:00:00.000+09:00",
      "place": null
    },
    {
      "kind": "ferry",
      "label": "フェリー",
      "start_at": "2026-11-11T19:00:00.000+09:00",
      "end_at": null,
      "place": { "kind": "municipality", "name": "神奈川県横須賀市" }
    }
  ],
  "leg": { "day_index": 2, "date": "2026-11-12" },
  "synced_at": "2026-11-12T10:00:00.000+09:00",
  "stale": false
}
```

| フィールド | 意味 |
| --- | --- |
| `trip_id` / `trip_started_at` | この応答が属する運行。取り違え防止。 |
| `state` | `走行` `積込` `荷卸` `その他作業` `休憩` `休息` `フェリー` `待機` |
| `state_label` | 上に「中」を付けた表示。走行は `走行中`、待機は `待機中`。 |
| `state_started_at` | その状態の開始。待機で開始点が無いときは `null`。 |
| `flags.ferry` / `flags.expressway` | 乗船中・高速走行中。見出しの `state` とは独立。 |
| `place` | 直近の粗い場所。無ければ `null`。 |
| `trip_events` | 運行開始からの区間と点の出来事。 |
| `events_today` | `synced_at` の日本時間の暦日と重なるもの。日をまたぐフェリーは当日分にも残る。 |
| `leg.day_index` | 運行開始日を 1 とする日本時間の日数。距離やオドメーターではない。 |
| `leg.date` | `synced_at` の日本時間の日付 `YYYY-MM-DD`。 |
| `stale` | 端末の `last_seen_at` と `latest_location_at` の新しい方が、`synced_at` より 15 分を超えて古い、または両方無い。ちょうど 15 分は古くない。 |

### 見出しの状態

`src/services/locationHeartbeat.ts` の優先順位を、`src/domain/togglePairing.ts` で閉じたペアのあとに適用する。

1. 開いているフェリー → `フェリー`
2. 開いている休息 → `休息`
3. 開いている休憩 → `休憩`
4. 開いている積込 → `積込`
5. 開いている荷卸 → `荷卸`
6. 開いているその他作業 → `その他作業`
7. 出来事がある → `走行`
8. 出来事が無い → `待機`

高速の開始は見出しを変えない。`flags.expressway` が立つ。基本の走行・休息などの開始時刻は `src/domain/liveDriveStatus.ts` の区分遷移と同じである。フェリーと高速は、その区分を置き換えない。

フェリーと休息が同時に開いているときは、見出しは `フェリー`、`flags.ferry` は `true`、`trip_events` には終了時刻 `null` の休息とフェリーが両方残る。乗船前から続いている休息も、自動で始まった休息も、終了記録が無ければ開いたままである。孤立した終了や、同じセッションの古い重複終了は、アプリと同じく区間にしない。

### 出来事

開始と終了を一つの区間にする。

| 区間 `kind` | 開始 | 終了 | `label` |
| --- | --- | --- | --- |
| `rest` | `rest_start` | `rest_end` | 休息 |
| `break` | `break_start` | `break_end` | 休憩 |
| `load` | `load_start` | `load_end` | 積込 |
| `unload` | `unload_start` | `unload_end` | 荷卸 |
| `work` | `work_start` | `work_end` | その他作業 |
| `ferry` | `boarding` | `disembark` | フェリー |
| `expressway` | `expressway_start` | `expressway_end` | 高速道路 |

進行中は `end_at: null`。終了済みは `end_at` に日本時間を入れる。

点の出来事（`trip_start` `trip_end` `refuel` `point_mark` と、古い単発の `expressway`）は `start_at` だけで、`end_at` キーは無い。ラベルは運行開始、運行終了、給油、地点記録、高速道路。

```json
{
  "kind": "ferry",
  "label": "フェリー",
  "start_at": "2026-11-11T19:00:00.000+09:00",
  "end_at": null,
  "place": { "kind": "municipality", "name": "神奈川県横須賀市" }
}
```

```json
{
  "kind": "trip_start",
  "label": "運行開始",
  "start_at": "2026-11-11T00:00:00.000+09:00",
  "place": { "kind": "ic", "name": "厚木IC" }
}
```

`place.kind` は `ic` または `municipality`。名前が無ければ `place` は `null`。

## 場所

直近の出来事から、時刻の新しい順に次を使う。

1. その出来事の `extras.icName`（推定候補のオブジェクトは使わない）
2. 保存済み住所から都道府県＋市区町村（郡部は郡＋町村）。町名と番地は捨てる。区切りが曖昧な住所や施設名は使わない
3. どれも無いとき、`device_profiles.latest_lat` / `latest_lng` をサーバー側で HeartRails Geo API（`searchByGeoLocation`、キー不要）に渡し、最も近い地点の都道府県＋市区町村だけを残す。町名、郵便番号、座標は捨てる

逆ジオコードは失敗しても状態自体は返す。`place` は `null` になる。

## 返さないもの

応答のキーと値のどちらにも、次を出さない。

- 緯度・経度、`geo`、精度、速度、方位
- `trip_route_points`
- 電話番号、メールアドレス
- `odo_start` / `odo_end` / `odoKm` / 総距離 / 区間距離
- 保存住所の町名と番地
- セッショントークンやこの読み手のトークン

RPC の内部 JSON には、逆ジオコードするまでの座標ヒントと、粗い場所へ落とす前の住所が入ることがある。Edge Function が公開 JSON を組み立てるときに捨てる。`service_role` 以外はこの RPC を実行できない。

## 所有者が行う設定

トークンの実値はこのリポジトリに置かない。チームリードが作り、1Password に保存する。プレースホルダのままコマンドを書いてある。

```bash
# 手元だけで実行する。TOKEN の出力をチャット、ログ、git に残さない。
TOKEN="$(openssl rand -base64 32)"
# TOKEN を 1Password の項目へ保存する。項目名の例: TrackLog ops reader (とら運行)
HASH="$(printf '%s' "$TOKEN" | openssl dgst -sha256 | awk '{print $2}')"

# <SUPABASE_PROJECT_REF> は supabase/config.toml の project_id
supabase secrets set TRACKLOG_OPS_STATUS_TOKEN_SHA256="$HASH" --project-ref <SUPABASE_PROJECT_REF>
```

ハッシュは 64 桁の 16 進数。改行を含めない（`printf '%s'`）。サーバーが保存するのはこのハッシュだけ。

反映の順番、Dashboard の操作、スモークテスト、キルスイッチは [OPS_STATUS_ROLLOUT.md](OPS_STATUS_ROLLOUT.md)。いずれもこの変更の作成時には実行していない。

1. マイグレーション `supabase/migrations/20261111120000_tracklog_ops_status.sql` を適用する。`tracklog_ops_status(text)` は `SECURITY DEFINER` の読み取り関数で、`service_role` だけが実行できる。`anon` と `authenticated` からは外してある。適用時、進行中の運行を引く部分索引の作成で `trip_headers` に短いロックがかかる。
2. 関数をデプロイする。`config.toml` の `verify_jwt = false` を必ず使う。ゲートウェイが専用トークンを JWT として拒否しないため。

```bash
supabase functions deploy tracklog-ops-status --no-verify-jwt --project-ref <SUPABASE_PROJECT_REF>
```

3. 1Password のトークンで、運行が無いときの 3 項目と、運行中に座標や電話番号が無いことを確認する。

```bash
curl -sS \
  -H "Authorization: Bearer <TOKEN>" \
  "https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/tracklog-ops-status"
```

運転者アプリと APK の挙動はこの API では変わらない。終わった便の区間は別関数 `tracklog-ops-closed-trip` で、説明は [OPS_CLOSED_TRIP.md](OPS_CLOSED_TRIP.md)。
