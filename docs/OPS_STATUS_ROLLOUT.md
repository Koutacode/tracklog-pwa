# 運行状況 API の反映手順（2026-11-12）

チームリードが、停車中で同期が止まっているときに行う。このリポジトリの作業では適用・デプロイ・秘密の作成をしていない。マイグレーションは列を足さず、既存の行も更新・削除しない。増えるのは部分索引 `idx_trip_headers_active_device`、関数 `tracklog_ops_status(text)`、その関数の実行権限だけである。索引作成で `trip_headers` に短いロックがかかる。

契約は [OPS_STATUS_API.md](OPS_STATUS_API.md)。戻す SQL は `supabase/rollback/20261111120000_tracklog_ops_status_down.sql`（`migrations` の外。自動適用されない）。

`<SUPABASE_PROJECT_REF>` は `supabase/config.toml` の `project_id`。URL は `https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/tracklog-ops-status`。

## 1. 事前確認

Dashboard の SQL Editor で実行する。`latest_lat` は見ない。

```sql
select pg_size_pretty(pg_database_size(current_database())) as db_size,
       (select count(*) from public.trip_headers where status = 'active') as active_trips;
```

`active_trips` が 0 であること、トラックが停車し、アプリの同期が動いていないことを確認する。データベースサイズをメモする。0 でなければ中止する。

## 2. トークン

オンラインのハッシュサイトやチャットにトークンを貼らない。手元のシェルだけで作る。

```bash
TOKEN="$(openssl rand -base64 32)"
```

先に `TOKEN` を 1Password へ保存する（例: TrackLog ops reader）。保存できたことを確認してから、同じ端末でハッシュだけを出す。

```bash
HASH="$(printf '%s' "$TOKEN" | openssl dgst -sha256 | awk '{print $2}')"
printf '%s\n' "$HASH"
```

`HASH` は 64 桁の 16 進数。改行を含めない。Supabase に入れるのはこのハッシュだけ。

Dashboard: Project Settings → Edge Function Secrets → `TRACKLOG_OPS_STATUS_TOKEN_SHA256` に `HASH` を追加。

CLI: `supabase secrets set TRACKLOG_OPS_STATUS_TOKEN_SHA256="$HASH" --project-ref <SUPABASE_PROJECT_REF>`

## 3. マイグレーション

SQL Editor に `supabase/migrations/20261111120000_tracklog_ops_status.sql` の全文を貼って Run。

CLI（このファイルだけ）: `supabase db query --linked -f supabase/migrations/20261111120000_tracklog_ops_status.sql`

確認:

```sql
select has_function_privilege('service_role', 'public.tracklog_ops_status(text)', 'execute') as service_role,
       has_function_privilege('anon', 'public.tracklog_ops_status(text)', 'execute') as anon,
       to_regclass('public.idx_trip_headers_active_device') is not null as index_ok;
```

`service_role` が true、`anon` が false、`index_ok` が true。

## 4. 関数デプロイ

関数は `index.ts` 以外に `handler.ts` `auth.ts` `derive.ts` `geocode.ts` と、`src/domain/togglePairing.ts` `src/domain/jst.ts` を使う。欠けると起動しない。まとめて送れる CLI を正とする。

```bash
supabase functions deploy tracklog-ops-status --no-verify-jwt --project-ref <SUPABASE_PROJECT_REF>
```

Dashboard: Edge Functions → `tracklog-ops-status` をデプロイし、Enforce JWT Verification をオフにして保存する。詳細画面で JWT 検証がオフであることを見る。オンのままだと専用トークンは関数に届かず 401 になる。

## 5. スモークテスト

`TOKEN` は手元の変数だけを使う。応答本文はチャットに貼らない。停車中は `trip_active` が false で、キーは `trip_active` `synced_at` `stale` だけになる。

```bash
URL="https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/tracklog-ops-status"
curl -sS -o /dev/null -w "no-token %{http_code} %{time_total}\n" "$URL"
curl -sS -o /dev/null -w "anon %{http_code}\n" -H "Authorization: Bearer <ANON_KEY>" "$URL"
curl -sS -o /tmp/ops-body.json -w "token %{http_code} %{time_total}\n" -H "Authorization: Bearer $TOKEN" "$URL"
python3 -c "import json; b=json.load(open('/tmp/ops-body.json')); assert b.get('trip_active') is False; t=json.dumps(b); assert 'lat' not in t and 'lng' not in t and '@' not in t"
```

期待: トークン無しは 401、anon key も service_role key も 401、正しいトークンは 200。停車中の所要時間は 2 秒以内。座標の語が無いこと。

## 6. その後

数分おきの 200 が続くこと。401 の増加はハッシュ不一致、503 は秘密が無い、500 が続くときは関数ログを見る。運行中に `stale: true` が続くときは心拍が止まっている。応答に座標が出たら、すぐ下のキルスイッチを使う。

## キルスイッチと戻し

データを触らず止める。

- 401 にする: Secrets の `TRACKLOG_OPS_STATUS_TOKEN_SHA256` を、1Password のトークンとは別の 64 桁ハッシュに差し替える。今のトークンはすべて 401 になる。
- 秘密を消すと 503（`ops_reader_not_configured`）になる。401 にはならない。どちらも行データは変わらない。

関数ごと止める: Dashboard で `tracklog-ops-status` を無効化または削除し、秘密を消す。データベース側は SQL Editor で `supabase/rollback/20261111120000_tracklog_ops_status_down.sql` を実行する。消えるのはその関数と部分索引だけ。
