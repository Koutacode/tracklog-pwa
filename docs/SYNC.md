# GitHub / Notion 更新運用

TrackLog は Notion API token 未設定のため、GitHub Actions による Notion 自動同期は現在使わない。
実装・検証済みの変更は、必要に応じて GitHub / Notion の更新対象を確認し、手動またはAI支援で反映する。
Obsidian は今後更新せず、運用ログ、配布情報、改善履歴は Notion に集約する。

過去に想定していた自動同期 workflow は以下。

1. GitHub -> Notion  
   `sync-notion-from-github.yml`  
   `main` への push 時に Notion 3ページへ更新情報を追記する。  
   追記内容は「アプリ識別情報 / ブランチ / コミット / リリースURL / APK SHA-256 / 主な変更点 / 実機検証結果」。

2. Notion -> GitHub  
   `sync-github-from-notion.yml`  
   毎時17分に Notion の最終更新時刻を `docs/NOTION_SYNC_STATUS.md` へミラーする。

## 必要な GitHub Secrets

- `NOTION_TOKEN`（任意）
- `NOTION_PAGE_TRACKLOG`（未設定時は既定IDを利用）
- `NOTION_PAGE_APPS`（未設定時は既定IDを利用）
- `NOTION_PAGE_IMPROVEMENTS`（未設定時は既定IDを利用）

任意で上書き可能な追記内容:
- `NOTION_CHANGE_ITEMS`（改行または `||` 区切りで 3-6項目推奨）
- `NOTION_DEVICE_VERIFICATION`（実機検証結果の1行要約）
- `TRACKLOG_APP_ID`（既定: `com.tracklog.assist`）
- `TRACKLOG_APP_MODE`（既定: `Android Native (Capacitor)`）
- `LOCAL_APK_PATH`（既定: `output/tracklog-assist-debug.apk`）

`NOTION_TOKEN` が未設定のため:
- GitHub -> Notion 同期 workflow は置かない
- Notion -> GitHub ミラー workflow も置かない
- 運用は「GitHubを正本、Notionは必要時に手動更新」とする

## Notion 集約運用ルール

- 実装と実機反映まで完了した更新は、GitHub / Notion に同日反映する。
- Obsidian の運用ログは今後更新しない。
- 推奨順:
  1. `git status` / 変更確認
  2. Web build / `cap sync android` / 実機反映
  3. Notion 3ページ更新
  4. Git commit / push
- Notion 側の TrackLog ログには、少なくとも「変更概要 / 検証結果 / 実機インストール結果 / 残課題」を残す。

## ローカル実行コマンド

```bash
npm run sync:notion:push
npm run sync:notion:pull
```
