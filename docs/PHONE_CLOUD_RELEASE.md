# 携帯からの修正依頼と正式APK公開・更新

対象は `Koutacode/tracklog-pwa`、Androidパッケージは `com.tracklog.assist`。2026-10-01の利用者指示により、携帯からCloudへ依頼したアプリ改善は修正・push・APK作成・正式公開・Google Drive保存まで自律的に進める。個別に調査のみ・公開しないと指定された依頼はその範囲を守る。既に得た公開承認を工程ごとに重ねて求めない。

共通手順は [tracklog-cloud-release skill](../.agents/skills/tracklog-cloud-release/SKILL.md)。Cloudでは合成データを使い、本番の秘密情報・署名鍵・端末DB・画像・正確な座標を持ち込まない。

## 1. 通常Cloudタスクで準備を確認する

修正したい操作、期待する表示、実際の症状を日本語で依頼する。最新main、既存変更、Git root、`AGENTS.md`、共有skillを確認して修正ブランチで作業する。Cloudタスクは隔離済みなので通常は追加worktreeを作らない。他タスクとの同時変更があれば内容を照合して統合する。

```bash
bash scripts/setup-tracklog-cloud.sh --accept-android-licenses
source "${TRACKLOG_CLOUD_DEV_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/tracklog-cloud}/taskdev-env.sh"
git rev-parse --show-toplevel
node --version
java -version
javac -version
gh --version
```

Node22・完全なJDK21・SDK platform36・Build Tools36・ghを使用する。環境のInstall script/Start skillとPublish / Republish、通常タスクでの再確認は [CODEX_CLOUD.md](CODEX_CLOUD.md) に従う。既存のJRE不足やproject root障害は同文書の日付付き履歴に保持し、セットアップ成功だけで通常タスクも修復済みとは判断しない。

## 2. versionを確定して最終検証する

原因を再現し、変更と回帰試験を作る。GitHub最新Release・tag・mainを再確認し、未使用のversionを選ぶ。`package.json` / lockfile、`android/gradle.properties`のversionNameを一致させ、versionCodeを現在の公開版より大きくする。version変更後の最終コードで次を実行する。

```bash
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

`java -version`だけでなく`javac`が必要。Androidコンパイルを任意扱いせず、不足・失敗を解決してから公開へ進む。Windows専用PowerShell・bat手順をLinuxで使わない。確認用debug APKは正式配布に使わない。

## 3. PR・mainのCIを確認し既存Releaseで公開する

1. 変更ブランチをcommit・pushし、main向けPRを作る。既存PRがある場合は更新する。
2. **PRの最終HEAD SHA**に対するCI全ジョブ成功を確認する。追加修正をpushしたら新しいSHAの結果を待つ。
3. 統合後、**実際のmain SHA**に対するCI全ジョブ成功を確認する。PR時点の成功だけで置き換えない。
4. 確定main SHAにversionと一致する`vX.Y.Z`タグを作りpushする。既存タグを上書きしない。
5. 同tag/SHAの既存 **Android Release** が最後までsuccessになることを確認する。

`.github/workflows/ci.yml`のvalidateは基本検証・Edge Function型検査、android-validationは非本番設定によるAndroid単体試験・本体APK・androidTest APKコンパイル、temporary-workspacesはWindowsの一時作業安全性を確認する。CIは端末上の試験を実行した証拠ではない。

**`v*`タグpushは正式公開まで自動実行する操作**。単なるビルド試験として使わない。既存workflowがGitHub Secretsから設定と従来署名鍵を復元し、package・version・versionCode・公式署名・draft再取得を検証後、通常Releaseとしてlatestに公開する。公開latestのAPK・SHA sidecarを照合してから旧ReleaseのAPK資産を配布対象から外す。この最終工程まで成功したことを確認する。失敗時のdraft復旧も既存workflowに従う。

APK公開はEdge Functions・DB migrationを自動適用しない。サーバー変更が含まれる場合は別工程の適用対象・承認範囲・確認結果を明記する。

## 4. 公開APKを照合してDriveへ保存する

Linux検証の既定は読取専用で、検証用一時取得のみ。正式成果物を保存する際は明示的に`--save`を付ける。期待tagはpackage/Gradleの一致したversionから自動決定するため、`--tag`引数は使わない。

```bash
npm run release:verify:apk:linux -- --save
```

latest・tag・package・versionName・versionCode・公式署名・公開SHA sidecar・APK内versionの一致を確認した**同じAPK**とSHAを`output/tracklog-assist-debug.apk`および`.sha256`へ保存する。検証後に別ビルドしたAPKで置き換えない。必要ツールはAndroid Build Toolsの`aapt`/`apksigner`、Java、`curl`、`unzip`。Windowsでは既存の`npm run release:verify:apk`を使う。

Google Driveの既存TrackLog年月フォルダーを探し、非公開の成果物保存先へAPKとSHAをアップロードする。ファイル名にはversionを付け、同じversion・checksumが既にあれば重複作成しない。アップロード後はファイルサイズと利用可能なchecksumを確認し、必要なら再取得してSHA-256を照合する。公開リンク化や共有範囲拡大はしない。既存月次文書へversion/code・commit・CI/Release URL・APK SHA-256・Drive保存先・未検証事項を追記する。

Driveへ保存できない場合は公開完了とDrive未保存を分けて報告し、非秘密の記録を`docs/`へ残す。保存成功を推測しない。秘密情報・正確な座標・生の運行データは含めない。

## 5. 携帯で利用者が更新する

会社配布URLは次の1本だけを案内する。Driveは成果物の保管先として扱う。

https://github.com/Koutacode/tracklog-pwa/releases/latest/download/tracklog-assist-debug.apk

1. 運行終了を画面で確認する。運行中に更新しない。
2. 上記リンクから携帯へダウンロードし、APKを開く。
3. Androidが求めた場合は利用するブラウザ等の「不明なアプリのインストール」を許可し、利用者が「更新」または「インストール」を押す。
4. TrackLogでversion、既存ログイン・履歴・日報、位置・通知権限を確認する。

APK公開だけで携帯の更新確認が自動表示される機能はない。同じpackage ID・同じ署名・より大きいversionCodeで上書きする。署名不一致などで更新できない場合にアンインストール・データ消去・再登録をしない。実機インストールの承認はAPK公開の承認とは別に確認する。許可済みのPCで実機確認する場合はデータを保持する`adb install -r`を使う。

## 6. 完了報告と復旧

Cloud準備、対象SHAのCI、正式Release、公開APK照合、Drive保存、実機確認を区別して報告する。Cloud/CI成功は携帯の起動・認証・GPS・IC・通知・バックグラウンド・実走・電池最適化・更新成功を証明しない。架空運行を実機へ作らず、実動作は別工程で検証する。

復旧は旧APKの再配布ではなく、必要なコードを戻した修正版をより大きいversionCodeで新Releaseとし、同じ公開照合・Drive記録を行う。
