# 2026-10-20 同期前claimの不変書込み抑制

## 対象と承認範囲

開始repo Koutacode/tracklog-pwa、main/checkout `70148761977e1cd6e6133a850cc35ede99ba368d`、作業差分なし。公開APK v0.1.79/code77。並行draft PR #26/#30、開始時実行中/queuedジョブなし。PR40の表示変更は再実装しない。

利用者承認は認証・端末承認確認を維持した不要書込み削減、検証、本番反映、負荷比較。実行主体は既存GitHub接続と既存Supabase connector。対象本番は tracklog-assist (`jwqafxtphulkjhfmvwro`)、`tracklog-privileged`だけ。資格情報、認証設定、DB migration、運行履歴/記録時刻/位置、課金、APK、他の関数は変更しない。Gemini送信なし。

対象ファイル: function index.ts、既存claim fixture/driver-google試験起動、追加throttle試験、限定配布物生成script、復旧patch、本記録。

## 実装

45秒poll→runRemoteSync→claim→毎回lastSeenAt→UPDATEを確認。正規化した書込みrowのlast_seen_at以外が既存と厳密一致し、保存last_seen_atがサーバー現在時刻から0以上60秒未満、要求lastSeenAtも保存値から0以上60秒未満のcanonical ISOの場合だけUPDATEをSELECTへ置換する。

SELECTにも同じupdated_at/owner/approval列のCAS条件を付け、途中変更なら409。JWT検証・requireUser・isTracklogAdmin・所有権・未承認プロフィールvalidationは毎回維持。未承認/取消の状態をそのまま返し、sync_v2による承認の再確認も不変。初回INSERT、プロフィール/運行状態/位置の変更、期限超過、未来の保存時刻、不正要求時刻は既存書込み経路。日時表記差は安全側の余分なUPDATEになる。マイクロ秒を丸めて内容一致とはしない。

副作用: last_seen_at/updated_atは最後の成功通信より60秒未満古く見えることがある。45秒pollで次のheartbeat書込みは前回から90秒後になる場合がある。同期poll、位置共有、30秒batch、native heartbeat、sync_v2の60秒抑制は不変。保存位置や運行記録はこの改善で変更しない。

## 本番一致・配布・復旧

開始時本番 v12/ACTIVE/verify_jwt=true。claimはrepoと同一だが、repoにあるadminMessageReceiptUpsertOptions/ACK ignoreDuplicates変更は本番に未反映。repo index.ts全体をデプロイしてはいけない。

取得した本番v12原文 SHA256:
`1156419d20b4fcbd361663cba3eaac703a9d946ef9f18f843a9091eb39ce79e3`

復旧元は永続Git履歴＋同梱patchから再現できる（秘密値不要）:

```sh
git show 70148761977e1cd6e6133a850cc35ede99ba368d:supabase/functions/tracklog-privileged/index.ts > "$work/repo-baseline.ts"
patch --output "$work/rollback-v12.ts" "$work/repo-baseline.ts" docs/deployment/privileged-v12-from-7014876.patch
sha256sum "$work/rollback-v12.ts"
node scripts/prepare-claim-only-deploy.mjs "$work/rollback-v12.ts" "$work/candidate.ts"
```

`work`はmktemp -dで作る自分専用ディレクトリ。生成scriptは旧版hashを固定し、claimと補助関数だけを置換、書込み後読み戻しを照合する。本番用candidate SHA256:
`766e23a930e1a175f212b075ceccc6b7b0e59a717b46f99706d627323d22dd36`

本番反映直前にmain/PR HEAD、CI、差分、現行本番v12のhash/verify_jwtを再確認。既存Supabase deploy_edge_functionでこのcandidate単一fileを`tracklog-privileged/index.ts`として送りverify_jwt=trueを保持。反映後get_edge_functionで原文hash、版、ACTIVE、verify_jwtを照合する。異常時は同経路で照合済みrollback-v12原文だけを新function versionとして再反映し読み戻す。DBや運行データを巻き戻さない。

## 検証と比較

独立レビュアーがrepo/candidateの8群を独立再実行しblocking findingなし。初回、応答喪失後再送、pending/rejected/approved、59999/60000/60001ms、全プロフィール/運行/位置項目変更、未来/逆行時刻、不正時刻、同時不変claim、承認取消/owner変更/位置変更のCAS競合を確認。既存claim replay 8件とsync v2 36件も成功。

PGliteの実際のUPDATE後triggerで回数を数え、同一合成データ・初回登録後45秒間隔80回を旧本番とcandidateで実行:

| 条件 | UPDATE | 正常応答 |
|---|---:|---:|
| v12 | 80 | 80 |
| candidate | 40 | 80 |

これはclaimだけの条件比較。sync_v2/native位置更新がlast_seen_atを更新する本番全体の削減率ではない。PGliteで実Postgres WALバイトを測れたとは扱わない。型検査、全logic、CSP、build、offline、Edge Deno型検査、CI結果はPR/最終運用ログ参照。

本番は負荷試験・架空運行を作らず集計統計だけ観測。2026-10-20 01:58:03.819971Z: device_profiles n_tup_upd=8749、n_tup_ins=0、n_tup_del=1、cluster wal_bytes=163287138、wal_records=320100、wal_fpi=45544、WAL stats_reset=2026-10-12 12:43:52.706252Z。統計リセットはしない。

低負荷観測計画: 前後それぞれ同じ曜日/運行時間帯・端末稼働数で最低24時間、可能なら7日比較。1時間ごとのpg_stat_user_tablesとpg_stat_wal差分、既存関数ログの件数/4xx/5xx/409、管理画面の接続鮮度と既存同期状況を確認。60秒/45秒周期を多数含む1時間で方向を見て、運行/停止の偏りと日中・夜間差は24時間、曜日差は7日で評価。新しい定期ジョブや計測書込みは追加しない。WALはcluster全体で他処理/autovacuumも含み、n_tup_updも全経路を含むため本変更だけへの因果帰属はできない。IO警告の主因/解消は未証明。

実機GPS・通知・走行・実端末認証と長期負荷効果は未検証。APK更新なし。Driveは既存2026-10 TrackLog 作業ログへ最終結果を追記する。
