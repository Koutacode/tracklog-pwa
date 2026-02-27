# Androidネイティブ運用手順（TrackLog）

TrackLogは **Androidネイティブ専用（Capacitor）** として運用する。PWA配布は行わない。

## 0. 事前準備
- PC: Node.js 20+、Android Studio（SDK含む）
- リポジトリを最新に更新: `git pull`
- 依存をインストール: `npm install`

## 1. 標準ビルド手順
```bash
npm run build
npm run cap:sync:android
cd android
.\gradlew.bat assembleDebug
```

一括実行する場合:
```bash
npm run release:prepare
```

## 2. 生成物の扱い
- 通常の再ビルド成果物: `output/tracklog-assist-debug.apk`
- 端末同一性を固定した保管物: `output/tracklog-assist-debug-exact.apk`
- GitHub Release 添付名（固定）: `tracklog-assist-debug.apk`
- `output/*.apk` はGit管理しない（バイナリ混入防止）

## 3. 実機インストール
- Android Studioの `Run` か、APK直接インストールでサイドロード
- 再インストール時は同一署名キーを使用
- 長期運用時はリリース署名鍵を管理する

## 4. ネイティブ権限・安定化
- 位置情報: 常時許可（必要時）
- 通知: 許可
- 電池最適化: 除外推奨
- Exact Alarm: 端末要件に応じて設定

## 5. アプリ基本情報
- appId: `com.tracklog.assist`
- appName: `TrackLog運行アシスト`

## 6. 現在の確定配布情報（2026-02-27）
- 端末と同一ハッシュの確定APK: `output/tracklog-assist-debug-exact.apk`
- SHA-256: `1BDFAE6F7F65A8854AABFBBE3EC00A9BA624091241CAD45331DBE32CE63EC681`
- 補足: 再構築検証用APKは削除済み。運用基準は `tracklog-assist-debug-exact.apk` のみ。

## 7. GitHub / Notion 同期
- 同期運用の詳細は `docs/SYNC.md` を参照。
