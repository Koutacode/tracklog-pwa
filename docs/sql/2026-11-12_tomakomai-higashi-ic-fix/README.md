# 2026-11-12 苫小牧東IC の手動修正

このフォルダの SQL は人が本番で実行するための控えです。この作業では実行していません。本番 Supabase には接続していません。座標の列は SELECT に入れていません。

## 実行順

1. `supabase/migrations/20261112143000_tracklog_preserve_manual_ic_source.sql` を適用する。
2. `01_select.sql` で対象行を見る。住所の列と座標の列は出さない。`type`、`revision`、extras の IC 関連キーを確認する。
3. `02_fix.sql` をファイルごと1回実行する。更新が1件でなければ例外になり、トランザクションは戻る。
4. 戻すときは `03_revert.sql`。`revision` が 8 でないと例外で戻る。修正後に増えた extras のキーは残す。migration 未適用のまま戻すと、現行トリガーが IC名を残すため、手続きが例外を出して戻る。

`revision`、`change_seq`、`updated_at` は `tracklog_private.touch_sync_row` が UPDATE 時に上げる。SQL では代入しない。端末が古い `baseRevision` で上書きしようとすると `revision_conflict` になる。

## 表示と上書き

画面の IC名は `trip_events.extras` の `icName` です。手動修正は `icResolvedManually = true` かつ名前があるとき「（手動修正）」と出ます。今回の印 `icResolveSource = manual` も同じ表示です。成功した自動取得は `icResolveStatus = resolved` です。距離だけの候補は推定であり、入口・出口・方向は入りません。

現行の再取得は、`icResolvedManually` がある行を algorithm version が上がってもやり直しません。失敗のまま名前だけ入れると、古い algorithm の行は再取得されます。修正 SQL は名前、`resolved`、両方の手動印、修正時刻を入れ、再試行回数を 0 にします。修正前の extras は `manualFixPreviousExtras` です。

端末のローカルDBが失敗の extras を後から送っても、手動印と名前は同期の merge と `preserve_tracklog_ic_metadata` が残します。`change_seq` が増えるので、同期済みの端末は新しい行を受け取ります。未送信の端末は競合時に手動側を残します。

## Overpass 全滅時の切り替えは作っていない

IC名解決は、すでに同梱の国土数値情報（`mlit_n06_2025`、半径 1,200m）を Overpass より先に見ます。3つの Overpass が全部失敗するのは、そのカタログが候補を返さなかったあとです。同梱データに「苫小牧東」は無く、失敗後に同じカタログへ戻しても結果は空です。半径を広げると、別の接合部が推定候補になります。正しい名前にはなりません。

足りない接合部を公式の N06 から足すには、配布 ZIP の見直しとカタログの再生成が必要です。今回はデータを足さず、半径も変えていません。公式 ZIP を確認したうえで、欠落している一般ICだけを既存の生成手順で入れるのが次の案です。1件を手で座標入力しないでください。
