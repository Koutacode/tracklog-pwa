# TrackLog を Codex Cloud で修正・公開する

対象リポジトリは `Koutacode/tracklog-pwa`。携帯からのCloud作業でも、修正・検証・GitHub反映・正式APK公開・Google Drive保存まで進める運用とする（2026-10-01 利用者承認）。個別依頼が調査のみの場合は、その範囲を守る。

共通手順はリポジトリ内の [tracklog-cloud-release skill](../.agents/skills/tracklog-cloud-release/SKILL.md) と [携帯からの公開手順](PHONE_CLOUD_RELEASE.md) を参照する。ローカルPCの個人skillはCloudへ自動同期されない。未コミット・未pushの変更もCloudには渡らない。

## 環境の準備と公開

既存のTrackLog環境を編集して再利用し、利用範囲は自分のみを基本とする。セットアップ会話では対象Git rootを確認してから次を実行する。

```bash
git rev-parse --show-toplevel
bash scripts/setup-tracklog-cloud.sh --accept-android-licenses
source "${TRACKLOG_CLOUD_DEV_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/tracklog-cloud}/taskdev-env.sh"
node --version
java -version
javac -version
gh --version
```

必要条件はNode.js 22、完全なJDK 21（`javac`を含む）、Android SDK platform 36・Build Tools 36、GitHub CLI。Androidの取得・コンパイル失敗を「Nodeが動くので完了」と扱わない。失敗した場合は失敗コマンド・配布先・権限を確認し、再実行後に検証する。Windows専用PowerShell・bat手順をLinuxで実行しない。

Install scriptにセットアップコマンドを保存し、Start skillには上記`taskdev-env.sh`のsourceとGit root/toolchain確認を含める。後続の別シェルでも必要に応じてsourceする。GitHub接続は承認済みの認証を使用し、トークン値を表示・記録しない。署名鍵、本番のservice role key、端末DB・正確な座標をセットアップへ持ち込まない。

ネットワークは依存取得・GitHub操作に必要な宛先を確認する。ダウンロード失敗時は対象ホストと認証を切り分け、設定を検証して保存する。保存だけでは通常タスクへ準備済み環境が適用されないため、**Publish / Republish後に新しい通常Cloudタスクから再検証する**。既存タスクは独自の保存状態を持つため、再公開で自動修復されたとは扱わない。[公式Cloud環境手順（2026-10-01確認）](https://learn.chatgpt.com/docs/environments/cloud-environments)

## 通常Cloudタスクの受入確認

「Work in → Cloud → TrackLog」から通常タスクを開始し、Git root、checkout、`AGENTS.md`、共有skillの存在、Node/JDK/SDK/ghを確認する。セットアップ会話内の成功だけを通常タスクの復旧証拠にしない。

```bash
source "${TRACKLOG_CLOUD_DEV_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/tracklog-cloud}/taskdev-env.sh"
git rev-parse --show-toplevel
npm ci
npm run typecheck
npm run test:logic
npm run test:sync
npm run check:csp
npm run build
npm run check:offline
npm run cap:sync:android
(cd android && bash ./gradlew --no-daemon :app:testDebugUnitTest :app:assembleDebugAndroidTest :app:assembleDebug)
```

受入確認だけではtagをpushしない。アプリ修正の公開はversion変更後の最終検証、PRとmainそれぞれの対象SHAのCI成功を経て、既存Android Release workflowへ渡す。手順全体は [PHONE_CLOUD_RELEASE.md](PHONE_CLOUD_RELEASE.md) に記載する。

## 検証範囲と成果物

| 場所 | 確認すること |
| --- | --- |
| 通常Codex Cloud | ソース修正、型・ロジック・同期検証、Webビルド、Android単体試験・コンパイル |
| GitHub Actions | PR/mainの対象SHAのCI、既存設定・署名による正式Android Release、公開latest照合 |
| Android実機 | データ保持更新、起動、認証、GPS・IC・通知・バックグラウンド・実走行 |

Cloudの確認用debug APKは会社へ配布しない。Linuxの`release:verify:apk:linux`は既定では読取検証のみ。明示的な`--save`で、検証した公開APKとSHAを`output`へ保存する。公開APKをDriveの非公開年月フォルダーへ保存し、checksum・version・Release情報を既存月次ログへ追記する。

環境準備やCI成功は実走・実機更新、既存の通常タスク開始障害の復旧を証明しない。APK公開はSupabase Edge FunctionsやDB migrationをデプロイしない。サーバー変更は別途対象・適用結果を確認する。

## 過去の障害と確認範囲

- **2026-09-30**: CloudでNode.js 22、`npm ci`、基本6項目、開発サーバーのHTML/React入口、Capacitor syncが成功。同期試験12項目・offline37資産は当時の結果。SDK36とBuild Toolsは導入できたがJava21はJREのみで、JDK取得403・Maven Central429により`assembleDebug`は未成功だった。これは現在のAndroid必須条件を免除する根拠にはしない。
- **2026-10-01（旧手順の作業場）**: Java21のJREはあったが`javac`がなくAndroidコンパイル未検証。`TrackLog-修復`再公開後も通常タスクが`Unable to determine project root for task`で開始できないとの報告があった。一方、セットアップ側の`/workspace/tracklog-pwa`は正常なGit rootで修正・検証できた。両者を区別し、今後の通常タスク成功を確認するまで復旧済みとは記録しない。

## 運用記録

Google Driveの既存 `TrackLog/<年>/<年月>/` または既存月次分類を再利用し、重複文書を作らず追記する。APKは検証済みの同一ファイル・SHAを保存し、共有範囲を拡大しない。Drive接続が使えない場合は`docs/`に非秘密の引き継ぎを残し、Drive保存未完了と次の同期手順を明記する。秘密値、正確な座標、生の非公開運行データは記録しない。
