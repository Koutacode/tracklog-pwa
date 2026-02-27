# GitHub / Notion 自動同期

TrackLog は以下の2本で同期する。

1. GitHub -> Notion  
   `sync-notion-from-github.yml`  
   `main` への push 時に Notion 3ページへ更新情報を追記する。

2. Notion -> GitHub  
   `sync-github-from-notion.yml`  
   毎時17分に Notion の最終更新時刻を `docs/NOTION_SYNC_STATUS.md` へミラーする。

## 必要な GitHub Secrets

- `NOTION_TOKEN`
- `NOTION_PAGE_TRACKLOG`（未設定時は既定IDを利用）
- `NOTION_PAGE_APPS`（未設定時は既定IDを利用）
- `NOTION_PAGE_IMPROVEMENTS`（未設定時は既定IDを利用）

## ローカル実行コマンド

```bash
npm run sync:notion:push
npm run sync:notion:pull
```
