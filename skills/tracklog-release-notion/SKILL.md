---
name: tracklog-release-notion
description: Prepare TrackLog native release updates and Notion update payloads for this repository. Use when asked to update GitHub + Notion records after implementing or validating TrackLog changes, especially for APK refresh, commit metadata, SHA-256 generation, and Notion page changelog updates.
---

# TrackLog Release + Notion

このスキルは **このリポジトリ専用**。  
対象は `com.tracklog.assist` の Android Native 運用。

## Quick Start
1. 必要ならビルド/同期/Debug APK作成を実行する。  
   `powershell -ExecutionPolicy Bypass -File skills/tracklog-release-notion/scripts/prepare-tracklog-release.ps1 -Build -SyncAndroid -AssembleDebug`
2. 生成された要約（コミット、APKサイズ、SHA-256、URL）を確認する。
3. GitHub反映（commit/push）後に Notion の以下ページを更新する。
   - `個人アプリ`
   - `TrackLog運行アシスト｜機能・アップデート・配布情報`
   - `改善点`（TrackLog配下）

## Workflow
1. `prepare-tracklog-release.ps1` を使って、配布情報を定型で作る。
2. APKは `output/tracklog-assist-debug.apk` を最新にする。
3. Notion更新時は以下を必ず記録する。
   - 更新日
   - 主な変更点（3-6項目）
   - 実機検証結果（クラッシュ/ANR有無）
   - ダウンロードURL
   - 必要なら SHA-256

## Project Rules
- PWA導線は復活しない（明示依頼がある場合のみ）。
- パッケージIDは `com.tracklog.assist` を維持。
- 変更記録は GitHub と Notion の両方を同期する。
