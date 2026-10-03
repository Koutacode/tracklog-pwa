# ソースと公開APKの段階分離

この変更は公開前の実装。基準: `01417a2335736e29b675c0c89659b3d0048e2356`、公開済み `v0.1.66` / versionCode `64`。移行候補は `v0.1.67` / `65`。公開時にmain・最新Release・未使用tagを再確認する。

## 配布先と権限（設定は未実施）

- ソース／既存署名のActions実行元: `Koutacode/tracklog-pwa`。
- 新しい公開配布専用repo案: `Koutacode/tracklog-releases`。既存repoのfork・mirror・push・履歴コピーを使わず、新規の独立したrepoとして作る。READMEのみの初期commitを作り、個人氏名・メールではなく確認済みGitHub noreplyと公開ハンドルを使う。
- 公開するファイルは `tracklog-assist-debug.apk` と `.sha256` のみ。リリース文は固定文。source commit・changelog・自動生成release notesを新repoへ渡さない。GitHubの自動Source archiveも新repo自身のREADMEだけになる。
- 新repo作成後、Settings → Developer settings → Personal access tokens → Fine-grained tokensで、有効期限付き・対象repoを新配布repoだけ・Repository permissionsのContentsをRead and writeとする資格情報を作成する。MetadataのReadは必須の付随権限。他repo・Actions・Administration権限は付けない。
- ソースrepoのSettings → Secrets and variables → Actionsに、repository secret `TRACKLOG_DISTRIBUTION_TOKEN` として設定する。値をチャット・ローカル・APK・Driveへコピーしない。**新規の永続認証と権限なので、作成・設定には別途ユーザー承認が必要。今回作成しない。** 期限切れ時の更新担当を決める。
- 既存 `GITHUB_TOKEN` は旧repoへの橋渡し公開だけに使う。既存署名Secretと署名フィンガープリントは変更しない。クロスrepo tokenは公開stepだけの環境変数で、Vite/Gradleへ渡さない。
- 課金プランは変更しない。将来の非公開ソースrepoでのActions利用枠・費用は、その段階で確認する。

## 段階1: bridge

`package.json.tracklogRelease.migrationPhase = "bridge"`。JSは新repoのAPI/latestを参照し、Androidは新旧の固定latest APK URLだけを完全一致で許可する。認証付きダウンロードは実装しない。package IDは `com.tracklog.assist` のまま。

1. 新配布repoの独立した初期履歴と公開状態、認証、PR最終SHAのCIを確認する。今回の依頼ではmerge・tag push・releaseは承認待ち。
2. 承認後、既存Android Release workflowで、既存署名・増加versionCodeの移行APKを一度だけビルドする。package/version/code/署名を検証する。
3. 両repoの事前検査後、新配布repo自身のdefault branchのcommitをtargetとしてdraft/tagを作る。APKとSHAをupload・再取得・バイト照合する。
4. 新repoを通常Release/latestとして公開し、**認証なし**でlatest tag・APK・SHAの一致を確認する。失敗時はそのrelease IDをdraftへ戻し、draft状態を確認する。
5. 同じローカルAPKとSHAを旧repoのtag/SHAへdraft公開し、同じ検証を行う。旧端末は従来URLでこの移行APKを取得し、更新後は新repoを確認する。
6. 両方成功して初めて、新配布repoの過去の固定APK／SHA資産だけを削除する。**旧repoのlatest・過去APKは一切削除しない**。
7. 公開APKを次のコマンドで独立に再検証する（新旧で同一SHA）。正式公開前のローカルdebug APKは配布しない。

```bash
npm run release:verify:apk:linux -- --save
npm run release:verify:apk:linux -- --legacy
```

Windows: `npm run release:verify:apk` と `npm run release:verify:apk -- -Legacy`。Windows実行確認は別途必要。

利用者向けの新しい通常配布URL:
`https://github.com/Koutacode/tracklog-releases/releases/latest/download/tracklog-assist-debug.apk`

旧端末の移行中だけ維持する入口:
`https://github.com/Koutacode/tracklog-pwa/releases/latest/download/tracklog-assist-debug.apk`

## 段階2: distribution（未実施）

全必要端末の移行確認は親が調整する。同一署名のデータ保持更新・新repoへの更新確認・ログイン／運行履歴／日報／位置・通知権限を確認する。端末へインストール・アンインストール・データ削除はこの作業では行わない。

移行確認後、別のレビュー済み変更で `migrationPhase` を `distribution` にする。以後workflowは旧repoへの作成・検証・公開・削除を行わない。非公開化の前にこの構成で新配布先だけの更新経路を検証する。元repo非公開化は別途承認・実行する作業であり、このコードは可視性を変更しない。履歴書換え・DB変更も行わない。

## 失敗と復旧

- 新repoの検証が失敗したら旧repoを変更しない。旧端末は旧latestから利用を継続できる。
- 旧repoへの橋渡しが失敗した場合、既に検証済みの新repoは公開のまま保持する。旧repoの失敗releaseだけをdraftへ戻す。新旧は一時的に異なるtagになり得るため、完了とは報告しない。
- 同じ公開済みtagへの再実行は拒否する。片側だけ公開された場合も、公開済み資産を上書きせずversion/codeを増やした新Releaseで復旧する。非公開draftだけなら再試行できる。
- rollback自体が確認できない場合はCRITICAL失敗とする。release IDの状態・latest・旧APK可用性を手動確認してから復旧する。自動で旧APKを削除しない。
- 新repoの旧資産削除が部分成功後に失敗しても、検証済みlatestをdraftへ戻さない。workflowは失敗として残し、latestを保持したまま削除残件を確認する。旧repoの橋渡し資産は常に保護する。
- 更新モーダルは「後で更新する（通常利用を続ける）」で閉じられる。同じ版はその起動中に周期・復帰確認で再表示しない。新しい版または再起動で再通知する。取得失敗、更新確認の403/404/500、許可待ちでも通常利用へ戻れる。

## 公開前に残る確認

公開repo作成と履歴、認証追加の承認、PR/CI、署名済み正式ビルド、新旧公開APK照合、全必要端末の移行確認。ローカルdebugビルドは署名済み正式品の証拠ではない。ブラウザ競合回避のため視覚UI・実機は未検証。

Google Driveへの反映は親側で既存月次文書へこの非秘密の記録を追記する。今回のCloud作業からDrive保存完了とは扱わない。APKを保存する場合は正式公開後に検証した同一バイトとSHAだけを非公開保存する。

## ローカル検証記録（2026-10-03）

- 基準SHAは作業開始時のorigin/mainと一致。開始時の未コミット差分なし。
- Node 22.23.3 / javac 21.0.12.1 / Android SDK 36のpreflight成功。`npm ci`成功。
- `npm run typecheck`、`test:logic`、`test:sync`（24件）、`check:csp`、`build`、`check:offline`（38資産）成功。
- `npm run test:release-apk`: APK検証43件、公開処理14件成功。旧repo指定、匿名ダウンロード、対象別資格情報、clean repoのtarget SHA、draft/公開失敗、rollback失敗、清掃失敗時のlatest維持を合成データで検証。ネットワークへの書込みなし。
- モーダルのReactコンポーネント試験成功。更新失敗後に閉じ、背後の通常操作が応答すること、同じ版の再通知抑止、新しい版の再通知、許可待ちから閉じる操作、API 403/404/500を確認。
- `cap:sync:android`後の`:app:testDebugUnitTest`（85件、失敗0）、`:app:assembleDebugAndroidTest`、`:app:assembleDebug`成功。ローカルAPKのmanifestはpackage `com.tracklog.assist` / versionName `0.1.67` / versionCode `65`、内包version.jsonも `0.1.67`。
- workflowのYAML読込・bash構文検査、`git diff --check`成功。
- React test rendererの非推奨通知とテスト用Capacitor plugin二重登録通知あり。合成テストの警告であり、本番ブラウザのconsole検証結果ではない。
- 新配布repoは現在のGitHub接続で404。作成・権限追加は行っていない。正式署名の新APK・公開照合・GitHub CI・Windows PowerShell・視覚UI・実機は未検証。
- push/PR/merge/tag/Release、可視性変更、履歴書換え、DB変更、端末操作、追加認証、課金変更は実施していない。GitHub Secretsや既存署名鍵を抽出していない。
