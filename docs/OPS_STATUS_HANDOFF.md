# 運行状況 API の MCP 引き渡し

11/12 に、停車中・同期停止のあと、担当者が Supabase MCP で反映する。このリポジトリ側では適用・デプロイ・マージ・秘密の作成をしない。Dashboard 手順は [OPS_STATUS_ROLLOUT.md](OPS_STATUS_ROLLOUT.md)。`project_id` は `supabase/config.toml` の `project_id` を渡す。

SQL と関数の本文は、この手順書を含む PR #55 の head コミットから取る。反映直前に head の SHA を確認し、下のパスの内容を変えない。

## apply_migration

| 引数 | 値 |
| --- | --- |
| `name` | `tracklog_ops_status` |
| `query` | `supabase/migrations/20261111140308_tracklog_ops_status.sql` の全文 |

このファイルはそのまま 1 回の `query` で実行できる。`\i` などの psql メタコマンドは無い。`CREATE INDEX` は `CONCURRENTLY` ではないので、ツールがトランザクションで包んでも通る。列の追加も、行の更新・削除も無い。

## deploy_edge_function

| 引数 | 値 |
| --- | --- |
| `name` | `tracklog-ops-status` |
| `entrypoint_path` | `supabase/functions/tracklog-ops-status/index.ts` |
| `verify_jwt` | `false` |
| `import_map_path` | 渡さない。`deno.json` も import map も無い |

`files[].name` はリポジトリ相対パスにする。`derive.ts` の `../../../src/domain/...` が、この入口パスから `src/domain/...` に解決される。テスト用の `derive.test.ts` は入れない。`npm:@supabase/supabase-js@2.58.0` は Deno の npm 指定子なのでファイルにしない。

| `files[].name` | 内容のパス |
| --- | --- |
| `supabase/functions/tracklog-ops-status/index.ts` | 同じパス |
| `supabase/functions/tracklog-ops-status/handler.ts` | 同じパス |
| `supabase/functions/tracklog-ops-status/auth.ts` | 同じパス |
| `supabase/functions/tracklog-ops-status/geocode.ts` | 同じパス |
| `supabase/functions/tracklog-ops-status/derive.ts` | 同じパス |
| `src/domain/jst.ts` | 同じパス。これ以上の相対 import は無い |
| `src/domain/togglePairing.ts` | 同じパス。これ以上の相対 import は無い |

## 秘密

デプロイより先に、所有者が `TRACKLOG_OPS_STATUS_TOKEN_SHA256`（トークンの SHA-256 だけ）を Edge Function Secrets に入れる。関数は起動時に環境変数を読む。秘密が無いと呼出は 401 ではなく 503 になる。

`SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` は Edge Functions に自動で入る。デプロイ引数やチャットに書かない。

## 確認

秘密を入れたあと。失敗系は本文を出さない。成功時はトップレベルのキーだけ出す。

```bash
URL="https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/tracklog-ops-status"
curl -s -o /dev/null -w '%{http_code}\n' "$URL"
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ANON_KEY" "$URL"
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $SERVICE_ROLE_KEY" "$URL"
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ADMIN_OR_DRIVER_JWT" "$URL"
```

いずれも 401。正しいトークンだけ所有者が実行する。

```bash
curl -s -o /tmp/ops-status.json -w '%{http_code}\n' -H "Authorization: Bearer $OPS_TOKEN" "$URL"
jq 'keys' /tmp/ops-status.json
rm -f /tmp/ops-status.json
```

200 と、キー名だけ。値は画面に出さない。

関数と索引の存在（行データは返さない）:

```sql
select to_regprocedure('public.tracklog_ops_status(text)') is not null as function_ok,
       to_regclass('public.idx_trip_headers_active_device') is not null as index_ok,
       has_function_privilege('service_role', 'public.tracklog_ops_status(text)', 'execute') as service_role,
       has_function_privilege('anon', 'public.tracklog_ops_status(text)', 'execute') as anon,
       has_function_privilege('authenticated', 'public.tracklog_ops_status(text)', 'execute') as authenticated;
```

`function_ok` と `index_ok` と `service_role` が true、`anon` と `authenticated` が false。
