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

相手側は `codex/ic-end-time-repair` の未コミット差分として完了しており、GitHubへのpushは未実施。ローカルからのremote branch照会でも同名branchは見つからなかった。

相手が作成したレビュー用patchは `/workspace/tracklog-pwa/output/review/ic-end-time-repair.patch`、131,739 bytes、SHA-256 `708d8e13165904b766d2a8873fe02dc175beed7ae64cc062147c5be79fbb4621`。Cloud上でreverse applicability checkが通ったことを相手の実行記録で確認した。これはまだローカルで取得・照合したという意味ではない。

利用できる正式ツールには、この別Cloud workspaceのファイルを直接ダウンロードする機能がなく、成果物リンクにも取得用HTTPS URLは付いていなかった。不完全な実行ログからコードを再構築しない。

別チャットへの送信には明示の許可が必要というツール制約があるため、完成差分を作業ブランチへcommit/pushする依頼を送ってよいか利用者へ確認中。APK公開承認とは区別する。返答前に相手へメッセージを送らない。

## 統合後の手順

1. 完成した差分を取得し、基準SHA・変更一覧・完全性を確認する。`package.json`は双方のテスト登録を保持する。
2. IC再試行、日報の部分同期保護、ライブ表示と、位置保存抑制・同期集約・削除同期の整合性を確認する。
3. 型検査、logic/sync/CSP/build/offline、追加回帰、Androidコンパイル・単体試験を統合後のコードで実施する。Windowsの一時ビルドは既存管理workspaceを使う。
4. 公開直前のlatest/tagを確認してversion/versionCodeを増加する。事前確認時は0.1.63/code61であり、0.1.64/code62は候補にとどめる。
5. 確定コミットのCIを確認し、通常の `v*` tag起点のAndroid Release workflowで公開する。workflowが実施するdraft検証、公開latestとsidecar照合、旧APK asset整理まで成功を確認する。
6. `npm run release:verify:apk`でlatest・version・code・署名・SHAを照合し、公開APKで `output/tracklog-assist-debug.apk`を更新する。
7. 既存Google Drive月次ログへ結果を追記して読み戻し、フォローアップ `tracklog-apk`を停止する。

現時点では相手の差分取得、統合テスト、version更新、GitHub反映、APK公開・導入は未実施。既存データ・端末・本番DBへの追加変更は行っていない。

既存の `docs/CLOUD_RESEND_2026-10-01.md` と `error.log` はこの作業のcommit対象に含めず保持する。
