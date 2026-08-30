# TrackLog 配布運用手順

運転者向けTrackLogアプリの正式対応は **Android APKのみ** とする。Androidアプリは Capacitor Native として扱い、パッケージID `com.tracklog.assist` を維持する。管理者Web画面と現在地共有サイトは別用途として維持し、既存PWAは互換・保守目的に限定する。

## 0. 事前準備
- PC: Node.js 20+、Android Studio（SDK含む）
- リポジトリを最新に更新: `git pull`
- 依存をインストール: `npm install`

## 1. 標準ビルド手順
配布候補は、次の順序を崩さずに検査・生成する。

```powershell
npm run typecheck
npm run test:logic
npm run test:sync
npm run check:csp
npm run build
npm run check:offline
npm run cap:sync:android
npm run normalize:android-assets

$tracklogGradleRoot = Join-Path $env:LOCALAPPDATA "TrackLog\android-gradle-release"
$tracklogAppBuildDir = Join-Path $tracklogGradleRoot "build-release"
cd android
.\gradlew.bat `
  "-PtracklogExternalBuildRoot=$tracklogGradleRoot" `
  "-PtracklogAppBuildDir=$tracklogAppBuildDir" `
  --no-daemon `
  :app:testDebugUnitTest `
  :app:assembleDebugAndroidTest `
  :app:assembleDebug
```

一括実行する場合:
```powershell
npm run release:prepare
```

- `release:prepare` は前検査、Webビルド、Capacitor同期、Android unit test、`androidTest` APKのコンパイル、Debug APK生成を順番に実行する。
- `:app:assembleDebugAndroidTest` はアプリ本体のテストAPKだけをコンパイルし、接続端末では実行しない。ルートの `assembleDebugAndroidTest` はサードパーティプラグインのテストAPKまで組み立てて依存競合を起こし得るため使わない。実データがある端末に対して `connectedDebugAndroidTest` を実行しない。
- OneDrive配下でのGradle不調を避けるため、既定のGradle成果物は `%LOCALAPPDATA%\TrackLog\android-gradle-release` に置く。
- helperの相対 `AppBuildDir` は `GradleBuildRoot` 配下のサブディレクトリとして扱う。絶対パスも指定できる。

## 2. 生成物の扱い
- 通常の再ビルド成果物: `output/tracklog-assist-debug.apk`
- ローカル組み立て成功時は `output/tracklog-assist-debug.apk.sha256` も同じAPKのSHA-256へ更新する。
- 端末から抽出したバックアップAPKは `output/device-backup/` に退避する
- GitHub Release 添付名（固定）: `tracklog-assist-debug.apk`
- `output/*.apk` はGit管理しない（バイナリ混入防止）
- PC上の `src` をビルド元の正とする。端末APKから抽出した `dist` は一時復旧用であり、次回ビルドで上書きしてよい。

## 3. 実機インストール
- 運行データを保持する端末では、アンインストールやデータ消去を行わず `adb -s <serial> install -r output\tracklog-assist-debug.apk` で更新する
- 更新後はversionName/versionCode、起動、クラッシュ/ANR、端末の位置情報ON、正確／常時位置情報、通知、電池最適化除外、常駐位置サービス、既存運行データの保持を確認する
- 再インストール時は同一署名キーを使用
- 長期運用時はリリース署名鍵を管理する

## 3.1 GitHub Release APKの検証
```powershell
npm run release:verify:apk
```

- 会社配布URLは `https://github.com/Koutacode/tracklog-pwa/releases/latest/download/tracklog-assist-debug.apk` の1本だけを使用する。過去タグを含むURLやGitHubの過去Release一覧は共有しない。
- `release:verify:apk` は `package.json` と同じタグがGitHubの最新通常Releaseであることを最初に確認し、不一致なら旧APKを正式成果物へ取り込まない。
- `aapt` または `apkanalyzer` でpackage ID `com.tracklog.assist`、versionName、versionCodeを検証する。
- APK内の `assets/public/version.json` が `package.json` と一致することを検証する。
- `apksigner` でAPK署名を内容解析より先に検証し、`TRACKLOG_ANDROID_KEYSTORE_PATH`、既存の正式ローカルAPK、既定debug keystoreの優先順で信頼できる署名と照合する。
- 全検証後に同じ出力ディレクトリへAPKと `.sha256` sidecarをstageし、両方を再確認して同一トランザクションで置換する。片方の失敗時は両方を元へ戻す。
- Android SDK検査ツールまたは信頼できる署名元が無い場合は、配布APKを上書きせずエラーで停止する。
- 公開後は必ず `release:verify:apk` で公開APKを `output/tracklog-assist-debug.apk` へ取り込み、そのファイルを `adb install -r` する。ローカルbuildを先に端末へ入れたまま完了扱いにしない。

## 3.1.1 PC接続なしの会社配布
- 新規端末には「アプリ共有」で表示されるlatest直接URLを送り、Android上でAPKをダウンロードしてインストールする。
- 既存端末は5分周期・画面復帰時の更新確認から同じlatest URLを取得し、Androidの上書きインストール画面を開く。運行データを消去しない。
- 新しい通常Releaseを検知した場合は「最新版をインストール」通知を維持する。利用者が押した後はpackage・署名・versionCodeを確認してAndroidの更新画面へ進む。
- 共有時はGitHub APIで最新通常Releaseと固定名APKを確認する。公開版が共有元アプリより古い場合は共有をブロックし、先にRelease公開を求める。
- GitHub Actionは新版APKのlatest URLとSHA-256を確認してから、過去Releaseにある名前違いを含むすべての `.apk` と `.apk.sha256` assetだけを削除する。タグとリリースノートは残す。
- ロールバックが必要な場合は古いAPKを再配布せず、戻したコードをより大きいversionCodeの新版として公開する。

## 3.2 管理者Web・既存PWA
- 管理者Webは `https://tracklog-assist.pages.dev/admin`
- 管理者WebのGoogleログイン、端末一覧、位置共有状況、管理者からのメッセージ・通知は正式機能として維持する
- 現在地共有サイトは管理者Webとは別用途の正式機能として維持する
- 既存PWAは互換・保守目的で残すが、運転者向け新機能やバックグラウンド記録の保証対象にはしない
- 明示依頼がない限り、PWA配布導線、アップデータ、汎用インストール誘導を拡張しない

## 4. ネイティブ権限・安定化
- 位置情報: 常時許可（必要時）
- 通知: 許可
- 電池最適化: 除外推奨
- アプリ内の段階式端末設定で、未完了の項目だけを1つずつ確認する。各ボタンから対象のAndroid設定へ移動し、TrackLogへ戻った後に最新状態を自動判定する
- TrackLogはExact Alarmを使用しないため、権限・初回設定・診断の対象に含めない

## 5. アプリ基本情報
- appId: `com.tracklog.assist`
- appName: `TrackLog運行アシスト`

## 6. バージョン管理
- Web表示のアプリバージョンは `package.json` の `version`
- Android の `versionCode` / `versionName` は `android/gradle.properties` の `tracklogVersionCode` / `tracklogVersionName`
- 配布前に `versionCode` を必ず増やす

## 7. 現在の配布方針（2026-08-23）
- PC上のソースを正として再ビルドする
- 運転者向け正式配布: GitHubのlatest直接URLから取得できるAndroid APKのみ
- 正式ローカル成果物: 公開Releaseから再取得・検証した `output/tracklog-assist-debug.apk`
- 会社利用者の更新: PC接続を前提とせず、共有URLまたはアプリ内更新から上書きインストール
- 管理者Web: `https://tracklog-assist.pages.dev/admin`（Googleログイン、端末・位置共有状況、管理者メッセージ・通知を維持）
- 現在地共有サイト: 管理者Webとは別用途として維持
- 既存PWA: 互換・保守目的のみ
- バックアップ: `output/device-backup/`

## 8. GitHub / Notion 同期
- 同期運用の詳細は `docs/SYNC.md` を参照。
