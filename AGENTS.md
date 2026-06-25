# TrackLog Agent Rules

この `AGENTS.md` は `C:\Users\matum\OneDrive\デスクトップ\TrackLog` 配下でのみ有効。

## Current Product Policy
- TrackLog は運行記録アプリ。最重要機能は「バックグラウンドでのルート記録」と「高速道路の開始・終了判定」。
- Android は Capacitor Native の APK として扱う。パッケージID `com.tracklog.assist` は変更しない。
- iPhone は PWA 配布を維持する。共有URLとホーム画面追加の導線は残す。
- PWAアップデータや汎用インストール誘導は、明示依頼がない限り追加しない。

## High Priority Behavior
- 高速道路イベントでは、開始IC名と終了IC名が運行履歴・日報で分かることを優先する。
- IC名解決は、オンライン時に即時実行し、失敗時は既存の再試行ジョブで復旧させる。
- IC候補は `motorway_junction` だけに限定せず、料金所、ETCゲート、高速接続路の名前も補助候補として扱う。
- 高速終了は「終了 / 継続」の確認アクション前提を維持する。
- 診断表示は実態ベースで判定し、黄色固定にしない。
- AI関連の固定文言として `要約してください` を自動挿入しない。

## Build / Artifact
- 基本確認手順:
  1. `npm run typecheck`
  2. `npm run check:csp`
  3. `npm run build`
  4. `npm run cap:sync:android`
  5. `android\gradlew.bat assembleDebug`（`android` ディレクトリで実行）
- 配布用デバッグAPKは `output/tracklog-assist-debug.apk` を最新化する。
- 実機確認や復旧で作った一時スクリーンショット、抽出ログ、検証ファイルは確認後に削除する。
- 恒久保持が必要な端末退避データだけ `output/device-backup/*.tar` のような成果物として残す。

## Device Verification
- 実機確認の既定手順は `adb install -r -> 起動確認 -> ログ確認`。
- 進行中の運行データが残っている可能性がある端末では、ユーザーの明示指示なしにアンインストールしない。
- `アンインストール -> 再インストール` は、データ消失リスクがない検証端末に限る。
- 復旧系の変更では、可能なら先に端末データを退避し、復旧後も `install -r` でクリーンAPKへ戻す。
- 優先確認項目:
  - 起動クラッシュ / ANR がないこと
  - バックグラウンド遷移後もプロセスが維持されること
  - 位置情報 / 通知 / Exact Alarm / 電池最適化除外の状態
  - 高速開始・高速終了イベントにIC名が保存されること

## Notion / GitHub
- Obsidian は更新しない。運用ログ、配布情報、改善履歴は Notion に集約する。
- 作業後は原則として Notion に作業ログを残す。Codex全般の復旧用スキル `notion-second-brain-capture` が使える場合はそれに従う。
- 実装・検証・APK更新・実機確認・GitHub/CI作業・調査判断・重要な設定変更は、最終報告前にNotionへ反映する。
- Notion には、目的、変更ファイル、検証結果、成果物パス、端末状態、判断理由、未解決事項、次回復旧手順を残す。
- 機密情報はNotion保存可。ただし通常はキー名・保存場所・用途・復旧手順を記録し、値そのものは必要時または明示指示時のみ記録する。
- 更新対象は必要に応じて確認する:
  - `個人アプリ`
  - `TrackLog運行アシスト｜機能・アップデート・配布情報`
  - `改善点`
- `NOTION_TOKEN` 未設定のため、GitHub Actions 自動同期は使わない。

## Local Release Helper
- ローカルスキル: `skills/tracklog-release-notion/SKILL.md`
- 補助スクリプト: `skills/tracklog-release-notion/scripts/prepare-tracklog-release.ps1`
- 一括ビルド例:
  - `powershell -ExecutionPolicy Bypass -File skills/tracklog-release-notion/scripts/prepare-tracklog-release.ps1 -Build -SyncAndroid -AssembleDebug`
