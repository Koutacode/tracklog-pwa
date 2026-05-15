# TrackLog 配布運用手順

TrackLogは **AndroidはAPK、iPhoneはPWA** で配布する。Androidアプリは Capacitor Native として扱い、パッケージID `com.tracklog.assist` を維持する。

## 0. 事前準備
- PC: Node.js 20+、Android Studio（SDK含む）
- リポジトリを最新に更新: `git pull`
- 依存をインストール: `npm install`

## 1. 標準ビルド手順
```bash
npm run build
npm run cap:sync:android
npm run normalize:android-assets
cd android
.\gradlew.bat -PtracklogAppBuildDir=build-release assembleDebug --no-daemon
```

一括実行する場合:
```bash
npm run release:prepare
```

## 2. 生成物の扱い
- 通常の再ビルド成果物: `output/tracklog-assist-debug.apk`
- 端末から抽出したバックアップAPKは `output/device-backup/` に退避する
- GitHub Release 添付名（固定）: `tracklog-assist-debug.apk`
- `output/*.apk` はGit管理しない（バイナリ混入防止）
- PC上の `src` をビルド元の正とする。端末APKから抽出した `dist` は一時復旧用であり、次回ビルドで上書きしてよい。

## 3. 実機インストール
- Android Studioの `Run` か、APK直接インストールでサイドロード
- 再インストール時は同一署名キーを使用
- 長期運用時はリリース署名鍵を管理する

## 3.1 iPhone PWA 配布
- iPhoneは `https://tracklog-assist.pages.dev` をSafariで開き、「ホーム画面に追加」で利用する
- PWAの管理画面は `https://tracklog-assist.pages.dev/admin`
- Android向けAPKリンクとiPhone向けPWA共有URLは設定画面から共有できる

## 4. ネイティブ権限・安定化
- 位置情報: 常時許可（必要時）
- 通知: 許可
- 電池最適化: 除外推奨
- Exact Alarm: 端末要件に応じて設定
- アプリ内の `ネイティブ設定 > 一括セットアップ / 権限設定を開く` で、常時位置情報・通知・電池最適化・Exact Alarm を確認する

## 5. アプリ基本情報
- appId: `com.tracklog.assist`
- appName: `TrackLog運行アシスト`

## 6. バージョン管理
- Web表示のアプリバージョンは `package.json` の `version`
- Android の `versionCode` / `versionName` は `android/gradle.properties` の `tracklogVersionCode` / `tracklogVersionName`
- 配布前に `versionCode` を必ず増やす

## 7. 現在の配布方針（2026-05-16）
- PC上のソースを正として再ビルドする
- Android配布APK: `output/tracklog-assist-debug.apk`
- iPhone配布PWA: `https://tracklog-assist.pages.dev`
- バックアップ: `output/device-backup/`

## 8. GitHub / Notion 同期
- 同期運用の詳細は `docs/SYNC.md` を参照。
