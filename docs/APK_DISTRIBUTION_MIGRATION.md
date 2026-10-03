# 中止したAPK配布分離の検討・作業履歴

**最新判断：移行を中止し、元の `Koutacode/tracklog-pwa` 自身で配布・更新する方式へ戻す。** 以下の移行手順・認証案は履歴であり、実行しない。現行手順は `PHONE_CLOUD_RELEASE.md` と復帰PRを正本とする。

復帰対象はJS/Androidの更新先、公開APK検証先、既存GITHUB_TOKENで動く元のAndroid Release workflow。移行用公開スクリプトとPAT診断workflowはソースから除去する。更新モーダルの「後で更新する」と回帰試験は保持する。

公開済みv0.1.66は保護する。使用済みのv0.1.67タグと履歴は書き換えず、次回候補をv0.1.68 / versionCode 66とする。この復帰PRは通常CIまでで、merge・正式Release/deployは実行しない。新配布repo、保存済みSecrets/PAT、App登録・install・変数には触れない。元repoは公開のまま維持する。

---


この変更は公開前の実装。基準: `01417a2335736e29b675c0c89659b3d0048e2356`、公開済み `v0.1.66` / versionCode `64`。移行候補は `v0.1.67` / `65`。公開時にmain・最新Release・未使用tagを再確認する。

## 配布先と権限（現在の採用方式）

- ソース／既存署名のActions実行元: `Koutacode/tracklog-pwa`。
- 新しい公開配布専用repo案: `Koutacode/tracklog-releases`。既存repoのfork・mirror・push・履歴コピーを使わず、新規の独立したrepoとして作る。READMEのみの初期commitを作り、個人氏名・メールではなく確認済みGitHub noreplyと公開ハンドルを使う。
- 公開するファイルは `tracklog-assist-debug.apk` と `.sha256` のみ。リリース文は固定文。source commit・changelog・自動生成release notesを新repoへ渡さない。GitHubの自動Source archiveも新repo自身のREADMEだけになる。
- 最新の利用者指示「とりあえず90日でいこ」により、現在は保存済みFine-grained PATを使う。対象は配布repoのみ、Contents Read and write / Metadata Read。元repoのActions repository secret `TRACKLOG_DISTRIBUTION_TOKEN` から公開stepにだけ注入する。
- PAT値をチャット・ローカル・APK・Driveへコピーせず、表示・抽出・試用しない。ビルド前の存在確認には値ではなくbooleanだけを使う。未設定なら停止し、期限切れ・権限不足も公開処理のpreflightで停止する。元repo token、App、ローカル認証等へのfallbackはない。
- 既存PATの期限は親の確認記録では2026-12-31。90日運用の方針変更はtokenの実期限を延長しない。期限前に利用者がGitHubで更新し同名Secretへ保存する運用とし、この作業でtoken発行・更新・期限変更は行わない。
- GitHub App登録・配布repo限定install・`TRACKLOG_DISTRIBUTION_APP_CLIENT_ID` 変数はそのまま保持する。`TRACKLOG_DISTRIBUTION_APP_PRIVATE_KEY` は未設定・利用保留。現在のworkflowはAppもこれらの変数/Secretも参照しない。将来の方式変更は別の承認済み変更で行う。
- 元repoの既存 `GITHUB_TOKEN` は旧repoへの橋渡し公開だけに使う。既存署名Secretと署名フィンガープリントは変更しない。配布repoのPATは公開stepだけへ注入し、Vite/Gradleへ渡さない。
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

## 準備状況の更新（2026-10-03、PR前）

- 親から、新配布repoの作成と、利用者本人による期限2026-12-31の配布repo限定Contents RW / Metadata R資格情報の発行、元repoの`TRACKLOG_DISTRIBUTION_TOKEN`設定完了の連絡を受領。値は参照・抽出・ローカル設定・試用していない。
- 既存GitHub接続でrepoのPUBLIC状態とbranch一覧が空であることを読取確認した。default_branch表示はmainでも実際のbranch/commitはない。公開処理のpreflightは実在commitを要求するため、この状態では公開できない。
- 必要な次の操作は、別途承認のうえ新配布repoにREADMEだけの初期commit/mainを作ること。本文は製品名とAndroid APK配布用途のみとし、ソース・履歴・個人情報は含めない。確認済み公開ハンドル/noreplyをauthor/committerに使う。この段階では実行しない。
- 元repoのworkflowは通常CIとv*タグpush専用Android Releaseの2本。作業branchのみのpushとmain向けdraft PRは通常CIだけを対象とし、tag push・merge・手動公開workflowは行わない。
- 追加差分の個人情報/秘密レビュー、commitのauthor/committerのnoreply照合、最新origin/mainが基準SHAから変わっていないことを確認した。PRと通常CIの結果は親への最終報告で別途記録する。

## GitHub App対応と配布repo初期化（2026-10-03）

- ユーザーの追加承認に従い、既存の通常GitHub認証経路で配布repoにREADMEだけの初期commitを作成。commit `9c4b0b874256ca4c1964633de9707d2d14108952`、main一致・親commit 0・treeはREADME.mdのみ・確認済み公開ハンドル/noreplyのauthor/committerを再取得して照合した。元repoの履歴やソースをコピーしていない。
- App設定は親が準備中。Cloudで新しい秘密値やPATの取得・参照・投入・試用は行っていない。PR #21は短命token方式へ変更し、PATを恒久採用しない。
- 公式actionの現行release/tag commit・入力とpost処理を読取確認した。参照: https://github.com/actions/create-github-app-token/releases/tag/v3.2.0 および同tagのREADME/action.yml/lib/post.js。
- ローカルと通常CIでは合成値だけで未設定拒否・固定repo/最小権限・SHA pin・job後revoke設定・PAT/default/source credentialへのfallback禁止を検証する。実token発行・実失効・正式公開は未検証で、公開承認後に別途確認する。

## PAT方式への復帰（2026-10-03、最新判断）

ユーザーの「とりあえず90日でいこ」を受け、PR #21のworkflowを保存済み`TRACKLOG_DISTRIBUTION_TOKEN`方式へ戻した。Appの過去記録は履歴として保持するが、現行方式は本節と冒頭の記述を正本とする。秘密値は読み出していない。PATの実認証・公開書込みは今回の通常CIでは検証しない。

配布repoの独立README初期commitは作成済み。merge・Release/deploy・元repo非公開化は引き続き未承認。通常CI成功後も、公開前にmergeと正式Releaseの実行承認、公開対象SHA/版/署名/新旧APK照合の確認が必要。端末移行確認と非公開化は別段階のまま保持する。
