# TrackLog Local Agent Rules

この `AGENTS.md` は、このフォルダ（`C:\Users\Public\Desktop\Codex専用\NativeApps\TrackLog`）配下でのみ有効。

## Project Scope
- 本アプリは **Android Native専用**（Capacitor）として扱う。
- パッケージIDは `com.tracklog.assist` を維持する。
- PWA向け導線（インストール誘導やPWAアップデータ）は、明示依頼がない限り復活させない。

## Build / Artifact
- 基本ビルド手順:
  1. `npm run build`
  2. `npm run cap:sync:android`
  3. `android\gradlew.bat assembleDebug`（`android` ディレクトリで実行）
- 配布用デバッグAPKは `output/tracklog-assist-debug.apk` を最新化する。

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

## Obsidian / Notion / GitHub Update Policy
- 記録更新の依頼時は、実装反映後に Obsidian / GitHub / Notion の3箇所を更新する。
- UI調整や配布APK更新など、実機反映まで完了した変更は「成功した更新」とみなし、関連ログと配布情報を同じ日に反映する。
- 反映順は原則 `Git 変更確認 -> APK / 実機確認 -> Obsidian ログ更新 -> Notion 更新` とする。
- タスク完了報告の前に、少なくとも1件の Obsidian ログ更新と 3件の Notion ページ更新対象の要否を確認する。
- Notion の TrackLog関連更新対象:
  - `個人アプリ`
  - `TrackLog運行アシスト｜機能・アップデート・配布情報`
  - `改善点`（TrackLogページのサブページとして維持）
- Obsidian の TrackLog関連更新対象:
  - `AI会話/Codex/2026-03-09_Codex-TrackLogとObsidian運用ログ.md`
  - 必要に応じて `仕事/運行記録/運行記録ホーム.md`
- 自動同期:
  - `sync-notion-from-github.yml`（`main` push時に GitHub -> Notion）
  - `sync-github-from-notion.yml`（定期実行で Notion -> GitHub ミラー）

## Local Skill (Project Only)
- リポジトリ内ローカルスキル:
  - `skills/tracklog-release-notion/SKILL.md`
- 補助スクリプト:
  - `skills/tracklog-release-notion/scripts/prepare-tracklog-release.ps1`
- 実行例:
  - `powershell -ExecutionPolicy Bypass -File skills/tracklog-release-notion/scripts/prepare-tracklog-release.ps1 -Build -SyncAndroid -AssembleDebug`
