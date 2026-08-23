---
name: tracklog-release-notion
description: Prepare, publish, verify, and document TrackLog Android APK releases for this repository, including latest-only company distribution and Notion records.
---

# TrackLog Release + Notes

このスキルは **このリポジトリ専用**。  
対象は `com.tracklog.assist` の会社配布用Android APK。管理者Webと現在地共有Siteは維持するが、運転者アプリの配布物には含めない。

## Quick Start
1. 必要ならビルド/同期/Debug APK作成を実行する。  
   `powershell -ExecutionPolicy Bypass -File skills/tracklog-release-notion/scripts/prepare-tracklog-release.ps1 -Build -SyncAndroid -AssembleDebug`
2. 生成された要約（コミット、APKサイズ、SHA-256、URL）を確認する。
3. GitHubへ通常Releaseを公開し、latest URLから再取得したAPKのversion、versionCode、署名、SHA-256を検証する。
4. 検証済みの公開APKで `output/tracklog-assist-debug.apk` を置換してから、実機へ `adb install -r` する。
5. GitHub反映（commit/push/release）と実機確認後に Notion の以下ページを更新する。
   - `個人アプリ`
   - `TrackLog運行アシスト｜機能・アップデート・配布情報`
   - `改善点`（TrackLog配下）
6. Notion自動同期は `NOTION_TOKEN` がある場合だけ使う。未設定時はNotionを手動またはAI支援で更新する。

## Workflow
1. `prepare-tracklog-release.ps1` を使って、配布情報を定型で作る。
2. 共有URLは `https://github.com/Koutacode/tracklog-pwa/releases/latest/download/tracklog-assist-debug.apk` だけを使用する。
3. 公開前のローカルAPKを会社配布しない。`npm run release:verify:apk` がGitHub latestと現在versionの一致を確認してから正式成果物にする。
4. APKは公開Releaseから再取得した `output/tracklog-assist-debug.apk` を正とし、その同じファイルを実機へ入れる。
5. Obsidian は更新しない。運用ログ、配布情報、改善履歴は Notion に集約する。
6. Notion更新時は以下を必ず記録する。
   - 更新日
   - 主な変更点（3-6項目）
   - 実機検証結果（クラッシュ/ANR有無）
   - ダウンロードURL
   - 必要なら SHA-256

## Project Rules
- 運転者向け配布はAndroid APKのみ。アプリ共有文へPWA案内を入れない。
- 管理者Webと現在地共有Siteは別用途として維持する。
- パッケージIDは `com.tracklog.assist` を維持。
- 新しいversionCodeを公開し、latest URLと公開APKを検証してから会社へ共有する。
- 過去APKをロールバック配布しない。必要なら旧コードをより大きいversionCodeで再リリースする。
- 変更記録は GitHub / Notion に反映し、Obsidian は更新しない。
