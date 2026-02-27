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
- 実機確認を依頼されたら、原則 `アンインストール -> 再インストール -> 起動ログ確認` で再現性を担保する。
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
- 記録更新の依頼時は、実装反映後に GitHub と Notion の両方を更新する。
- Notion の TrackLog関連更新対象:
  - `個人アプリ`
  - `TrackLog運行アシスト｜機能・アップデート・配布情報`
  - `改善点`（TrackLogページのサブページとして維持）

## Local Skill (Project Only)
- リポジトリ内ローカルスキル:
  - `skills/tracklog-release-notion/SKILL.md`
- 補助スクリプト:
  - `skills/tracklog-release-notion/scripts/prepare-tracklog-release.ps1`
- 実行例:
  - `powershell -ExecutionPolicy Bypass -File skills/tracklog-release-notion/scripts/prepare-tracklog-release.ps1 -Build -SyncAndroid -AssembleDebug`
