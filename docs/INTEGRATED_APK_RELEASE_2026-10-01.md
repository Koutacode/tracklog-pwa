# 統合APK公開の作業記録

実施日: 2026-10-01（日本時間）。対象: `Koutacode/tracklog-pwa`。

## 承認と対象

利用者から、Disk IO最適化と別チャット「TrackLog修正：IC名と運行終了時刻」の完成結果を合わせ、最適化・検証・正式APK公開まで進める指示を受けた。公開について追加の承認は不要。

- ローカル統合ブランチ: `codex/integrated-apk-20261001`
- 両作業の基準コミット: `92172ac720460fb6c3cf1205a784150d69d3d1e6`
- Disk IO側の詳細: [SUPABASE_DISK_IO_2026-10-01.md](SUPABASE_DISK_IO_2026-10-01.md)
- 既適用の本番migration: `20260930165335_tracklog_sync_v2_reduce_disk_io.sql`
- 相手チャット: `01a0f320-e8cd-74f2-8f6b-09c05ac2c0be`、host `durable`
- 完了確認: 2026-10-01 02:41以降の確認で相手のturnが `completed`、chatが `idle`。

## 差分の受け取り状況

相手側は当初 `codex/ic-end-time-repair` の未コミット差分として完了し、GitHubへのpushは未実施だった。受け渡し依頼後、同branchのcommit `58b2af47d57b6ae873b5f04cf8cea10252cc86c3` をGitHub originへpushし、ローカルでもremote SHAと親コミット・25ファイル一覧を確認した。

相手が作成したレビュー用patchは `/workspace/tracklog-pwa/output/review/ic-end-time-repair.patch`、131,739 bytes、SHA-256 `708d8e13165904b766d2a8873fe02dc175beed7ae64cc062147c5be79fbb4621`。Cloud上で作業ツリーとのバイト単位一致・reverse applicability・commit後全25ファイル一致を確認した。ローカルはGit経由でそのcommitを取得した。

利用できる正式ツールには、この別Cloud workspaceのファイルを直接ダウンロードする機能がなく、成果物リンクにも取得用HTTPS URLは付いていなかった。不完全な実行ログからコードを再構築しない。

利用者から「許可する」と明示回答を受け、完成差分を作業ブランチへcommit/pushする依頼を相手チャットへ送信し、受け渡しが完了した。APK公開承認も有効であり、追加の公開確認は不要。

ローカルのDisk IO側20ファイルは `cb8510257dd39feda6fdeeba0eac643759bf37e2` に保存済み。公開環境の再確認でNode 22.19.0、JDK 21.0.10、PowerShell 7、Android Build Tools 34.0.0/35.0.0を確認した。公開latestはv0.1.63、code61、次版候補v0.1.64/code62。統合後SHAのCIとRelease全体の成功を別途確認する。

## 統合後の手順

1. 完成した差分を取得し、基準SHA・変更一覧・完全性を確認する。`package.json`は双方のテスト登録を保持する。
2. IC再試行、日報の部分同期保護、ライブ表示と、位置保存抑制・同期集約・削除同期の整合性を確認する。
3. 型検査、logic/sync/CSP/build/offline、追加回帰、Androidコンパイル・単体試験を統合後のコードで実施する。Windowsの一時ビルドは既存管理workspaceを使う。
4. 公開直前のlatest/tagを確認してversion/versionCodeを増加する。事前確認時は0.1.63/code61であり、0.1.64/code62は候補にとどめる。
5. 確定コミットのCIを確認し、通常の `v*` tag起点のAndroid Release workflowで公開する。workflowが実施するdraft検証、公開latestとsidecar照合、旧APK asset整理まで成功を確認する。
6. `npm run release:verify:apk`でlatest・version・code・署名・SHAを照合し、公開APKで `output/tracklog-assist-debug.apk`を更新する。
7. 既存Google Drive月次ログへ結果を追記して読み戻し、フォローアップ `tracklog-apk`を停止する。

## 統合検証の進捗

相手commitをcherry-pickし、統合commit `3a2b832` として保存した。競合はpackage.jsonのテスト登録のみで、双方を保持して71コマンドに統合した。依存変更はない。versionを0.1.64/code62へ更新した。

型検査、同期19件（7系統11,418変更/8ページ一致・420件冪等再送・rollback/reapplyを含む）、APK検証fixture28件、イベント編集同期、CSP、Web build、offline、cap syncは統合後のコードで成功した。

独立レビューでは、表示用liveQueryの日報読み取りがmutationを作らず、位置点で日報再保存や同期循環が起きないこと、tombstoneと保存の同一transaction、部分同期・所有者境界保護を確認した。日報DB22件、IC投影、snapshot16 assertionsも成功した。イベントACKで日報の追加更新が1回起き得るが日報ACKから循環しない。

追加の統合境界テストでは、旧header ACKの通信中に終了時刻を再修正しても新mutationと新時刻のevent/header/reportが維持されること、report先着のhasMore応答で不完全な日報再保存を抑え、後着event後のIC修正と日報saveがまとまって送信されることを実Outbox・合成transportで確認した。`remoteSyncV2.test.ts`だけへ126行追加した。追加後の型検査と71コマンドのtest:logicも成功した。

Androidは管理workspaceの通常ファイルmirrorでJDK21を使用し、`:app:testDebugUnitTest :app:assembleDebugAndroidTest :app:assembleDebug`が成功した（1分04秒、201 tasks）。JUnit 12 suites/85 tests、failure/error/skipは0。instrumentation APKはコンパイル確認であり実行していない。manifestはcom.tracklog.assist / 0.1.64 / code62。Android source/config/assets145 files、src218 files、dist42 filesはSHA256一致。候補APKは一時内だけで正式outputへ保存していない。

GitHub CI・APK正式公開の結果は後続追記する。実機導入・実走行は未実施。既存データ・端末・本番DBへの追加変更は行っていない。

既存の `docs/CLOUD_RESEND_2026-10-01.md` と `error.log` はこの作業のcommit対象に含めず保持する。

## CIで判明した同一ミリ秒の編集競合

PR #12の初回CI（run 36791477150 / HEAD 575d596）はAndroid・temporary-workspaces成功、logicの日報時刻編集1件が失敗した。日報とeventのlocalUpdatedAtが同一ミリ秒になると、厳密な時刻比較だけでは明示編集を識別できなかった。

新しいapp snapshotのrawJsonに元eventのID/type/ts/mutation IDを保持し、ローカルevent更新には直前mutation IDを1件保持する。日報保護は元IDと後続の直接的な編集、または厳密に後の時刻を要求する。単に時刻比較を >= に緩めたり、異なるUUIDだけで新しい変更と判断したりしない。ICの手動修正も同じ根拠を使う。旧形式の日報の保守的判定は維持し、DB schema migrationは不要。直前mutation IDはevent RPC payloadへ送信しない。

固定した時計で時刻/type編集、automatic IC→manual→再manualを確認した。別IDの同内容イベント、同mutationの古いIC、同IDの古いpending、曖昧な元IDが保存済み日報を巻き戻さないことも確認し、日報repository 26件が成功。型検査・build・offline・cap syncを再実施した。統合logicとCIの再確認は後続追記する。

## 利用者から追加された作業範囲

今回の公開APKは接続携帯へinstall -rで導入する。更新前はSCG34 / v0.1.63 / code61、nativeとWebViewのactive tripなし、初回install日時を確認し、既定output/device-backupへ退避した。退避は稼働中取得で復元試験は未実施。

公開・実機更新後に、Cloudでの編集からpush・正式workflow公開・照合・Drive保存までを再現可能にする環境と共有専用スキルを整備すること、今後のTrackLog改善のpush/公開を任せること、正式APKとSHAをGoogle Driveにも保存することが利用者から明示された。署名鍵や端末退避データはDrive保存対象に含めない。

## 正式公開と接続端末の更新結果

修正後commit `52e36a0c7181f37462da5914fe7f32270ef4b271` のPR [#12](https://github.com/Koutacode/tracklog-pwa/pull/12)で全CI成功（36792593148）。mainへ統合した `468f86c8267a9a44d2611e1114a6f56cb425715b` のCIも全成功（36792798288）。71 logic commands、同期19件、型検査、CSP、build/offline、Android単体・コンパイルと一時領域安全性を確認した。

同じmain SHAのtag `v0.1.64` / versionCode 62で [Android Release 36793176739](https://github.com/Koutacode/tracklog-pwa/actions/runs/36793176739) が全工程成功。2026-10-01 08:53:52 JSTに通常Releaseを公開し、draft再取得・固定署名・公開latest/sidecar照合・旧Release APK資産除去まで成功。API再確認で旧APK/sidecar資産0件。正式ビルドのFCM登録有効を非秘密の実行結果で確認した。

Windows `npm run release:verify:apk -- -Tag v0.1.64`が成功し、同じ公開APKでoutputを更新。公開SHA sidecarも独立取得して一致した。package `com.tracklog.assist`、version 0.1.64、code62、7,422,451 bytes、APK SHA-256 `f3a90bb274e4cfef76909104cf30e50f515cfcf0b13eccd6f662e1f6997787c1`、従来署名 `14121cbf70043af3bd2fe17dd57833ed51b7f5dbf326459dde6b830f07cbb99c`。会社配布URLは既定latest URLのみ。

SCG34は更新直前にnative/WebView/ホームで運行なしを再確認し、08:57:56 JSTに `adb install -r` 成功。端末APK SHA・署名・version/code一致、firstInstallTime不変。既存events1,747、routePoints265,822、reports16、削除tombstone69/11/16を保持し、ログイン・承認・native readiness正常。位置/背景位置/通知/Exact Alarmと電池最適化除外を維持。バックグラウンドでもprocess/foreground serviceを維持し、運行外のGPS listener0、位置点・最終受理/書き込み時刻不変、queue0、保存失敗0。取得ログのFATAL/crash/ANR0。ホームに戻し、ADB forwardと検証用一時領域は片付けた。

端末退避 `output/device-backup/pre-v0.1.64-20261001.tar`（200,221,184 bytes / SHA-256 `3cb08892f43801cd1f76a23383f0b8ee0ede59b21b4523752bb2f65ecb3990e4`）はローカルのみ保持。稼働中退避・復元未試験。実走、実通知受信、複数端末の実E2E、通信断/OS強制終了からの復旧は未検証であり、単体試験やidle確認で代用したとは扱わない。

## Cloud公開手順の整備

共有スキル `.agents/skills/tracklog-cloud-release/`、Linuxセットアップ/オフライン境界試験、公開APK検証の `--save` を追加。既存41件のAPK fixtureとセットアップ7 groupsが成功した。JREのみ、不正JAVA_HOME、Node版違い、SDK/aapt不足、npm ci失敗を成功と報告しない。検証した同一APKとsidecarだけを固定outputへ保存し、途中失敗で既存ファイルを復元する。2ファイル同時atomicや強制終了時の自動復旧は保証せず、必要時は残った専用stagingから復旧する。

この工程は公開済みアプリの実行コード/バージョンを変更せず、Cloud開発・検証手順を整備する。Cloud環境のPublish/Republishと通常タスクの受入結果、Drive保存結果は後続で追記する。

Cloud手順PR [#13](https://github.com/Koutacode/tracklog-pwa/pull/13) / `ee0ccf6a0d8e997e9f3ebbcabfaa6c4d2493aeaa` とmain `da16fa6bb80cb970b8815ee30c0b632d3fda9524`のCI（36794024378 / 36794278123）は全3 jobs success。Linuxオフラインsetup境界と実JDK/SDK preflight、Android単体/コンパイルも成功。共有skillのquick_validateも成功した。

既存非公開Cloud環境「TrackLog-修復」を公式UIで編集し、Install scriptにrepoセットアップ、Start skillに共有skillと承認範囲・検証/公開/Drive手順を保存。`TRACKLOG_CLOUD_DEV_ROOT=/workspace/tracklog-tools/cloud-dev` とその `taskdev-env.sh` を使う。再公開は画面で `Environment published` / `Published` を確認した。ただしセットアップ会話は再公開前後とも実行開始前に `Unable to determine project root for task` となり、Cloudの実JDK/SDK導入・同環境でのAndroidコンパイル・Linux公開APK実検証は未確認。CIの成功と区別する。設定UIにrepository mount_path編集欄は見つからず、内部API探索や別cloneで迂回していない。

新しい通常Cloudチャットの受入試験について利用者から「Cloudチャットを作成して検証する」と明示回答を受けた。再公開済み「TrackLog-修復」で通常タスク開始を試したが、同じroot特定エラーで実行前に失敗し、通常タスクのIDは作成されなかった。元の入力下書きは復元し、空白を正規化した内容一致を確認した。

既存環境を残し、公式作成UIで同じ `Koutacode/tracklog-pwa` / mainを選んで新規セットアップを開始した。セットアップチャット `01a0f4d2-29e2-7420-9e82-b832e6ae208b` は09:16 JSTにコマンド実行まで進んだ。既存環境固有の問題かを比較する試験であり、まだ通常タスクの受入成功とは扱わない。新環境名は「TrackLog-APK」、非公開を維持し、アプリ変更・新Releaseを作らないよう依頼した。Cloudは基本的に高速モードが使えないという利用者の補足も共有skillとガイドへ反映した。

新規セットアップは09:27 JSTに完了。Node 22.23.3、完全なJDK 21.0.12.1/javac、SDK 36/Build Tools 36.0.0、gh 2.46.0を実確認し、基本6検証・同期19件・offline37資産・Capacitor sync、Android単体85件（失敗/skip0）・本体/androidTest APKコンパイルが成功した。再実行も12秒/200 tasks up-to-dateで成功。公開Linux verifierは初回GitHub API取得失敗後の再実行exit0で、公開v0.1.64/code62、7,422,451 bytes、既存署名と上記SHAが一致して正式outputへ保存された。Git追跡差分はなし、新Release/tag/pushも行っていない。

Node公式配布先403はnpm integrity付き配布、JDKは署名/パッケージ検証付きDebian取得で準備した専用パスを使用。SDK/Gradleも専用パスを使い、実行時プロキシのホスト/ポートのみGradle設定へ渡す。HOMEは置換しない。Androidツールの固定`.android`書込先はCloudの正規権限要求で準備し、同じ制限が後続で生じる場合も迂回しない。Install script/Start skillは再実行済み、署名鍵/本番Secrets/端末データを移していない。Cloud検証専用のdebug keystoreは正式署名とは別物。取得・検証に必要な公式配布先15ドメインだけを追加許可した。

親側が公式UIで環境名「TrackLog-APK」・利用者「自分のみ」を確認し、設定保存後にPublish。09:30前後に `Environment published` / `Published` を確認した。しかし、この公開環境を選択した通常Cloudチャットは `Unable to determine project root for task` で開始前に失敗した。公開前から開いていたホーム画面を再読み込みし、環境名と入力を再確認した最後の比較試験も同じエラーとなった。通常タスクID、push dry-run、通常タスクでのDrive能力確認は作成/実行されていない。元の下書きは両試験後に復元し、空白を正規化した一致を確認した。

通常Cloudの再利用受入は未完了。推論量「軽」とは別の開始前エラーであり、ツール導入/設定公開/セットアップ成功を通常タスクの復旧と扱わない。公式Docs/Helpに、このエラーのrepo mountを修復する専用手順は見つからず、公式UI/提供ツールにmount_path編集手段も見つからなかった。内部API/認証ストレージ/別cloneの回避を行わず、未解決エラーの無制限再試行は停止。非秘密の再現資料は [Cloud開始障害の引き継ぎ](CLOUD_START_BLOCKER_2026-10-01.md) に保存した。OpenAIサポートへは未送信。

実際の推論量の設定は変更済みとは報告しない。単純setup/検証は軽でも実行可能、複雑な同期/SQL/認証設計・公開前レビューは利用可能な高を基本とする方針を共有skillとStart skillに保存した。携帯は更新/QA完了後に利用者が接続解除すると連絡したため、以後実機接続を前提とした追加作業はしない。

正式APKとSHA sidecarを [Drive v0.1.64保管フォルダー](https://drive.google.com/drive/folders/1EBCMfIoQ0E3hR7AS_1BcSuGQuvm1by8X) へ保存した（TrackLog/30_リリース・検証/2026/10/v0.1.64）。両ファイル非公開、ownerのみ。DriveからAPKを再取得し7,422,451 bytes / SHA-256が公開・ローカル・端末と完全一致、sidecarも読み戻し一致。既存[10月月次ログ](https://docs.google.com/document/d/1NdOdWZS8nmvOArd8anaCr7qcPP1v3vS_rtWGXp_d8bk/edit)へ公開・端末保持・Drive保存を追記し、既存全文保持/重複なしを確認した。

### サポート送信の後続記録

2026-10-01 09:51前後の追記: 利用者の「許可」により、公式Help Centerへ非秘密の再現資料を送信した。仮想アシスタントの案内で環境画面からの開始を1回比較したが、ホーム画面と同じroot特定エラーを確認。両環境／両経路の結果を返し、人間の担当者へのエスカレーションを操作して `Escalation requested` / `Escalated to a support specialist` を確認した。受付番号は未表示、数日以内の返信とメール通知が案内され、通常Cloud受入はまだ未完了。[送信と追加試験の詳細](CLOUD_START_BLOCKER_2026-10-01.md#公式サポートへの送信と追加試験)に記録した。アプリの正式v0.1.64公開・実機更新・Drive保存は完了済み。利用者の追加指示「最終的に公開まで」と、今後の改善依頼を正式公開まで進める共有skillの承認範囲を維持する。サポート資料の追記で新APKを作らない。

### APK導入後のDB集計観測

2026-10-01 09:07:15 JST、read-only transactionで1回だけ集計値を取得。project/健康/統計開始を確認した。同queryid、同stats_sinceの基準からcalls1,479→1,530、累積平均228.048→226.466ms、shared read4,828→4,828、dirtied23,862→23,961、written2,590→2,591、WAL97,792,444→98,005,309 bytes。差分51回の平均は180.589ms。

位置テーブルのサイズは不変、receipt総サイズは8,192 bytes増加。profile updateは112増加し全件HOT。これらは基準から約7時間25分の累積差分で、旧APKの稼働時間も含む。統計resetはしていない。APK導入後の実走やDisk IO Budget削減率を証明しない。行数は基準時のCOUNT値を使用し、今回全件COUNTを繰り返さない。最新の推定値と正確なCOUNTを混同しない。

復旧はアプリ側の対象変更を戻してversionCodeを増やした新Releaseを同じ手順で公開する。DB関数の復旧SQLは `docs/sql/rollback-tracklog-sync-v2-reduce-disk-io.sql`。インデックス/既存receipt/運行データを削除せず、Freeプランを維持した。

## 変更ファイル一覧

統合APK公開とCloud整備（基準92172ac → 公開tag v0.1.64とCloud手順main da16fa6）の対象。以下の主一覧55件と後続測定1件が、基準から記録commit 7b3c9d9までのGit追跡差分56件に一致する。今回対象外の未追跡2件は含めない。追加の開始障害文書は一覧末尾へ分けて記録する。

- .agents/skills/tracklog-cloud-release/SKILL.md
- .agents/skills/tracklog-cloud-release/agents/openai.yaml
- .github/workflows/ci.yml
- AGENTS.md
- android/app/src/main/java/com/tracklog/assist/ResidentLocationService.java
- android/app/src/main/java/com/tracklog/assist/ResidentLocationState.java
- android/app/src/main/java/com/tracklog/assist/ResidentRoutePersistencePolicy.java
- android/app/src/test/java/com/tracklog/assist/ResidentRoutePersistencePolicyTest.java
- android/gradle.properties
- docs/ANDROID.md
- docs/CODEX_CLOUD.md
- docs/INTEGRATED_APK_RELEASE_2026-10-01.md
- docs/PHONE_CLOUD_RELEASE.md
- docs/REPAIR_2026-10-01.md
- docs/SUPABASE_DISK_IO_2026-10-01.md
- docs/measurements/supabase-disk-io-2026-10-01.json
- docs/sql/measure-tracklog-disk-io.sql
- docs/sql/rollback-tracklog-sync-v2-reduce-disk-io.sql
- package-lock.json
- package.json
- scripts/setup-tracklog-cloud.sh
- scripts/test-setup-tracklog-cloud.sh
- scripts/test-tracklog-sync-v2.mjs
- scripts/verify-latest-release-apk.mjs
- scripts/verify-latest-release-apk.test.mjs
- src/app/IcResolverJob.tsx
- src/app/RemoteSyncBootstrap.tsx
- src/db/db.ts
- src/db/reportRepository.test.ts
- src/db/reportRepository.ts
- src/db/repositories.ts
- src/domain/reportLogic.ts
- src/domain/reportRecordedBoundaries.ts
- src/domain/reportResolvedIc.test.ts
- src/domain/reportResolvedIc.ts
- src/domain/reportSnapshotCompleteness.ts
- src/domain/reportSourceEvents.ts
- src/domain/types.ts
- src/services/expresswayIcResolution.test.ts
- src/services/expresswayIcResolution.ts
- src/services/expresswayIcRetryPolicy.ts
- src/services/remoteSync.ts
- src/services/remoteSyncScheduler.test.ts
- src/services/remoteSyncScheduler.ts
- src/services/remoteSyncV2.test.ts
- src/services/remoteSyncV2.ts
- src/services/routeTracking.test.ts
- src/services/routeTracking.ts
- src/ui/screens/HistoryScreen.tsx
- src/ui/screens/ReportDashboard.tsx
- src/ui/screens/TripDetail.tsx
- src/ui/screens/TripRecordedTimes.tsx
- src/ui/screens/tripRecordedTimes.test.tsx
- src/ui/styles/global.css
- supabase/migrations/20260930165335_tracklog_sync_v2_reduce_disk_io.sql

後続の測定記録で追加したファイル: `docs/measurements/supabase-disk-io-post-apk-2026-10-01.json`。文書上のCloud受入確認は未完了の状態をそのまま保持する。

新規Cloudでも再現した開始前エラーの引き継ぎで追加したファイル: `docs/CLOUD_START_BLOCKER_2026-10-01.md`（合計57件）。
