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
