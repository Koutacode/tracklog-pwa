# TrackLog を Codex Cloud で修正する

対象リポジトリ: `Koutacode/tracklog-pwa`。ローカル PC と Cloud で同じ GitHub のコードを使う。未コミット・未 push のローカル変更は Cloud に自動では渡らない。

## 環境の作成

ChatGPT / Codex の「設定 → Codex Cloud → 環境を作成」で対象リポジトリを選ぶ。既存の TrackLog 環境がある場合は編集して再利用する。環境名は `TrackLog`、利用範囲は自分のみを基本とする。

セットアップ会話には次を指定する。

```text
Koutacode/tracklog-pwa を修正できる環境を準備してください。
リポジトリの AGENTS.md に従い、日本語で報告してください。
まず Node.js 22 と npm を用意してください。
npm ci を実行し、typecheck、test:logic、test:sync、check:csp、build、check:offline を確認してください。
Android コンパイルも必要な場合は JDK 21（javac を含む）と Android SDK platform 36、ビルドツールを用意してください。
JDK/SDK が利用できれば npm run cap:sync:android の後、android ディレクトリで bash ./gradlew assembleDebug を実行してください。
Android ツールの取得に失敗しても、通常の Node.js セットアップは成功する構成にしてください。
本番の秘密情報・署名鍵・端末データは追加せず、APK公開・本番デプロイ・実機更新は行わないでください。
実行できなかった検証は、理由を含めて未検証と報告してください。
```

インターネット設定は依存関係の取得に必要な Package managers を基本とし、不足する配布ホストは失敗ログを確認して追加する。セットアップの成功を確認し、環境を Publish する。保存だけでは新しい Cloud タスク用の公開環境にならない。

## 修正するとき

「Work in → Cloud → TrackLog」を選び、修正内容を依頼する。修正ブランチと PR を使い、差分と CI を確認して main へ取り込む。ローカルへ戻るときは未コミット変更の有無を確認したうえで `git pull --ff-only` する。

初回確認の依頼例:

```text
AGENTS.md と docs/CODEX_CLOUD.md を読み、TrackLog の開発環境を確認してください。
npm run typecheck と npm run test:logic を実行し、結果を日本語で報告してください。
コード変更、リリース、本番データへの接続は不要です。
```

## 検証範囲

| 場所 | 主な確認 |
| --- | --- |
| Codex Cloud | ソース修正、型検査、ロジック・同期テスト、Webビルド、SDK導入済みならAndroidコンパイル |
| GitHub Actions | PR/main の CI、正式な署名・設定を使う既存 Android Release |
| ローカルPCとAndroid実機 | 公開APK照合、データを保持する `adb install -r`、実機起動、GPS・IC・通知・実走行 |

Cloud の確認用 APK は会社向けに配布しない。正式リリース、公開 latest の SHA・署名・バージョン検証、実機更新の手順は `AGENTS.md` に従う。セットアップで既存のアプリバージョンや公開 APK を変更する必要はない。

### 初回セットアップの実測（2026-09-30）

Cloud 上で Node.js 22 の `npm ci`、上記6項目、開発サーバーのHTML/React入口応答、Capacitor sync が成功。同期テスト12項目、offline検査37資産を確認した。

Android SDK 36 と Build Tools はプロキシ設定後に導入できたが、既存 Java 21 は JRE のみだった。JDK の取得先が403、Maven Centralが429を返したため、`assembleDebug` は未成功。Androidコンパイルは通常環境の必須条件にせず、必要時にJDKと取得先の到達性を再確認する。SDKの存在だけでAPKをビルドできるとは判断しない。

## 運用記録

Google Drive の `TrackLog/<年>/<年月>/` にある既存作業ログへ追記する。Cloud から Drive に接続できない場合は `docs/` に非秘密の引き継ぎを残し、ローカルで Drive へ反映する。秘密値、正確な座標、生の非公開運行データは記録しない。

公式手順（2026-09-30 確認）: https://learn.chatgpt.com/docs/environments/cloud-environments
