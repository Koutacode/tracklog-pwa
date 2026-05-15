# TrackLog Local Agent Rules

この `AGENTS.md` は、このフォルダ（`C:\Users\matum\OneDrive\デスクトップ\TrackLog`）配下でのみ有効。

## Project Scope
- 本アプリは **AndroidはAPK、iPhoneはPWA** で配布する。
- Androidアプリは Capacitor Native として扱う。
- パッケージIDは `com.tracklog.assist` を維持する。
- iPhone向けPWA導線（共有URL、ホーム画面追加の案内）は維持する。
- PWAアップデータや汎用インストール誘導は、明示依頼がない限り追加しない。

## Build / Artifact
- 基本ビルド手順:
  1. `npm run build`
  2. `npm run cap:sync:android`
  3. `android\gradlew.bat assembleDebug`（`android` ディレクトリで実行）
- 配布用デバッグAPKは `output/tracklog-assist-debug.apk` を最新化する。
- 実機確認や復旧で作ったスクリーンショット、抽出ログなどの一時ファイルは、確認後に削除する。恒久保持が必要なものだけを `output/device-backup/*.tar` のようなバックアップ成果物として残す。

## Device Verification
- 実機確認を依頼されたら、既定は `adb install -r -> 起動確認 -> ログ確認` とする。
- 進行中の運行データが残っている可能性が少しでもある端末では、ユーザーの明示指示がない限りアンインストールしない。
- `アンインストール -> 再インストール` は、データ消失リスクがないことを確認済みの検証端末に限る。
- 復旧系の変更を反映する場合は、可能なら先に端末データを退避し、復旧後も `install -r` でクリーンAPKへ戻す。
- 優先確認項目:
  - 起動クラッシュ/ANR がないこと
  - バックグラウンド遷移後もプロセスが維持されること
  - 位置情報/通知/Exact Alarm/電池最適化除外の状態

## Product Constraints
- 最重要要件は「バックグラウンドでのルート記録」と「高速道路イベント判定」。
- 高速終了は確認アクション（終了/継続）前提を維持する。
- 診断表示は実態ベースで判定し、黄色固定にならないようにする。
- AI関連の固定文言として `要約してください` を自動挿入しない。

## Notion / GitHub Update Policy
- 記録更新の依頼時は、実装反映後に GitHub / Notion を更新する。
- Obsidian は今後更新しない。運用ログ、配布情報、改善履歴は Notion に集約する。
- UI調整や配布APK更新など、実機反映まで完了した変更は「成功した更新」とみなし、関連ログと配布情報を同じ日に Notion へ反映する。
- 反映順は原則 `Git 変更確認 -> APK / 実機確認 -> Notion 更新` とする。
- タスク完了報告の前に、3件の Notion ページ更新対象の要否を確認する。
- Notion の TrackLog関連更新対象:
  - `個人アプリ`
  - `TrackLog運行アシスト｜機能・アップデート・配布情報`
  - `改善点`（TrackLogページのサブページとして維持）
- Notion自動同期:
  - 現状は `NOTION_TOKEN` 未設定のため GitHub Actions 自動同期は使わない。
  - 必要な更新は、実装/検証後に手動またはAI支援で対象ページを確認して反映する。

## Local Skill (Project Only)
- リポジトリ内ローカルスキル:
  - `skills/tracklog-release-notion/SKILL.md`
- 補助スクリプト:
  - `skills/tracklog-release-notion/scripts/prepare-tracklog-release.ps1`
- 実行例:
  - `powershell -ExecutionPolicy Bypass -File skills/tracklog-release-notion/scripts/prepare-tracklog-release.ps1 -Build -SyncAndroid -AssembleDebug`
