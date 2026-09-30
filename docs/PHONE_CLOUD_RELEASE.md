# 携帯からの修正依頼と正式APK更新

対象は `Koutacode/tracklog-pwa`、Androidパッケージは `com.tracklog.assist`。
Cloudでは非秘密の合成データで修正・検証し、本番認証情報、署名鍵、端末DB、画像、正確な座標を持ち込まない。

## 1. 携帯から依頼し、差分をレビューする

1. 修正したい画面、操作、期待する表示、実際の症状を日本語で伝える。非公開の運行データは転記しない。
2. 正常なCloud作業場で最新 `main`、`AGENTS.md`、`docs/CODEX_CLOUD.md`、既存変更を確認する。
3. 修正ブランチで原因を再現し、回帰テストと修正を作る。Cloudタスクは隔離済みなので通常は追加のworktreeを作らない。
4. 修正内容、検証結果、未検証事項を確認してからGitHubへの反映・PRのレビュー・統合へ進む。

2026-10-01時点では、新規環境 `TrackLog-修復` の再公開後も通常タスク作成が
`Unable to determine project root for task` で失敗したとの報告がある。
この会話の `/workspace/tracklog-pwa` は正常なGit rootを持ち、修正・検証できる。
通常タスク開始の復旧は別途プラットフォーム側の確認が必要であり、今回のアプリ修正で解消したとは扱わない。
環境の複製や既存環境の削除・権限変更は行わない。

## 2. 公開前の非本番検証

Node.js 22でリポジトリのルートから実行する。

```bash
npm ci
npm run typecheck
npm run test:logic
npm run test:sync
npm run check:csp
npm run build
npm run check:offline
```

`.github/workflows/ci.yml` はPRとmainでこれらの検証とEdge Functionの型検査を行う。
追加の `android-validation` jobはJDK 21とSDK 36を使い、非本番のWeb資産を同期して
Android unit test、本体APK、アプリのandroidTest APKを検証する。
署名鍵・本番設定を復元せず、APKを公開・会社配布しない。接続端末でのテストも実行しない。

Cloudで完全なJDK 21とSDK 36が使える場合は、次を追加できる。

```bash
npm run cap:sync:android
cd android
bash ./gradlew --no-daemon :app:testDebugUnitTest :app:assembleDebugAndroidTest :app:assembleDebug
```

`java -version` だけでは不十分で、`javac` が必要。
2026-10-01の作業場にはJava 21のJREはあるが `javac` がなく、Androidコンパイルは未検証。
Windows専用のPowerShell・bat手順はLinuxで実行しない。
生成された通常debug APKは正式配布に使わない。

## 3. 承認後に既存Android Releaseを使う

差分レビューとCI成功後、公開対象コミットを確定する。
`package.json` / lockfileのversion、`android/gradle.properties` のversionNameを一致させ、
versionCodeを現在の公開版より大きくする。今回の修正段階ではタグ作成・公開を行わない。

**`v*` タグのpushは既存Android Release workflowを起動し、検証後の公開まで自動で進む。**
タグpushを単なるビルド確認として扱わず、正式公開の承認後に実施する。
workflowは既存のGitHub Secretsから設定と従来の署名鍵を復元する。
Cloudに署名鍵を持ち込んだり、新しい鍵へ置き換えたりしない。

既存Releaseは基本検証、Android unit test・コンパイル、package・version・versionCode、
公式署名SHA256、draftダウンロード一致を確認してから通常Releaseを公開する。
公開後にlatestと固定URLのAPK・SHA sidecarを照合し、過去ReleaseのAPK資産を配布対象から外す。
失敗時のdraftへの復旧も既存workflowに含まれる。

公開後は `docs/ANDROID.md` の検証手順でlatest、version、versionCode、署名、SHAを確認する。
既存のWindows検証は `npm run release:verify:apk`。
Linuxでは `npm run release:verify:apk:linux` が公開latestを一時取得し、
tag・package・versionName・versionCode・公式署名・SHA sidecar・APK内versionを照合する。
Android SDK Build-Toolsの `aapt` / `apksigner`、Java、`curl`、`unzip` が必要。
公開APKの読取検証だけを行い、端末へのインストールや正式成果物の置換はしない。
検証済み公開APKだけを正式成果物として扱う。

## 4. 携帯で利用者が更新する

会社配布URLは次の1本だけを案内する。

https://github.com/Koutacode/tracklog-pwa/releases/latest/download/tracklog-assist-debug.apk

1. 運行が終了していることを画面で確認する。運行中に更新しない。
2. 上のリンクからAPKを携帯へダウンロードする。
3. ダウンロードしたAPKを開く。Androidが求めた場合は、利用するブラウザ等の「不明なアプリのインストール」を許可する。
4. Androidの「更新」または「インストール」を利用者が押す。
5. TrackLogを開き、バージョン、既存ログイン・履歴・日報、必要な位置・通知権限を確認する。

APKの作成だけで携帯へ自動インストール確認が表示される機能はない。
同じパッケージID・同じ署名と、より大きいversionCodeで既存アプリへ上書きする。
署名不一致などで更新できなければ中止し、アンインストール・データ消去・再登録で解決しない。

## 5. 検証と運用記録

Cloud/CI成功は、携帯の起動・ログイン・GPS・IC・通知・バックグラウンド・実走行・電池最適化・更新成功を証明しない。
実機確認は既存データを保持し、架空運行を作らず別工程で実施する。
復旧は旧APKの再配布ではなく、修正版をより大きいversionCodeで公開・照合して上書きする。

Google Driveに接続できる作業場では `TrackLog/<年>/<年月>/` の既存月次文書へ追記する。
接続できないCloudでは `docs/` の非秘密記録を次回Driveへ同期し、未反映を明記する。
