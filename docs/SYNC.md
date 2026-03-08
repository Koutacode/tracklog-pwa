# GitHub / Notion 自動同期

TrackLog は以下の2本で同期する。

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

`NOTION_TOKEN` が未設定の場合:
- GitHub -> Notion 同期は自動スキップ
- Notion -> GitHub ミラーも自動スキップ
- 運用は「GitHubを正本、Notionは必要時に手動更新」とする

## Obsidian を含む運用ルール

- 実装と実機反映まで完了した更新は、GitHub / Notion に加えて Obsidian の運用ログにも同日反映する。
- 推奨順:
  1. `git status` / 変更確認
  2. Web build / `cap sync android` / 実機反映
  3. Obsidian ログ更新
  4. Notion 3ページ更新
  5. Git commit / push
- Obsidian 側の TrackLog ログは、少なくとも「変更概要 / 検証結果 / 実機インストール結果 / 残課題」を残す。

## ローカル実行コマンド

```bash
npm run sync:notion:push
npm run sync:notion:pull
```
