# Supabase Disk IO調査・最適化（2026-10-01 JST）

対象: tracklog-assist / jwqafxtphulkjhfmvwro。基点commit: 92172ac720460fb6c3cf1205a784150d69d3d1e6。

## 結果と反映状態

**後続の反映状況（2026-10-01 09時台）**: 以下の初期調査・適用直後の数値は01:42〜01:54 JSTの記録。別チャットのIC名・時刻修正と統合し、v0.1.64/code62を正式公開、公開APK照合、Android端末へデータ保持更新、DriveへAPK/sha保存まで完了した。最終の証拠・全変更ファイル・Cloud整備は [INTEGRATED_APK_RELEASE_2026-10-01.md](INTEGRATED_APK_RELEASE_2026-10-01.md) を参照。下記の「未反映」「未操作」は初期調査時点の状態を示す。

- 2026-10-01 01:53 JST、非破壊の関数差し替えを本番へ適用。migration: `20260930165335_tracklog_sync_v2_reduce_disk_io.sql`。DB側のfeed件数制限と60秒heartbeat抑制が反映済み。
- 停車中の重複位置点抑制、30秒/100通知単位の同期、終端空RPC省略、offline復帰不具合の修正はローカルソースに実装・検証済み。公開APK・端末には未反映。
- 課金プラン変更、索引削除、既存データ削除、retention導入、テーブルDROP、RLS変更、Edge/MCPの設定変更は実施していない。
- Androidの公開APK、端末のログイン・運行データは操作していない。既存の未追跡 docs/CLOUD_RESEND_2026-10-01.md と error.log も変更していない。
- Google Driveの既存構造 TrackLog / 10_作業ログ / 2026 / 10 の月次作業ログ（非公開記録）へ全文反映済み。変更19ファイル・計測・検証・復旧・未完了事項を読み戻して確認。非公開を維持。

## 本番基準値

測定は2026-10-01 01:42〜01:54 JST。DBはPostgreSQL 17.6、ACTIVE_HEALTHY。DB全体322,219,155 bytes（約307.3MiB）。
本依頼のFreeプランを維持。プラン変更APIは使用していない。

重要: 提示された18,708/19,021は pg_stat_user_tables.n_live_tup と一致したが、これは実数ではなかった。COUNT(*)による実数は以下。DB再起動は2026-09-28、統計期間と実数を区別する。巨大なbloatとは断定しない。

| 対象 | 正確な行数 | heap bytes | table bytes（補助領域含む） | index bytes | total bytes |
|---|---:|---:|---:|---:|---:|
| trip_route_points | 268,489 | 69,730,304 | 69,787,648 | 100,999,168 | 170,786,816 |
| tracklog_sync_mutations | 280,602 | 107,569,152 | 107,634,688 | 23,683,072 | 131,317,760 |

適用後の正確な件数・table/index/totalサイズはすべて同じ。既存DBサイズ削減は0 bytes。平均レコードサイズは位置点238.2 bytes、receipt360.0 bytesで、過剰なbloatの証拠にはならない。

RPC統計開始: 2026-09-28 13:17:16 UTC（同22:17:16 JST）。同じqueryidの累積値を保存し、統計resetはしていない。

| 指標 | 適用前 | 適用直後 |
|---|---:|---:|
| calls | 1,479 | 1,479 |
| mean_exec_time ms | 228.048 | 228.048 |
| shared_blks_read | 4,828 | 4,828 |
| shared_blks_dirtied | 23,862 | 23,862 |
| shared_blks_written | 2,590 | 2,590 |
| WAL bytes | 97,792,444 | 97,792,444 |

適用後の自然な同期呼び出しは観測時点で0件。したがって、本番RPC平均・WAL・Disk IO Budgetの削減率はまだ測定できない。バッファ数は8KiBページのPostgreSQL統計で、クラウドの物理IOやBudgetと一対一ではない。

比較対象 supabase_monitor_health: 3,220 calls、平均1.304ms、read4、dirtied0、written0、WAL0。本観測範囲でsync_v2が主要write負荷、監視RPCが主因という証拠はない。device_profilesは4行ながら統計期間内5,087 updates / HOT3,055。別のclaim/profile/location経路も更新するため、全更新をsync_v2に帰属させない。

HTTP観測窓: 2026-09-29 16:42 UTC〜2026-09-30 16:42 UTC（24時間）。
- DB RPC入口: 931件、すべてHTTP200（HTTP失敗率0%）。
- tracklog-sync Edge入口: 1,395件、HTTP200が1,394件、520が1件（約0.072%）。
- 別ログ面の件数は一致しないため合算しない。HTTP200はアプリ内conflict/rejectedのゼロを意味しない。変更後の実運用エラー率は未測定。

集計証拠: `docs/measurements/supabase-disk-io-2026-10-01.json`。個人ID・座標・生の運行情報・秘密値は含めない。
読み取りでもhint bit更新等でdirty/WALが発生し得る。今回のCOUNT/EXPLAINは診断の一回限りで、追加の定期全件スキャンを作っていない。

## 主因

1. Androidは10秒・0mの位置要求。品質条件通過後は停車点も保存しやすく、1点ごとにroute INSERT、receipt INSERT、owner counter更新、複数索引更新が生じる。
2. route点の作成通知を共通1.2秒debounceで同期するため、点が疎に届くと1点ごとにsync。成功batch後の終端空RPCも1回追加される。45秒poll、profile claimも重なる。
3. 7テーブルfeedはowner/change_seq索引を利用するが、旧SQLは初回cursorで大量のJSON化/走査後に全体LIMITする計画になる。
4. sync_v2は空pollでもdevice_profilesの最終時刻を毎回UPDATE。receiptは期限なく保持。
5. 索引が大きいだけでは不要とは言えず、FKや旧互換・保守経路がある。

## 位置点の頻度と変更

現行Android:
- GPS/NETWORK要求10秒、移動距離0m。品質条件: accuracy150m以内、過去120秒以内、未来60秒以内。
- 4秒以内の近接重複、GPS後15秒内NETWORK補完、252km/h超相当の不自然なjumpを品質policyで処理。
- native queueをWebView supervisorが15秒周期で取り込む。バックグラウンド時のJS稼働にはOS制限がある。
- 運行外、休息、フェリー等の既存停止条件は維持。

Web互換:
- 精度重視: 6秒経過または12m移動、accuracy35m。
- 電池重視: 15秒経過または40m移動、accuracy70m。
- 時間と距離は既存OR条件。走行中の品質・間隔は変更しない。

今回の追加抑制:
前回保存点と候補点がともに速度0〜0.5m/s、accuracy35m以内、保存地点から12m以内で、前回保存から60秒未満の場合だけ履歴保存を省く。初回、移動再開、速度不明、精度不足は保存する。60秒ごとに停止heartbeatを保存する。Androidは単調時刻を優先。保存失敗時は保存済み基準を進めない。
品質を通過した全点は高速検知・event位置cache・現在地共有へ引き続き渡す。GPS取得自体の頻度は落とさない。

運行開始終了、積卸、休憩休息、フェリー、高速開始終了などは source=event / event-anchor経路で保存され、今回の間引き対象外。高速終了の確認操作も維持。

直近7日集計: background21,118点、event76点。backgroundの連続区間（0秒超〜300秒以下の21,111間隔）は平均9.77秒、中央値9秒。連続記録区間換算で約61点/10分・368点/時間。長い停止/未記録時間を除くため、全運行平均ではない。速度・精度条件だけ満たす8,389点は見つかったが、12m/60秒条件を含まないため削除可能数とは扱わない。

合成1時間（10秒入力、端点は半開区間）:
- 停車: 360→60点、83.3%削減。10分60→10点。
- 移動: 360→360点。
- 停車削減分は将来のroute/receipt/counter更新も減らすが、本番実削減数はAPK導入後に計測する。

## 同期の変更

- routeの作成/更新だけを初回通知から30秒以内にまとめる。100mutation相当通知で1.2秒へ前倒し。後続点で期限を延長しない。
- イベント/IC補完/日報/運行終了/削除は既存1.2秒優先同期。現在地共有の経路を遅らせない。
- online/resume/manual/pollで既存route timerを取り消す。background移行でも即時開始し、Webとnativeの重複通知を抑制。
- RPC上限420、64round上限、初回pull、bootstrap、hasMore、ack/idempotencyを維持。通常は30秒分程度の小batch、offline backlogは420件分割。
- 完了後の余分な空RPCだけ省略。空pull中に追加されたmutationも再読取して送る。
- 既存offline早期returnでinFlightが残り、復帰しても同期を再開できない不具合を再現して修正。
- runごとのclaimDeviceProfileは維持するが、run減少により呼出回数が減る。認証/端末承認を省略しない。
- background通知は送信開始を試みるだけで、OS休止前完了を保証しない。durable outboxとresume/offline復帰で再送する。

1時間、routeのみ、45秒poll、成功・無遅延・remote backlogなしの合成モデル:
| 点間隔 | 保存数（同じ） | RPC旧→新 | 削減 |
|---|---:|---:|---:|
| 5秒 | 720 | 1,520→160 | 89.5% |
| 10秒 | 360 | 800→160 | 80.0% |
| 20秒 | 180 | 440→140 | 68.2% |

native取り込みはまとめて到着し得るので実機値はモデルと異なる。バッチ化単独ではroute/receipt件数や既存サイズは減らない。

## 本番関数変更・EXPLAIN

各枝で owner_user_id + change_seq を用いて昇順最大1,501件へ制限し、その後従来どおり全体1,501→返却1,500へ絞る。owner別change_seqの一意採番とロックを維持。
初回・protocol変更・last_sync_v2_at未設定または60秒経過時だけdevice_profilesを更新。管理表示時刻は最大約60秒遅れ得る。管理画面15分/120分分類の境界付近で約1分差があり得る。

本番データのfeed SELECTのみEXPLAIN ANALYZE BUFFERS。mutation RPCを診断のために実行していない。owner値はサブクエリで選択し結果に出さない。PostgREST本番関数内部のgeneric/custom planと完全に同じ環境ではない。
| cursor条件 | 旧SELECT ms | 提案SELECT ms | 旧read/hit | 提案read/hit |
|---|---:|---:|---:|---:|
| 差分なし | 125.531 | 61.491 | 4/48 | 1/45 |
| head-100 | 16.001 | 10.253 | 0/68 | 0/55 |
| 初回0 | 4,102.434 | 134.569 | 9,258/11,457 | 0/717 |

初回route走査: 旧132,911行×2loops（約265,822行）→提案592行。索引 idx_trip_route_points_owner_change を利用。小テーブルのseq scanは妥当で索引強制はしていない。
適用済み関数から抽出した初回SELECTの再確認: 248.410ms、read0/hit717/dirtied0/written0。時間は揺れる。キャッシュ状態が違うためread0を恒常的削減と断定しない。バッファアクセス総数は20,715→717（この入力で約96.5%減）。
新旧SELECTの初回/小差分は同一statement snapshotで全JSON・cursor・hasMore一致を確認。
本番適用後、関数本体はmigrationと一致、SECURITY INVOKER、search_path、postgres/service_roleだけのACLを確認。Security Advisorの既存14 INFO/1 WARNに増加なし。RLSポリシー・PK/UNIQUE/索引/テーブル定義は変更しない。
本番tracklog-sync Edge Function v2のソースはローカルと一致することを確認。重点5索引も適用後にすべて存在。Edgeの再デプロイはしていない。

## 重点5索引の判断（今回は全保持）

idx_scan=0の観測窓は全履歴を意味しない。pg_cron未導入。DB外の旧APKや外部運用クエリの不存在までは確認できない。

| 索引（bytes） | 対象クエリ/使用 | 代替・削除影響 | 判断 |
|---|---|---|---|
| idx_trip_route_points_trip_id (33,480,704) | trip_id+ts、旧保守RPCのclosed-trip結合/時刻順、旧互換 | 複合FK索引でtrip_id絞込は可能、ts順は非代替 | 旧クエリ計画/端末確認前は保持 |
| idx_trip_route_points_device_id (29,040,640) | device_id+ts、旧v1互換。現行remoteSync汎用関数は定義のみで呼出確認なし | owner/changeはdevice先頭の代替ではない | 外部/旧端末確認前は保持 |
| idx_tracklog_route_points_trip_device_owner (2,760,704) | route→trip複合FKのON UPDATE/DELETE CASCADE、端末移行 | trip単列は候補絞込のみ。削除でcascade/移行悪化 | 保持 |
| idx_tracklog_mutations_device_owner (2,768,896) | receipt→device複合FK、端末移行、ON DELETE RESTRICT | PK(owner,mutation)でdevice検索不可 | 保持 |
| idx_tracklog_sync_mutations_processed (2,367,488) | 現行code/RPC/Edgeにprocessed_at読取/削除jobなし | receipt重複判定はPK。将来retentionで使える | 最も明確な将来削除候補、未実施 |

主キー、UNIQUE、owner/change索引は保持。新しい冗長索引も作成していない。
将来削除案を採用する場合は外部利用を確認し、索引DDLを保存、1個ずつDROP INDEX CONCURRENTLY、代表SELECT計画とRPC差分を確認する。復旧は同じ定義のCREATE INDEX CONCURRENTLY。対象サイズ相当の空間削減が期待できるが、再作成はCPU/IO/容量を使い即時復旧ではない。上表trip/deviceの2個は合計約62.5MB（10進）の候補にすぎず、削除承認や不要判定はしていない。

## receipt保持方針

現在のreceiptはPK(owner_user_id,mutation_id)で応答喪失・古い再送を同一結果として扱う。
端末別durable ack watermark、送信epoch、古いbackup再送の期限契約がない。last_sync_v2_atとpull cursorは未送信mutationゼロ/応答受領の証明にならない。
従って今回期限削除を実装・実行しない。行数/サイズは維持。

将来案: 端末ごとの送信epoch/ack watermark・inactive扱いと再bootstrap手順を先に導入し、期限切れmutationの再実行を拒否/照合できる契約を作る。長期offline・応答喪失・backup復元・端末移行を試験した後、例として90日以上かつ全対象端末のack確認済みのreceiptを低負荷時間帯に500件ずつ削除する。期間90日/500件は未承認の設計例である。
削除前に対象件数と端末整合を集計し、非公開backupを用意する。receipt削除の復旧には元receiptの復元が必要で、コードrollbackだけでは戻らない。DELETE直後にDBファイルが縮むとは限らない。VACUUM FULL/REINDEX/pg_repackは今回実施しない。

既存の prune_tracklog_cloud_usage は閾値超過時に古いclosed-trip詳細を消す実装があるため、診断に使っていない。既存運用も変更していない。

## 検証

- npm run typecheck / test:logic / test:sync / check:csp / build / check:offline / cap:sync:android 成功。最後のクライアント修正後にもbuild/offline/Capacitor同期を再実行して成功を確認。git diff --check成功。
- PGlite同期統合19 checks: 7bucketそれぞれ1,501件超、11,418 changes・8ページで新旧完全一致。重複/欠落なし。
- 420mutation適用、第二端末取得、同UUID再送duplicate、CAS、削除同期、report復元、active trip、端末移行、owner/承認/ACLを確認。
- profile初回1write後20回連続RPCで追加write0、61秒後1write、protocol移行/null時刻も即更新。
- manual rollback→再適用で件数/返却結果が同じ。
- 実Dexie/outbox+合成transportで初回pull、hasMore、通信中追加/編集、通信失敗再送、初回空pull中追加、offline→online→manual再入を確認。
- Android通常ファイルmirror: JDK21/Gradle8.14.3、assembleDebug + testDebugUnitTest成功。12 suites/85 tests、failure/error/skip0。変更native4ファイルSHA一致。
- Android buildはnativeコンパイルとJUnitの検証。最終APKの公開、携帯更新、実走行、長時間background、通知、実Googleログイン、別端末間の本番通信は未検証。
- 管理一時workspaceはすべて削除確認。最初のWindows PowerShell5.1長パス削除失敗は同じ管理script/IDをPowerShell7で実行して解消。policy拒否の迂回なし。
- 既存Vite dynamic/static import警告は残るがbuild成功。依存更新なし。

## 別チャットとの照合

対象: 「TrackLog修正：IC名と運行終了時刻」
codex://threads/01a0f320-e8cd-74f2-8f6b-09c05ac2c0be?hostId=durable

基点は双方92172ac。相手側はIC再試行の公平性/並行処理/画面通知、終了時刻・日報更新、Cloud CI/release検証を作業中。
照合時点の主変更: repositories.ts、expresswayIcResolution.ts、ReportDashboard/TripDetail/TripRecordedTimes、CSS、CI/Cloud文書。こちらの保存/sync/SQLと主実装ファイルは重ならない。package.jsonのtest登録は今後競合し得るため両者を残す。
最後の進捗確認では、通信復帰時のIC再試行が12件で止まり13件目以降が長時間待つ経路を相手側が修正中。相手チャットは作業継続中で、最終統合結果は未確定。
こちらはIC補完・report変更を優先同期し、全品質accepted位置の高速判定とevent cacheを維持。相手の未完了パッチを取り込んだとは扱わない。
公開前に相手の完成commit/PRと統合し、双方のtest登録・IC再試行と位置anchor・日報同期・offline復帰を再確認する。こちらだけのAPK公開はしていない。

## ロールバックと次回

DB: `docs/sql/rollback-tracklog-sync-v2-reduce-disk-io.sql`を新しいrollback migrationとして適用し、function定義・service_role限定ACL・feedを再確認。データ/receipt/索引はそのまま。migration履歴を削除しない。
新migrationはCLI生成後、Supabaseが採番した本番履歴version20260930165335へローカル名を合わせた。適用時はlock_timeout3秒、statement_timeout15秒を設定。履歴を混乱させる一括db pushを行わない。
クライアント: 本変更のファイル差分だけを戻す。別チャットの変更を戻さない。公開済みになった後の復旧はより大きいversionCodeの新Releaseで行う。
次回測定: 通常運行の同じ長さの窓で calls/total_exec_time/read/dirtied/written/WAL の差分、point数/運行時間、HTTP失敗率、Disk IO Budgetを比較する。pg_stat_statementsをresetしない。SQL例は `docs/sql/measure-tracklog-disk-io.sql`。全件COUNTは毎pollせず必要時1回。
公開/実機検証は両チャットの統合後に既存正式Release/署名/SHA検証とadb install -r手順を守る。活動中の運行を止めたり架空運行を作らない。

Proについて: 今回の計測で直ちに課金変更が必須とは判断しない。まず今回のSQL効果とAPK導入後の実運用差分を測る。ただし無期限receipt/位置履歴は増え続けるため、Freeのまま永久運用できる保証はない。最適化後もBudget枯渇/待ち時間・エラーが続く、または500MB付近へ増える場合は容量方針と計算資源を再評価する。Pro変更は未実施。

## 変更ファイル一覧

1. android/app/src/main/java/com/tracklog/assist/ResidentLocationService.java
2. android/app/src/main/java/com/tracklog/assist/ResidentLocationState.java（コメント）
3. android/app/src/main/java/com/tracklog/assist/ResidentRoutePersistencePolicy.java
4. android/app/src/test/java/com/tracklog/assist/ResidentRoutePersistencePolicyTest.java
5. src/services/routeTracking.ts
6. src/services/routeTracking.test.ts
7. src/app/RemoteSyncBootstrap.tsx
8. src/services/remoteSync.ts
9. src/services/remoteSyncV2.ts
10. src/services/remoteSyncScheduler.ts
11. src/services/remoteSyncScheduler.test.ts
12. src/services/remoteSyncV2.test.ts
13. package.json（test:logic登録）
14. scripts/test-tracklog-sync-v2.mjs
15. supabase/migrations/20260930165335_tracklog_sync_v2_reduce_disk_io.sql
16. docs/sql/rollback-tracklog-sync-v2-reduce-disk-io.sql
17. docs/sql/measure-tracklog-disk-io.sql
18. docs/measurements/supabase-disk-io-2026-10-01.json
19. docs/SUPABASE_DISK_IO_2026-10-01.md（本書）

## 確認した公式資料

- https://supabase.com/changelog.md
- https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes （該当ltree/btree_gist拡張なし。DBバージョン更新は今回対象外）
- https://supabase.com/docs/guides/platform/compute-and-disk （Nano Freeのbaselineとburst budget）
- https://supabase.com/docs/guides/platform/database-size
- https://supabase.com/docs/guides/database/query-optimization
- https://www.postgresql.org/docs/17/sql-explain.html （ANALYZEは実際に実行するため、変更系RPCは避けfeed SELECTを使用）
- https://www.postgresql.org/docs/17/pgstatstatements.html
- https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK
- https://supabase.com/docs/reference/javascript/functions-invoke
- https://capacitorjs.com/docs/apis/app
- https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index
