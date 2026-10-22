# IC修正の隔離試験ビルド準備

2026-10-22 UTC。基準は `b3ea41cdfaa2e14fb6b5693111e11088b925cdce`。
先行のIC修正14ファイルを保持した独立ローカルcloneで、試験branch
`trial/ic-recovery-20261021` を準備した。通常の公開、push、Actions実行、実機導入は
この記録時点では行っていない。管理者機能の削除やCloudflare接続変更は含まない。

## ソースと版の境界

- IC修正は `IC_DETECTION_OUTAGE_2026-10-21.md` に記載した14ファイルと同一。
  先行完全パッチのSHA-256は
  `91f40053353d5c243a83d743a65962b6f7995254cde4dbfb57aa0c78a764c4ea`。
- 試験cloneだけで、package.json、package-lock.jsonのroot2箇所、Androidの
  versionName/versionCodeを **0.1.80 / 78** に揃えた。依存定義の変更はない。
  元の未コミットIC作業ツリーと公開版は0.1.79/code77のまま保持する。
  前日のIC調査記録にある0.1.79はその時点の検証版を指す。
- 追加は試験workflowと本記録のみ。既存のCI/Android Release workflow、
  package ID、署名設定、更新先、Edge Function、DB migrationは変更しない。
- 試験版を将来同一署名で導入した後に戻す場合、データ削除や旧code77への
  downgradeに頼らず、復旧内容をcode78より大きい新APKとして作る計画が必要。
  このローカル準備は正式版のversionCodeを予約・公開する操作ではない。

## 単発workflowの境界

`.github/workflows/android-trial.yml` は正本repoの指定branch初回作成pushのみを
対象とする。非force、非削除、run_attempt=1を要求する。後続push・rerunはjobを
実行しない。mainのSHAとlatest=v0.1.79が変わっていたら署名前に停止する。

標準 `ubuntu-latest` 1job、上限30分、contents:read、cacheなし。
既存のクライアント設定と署名secretは既存runner内だけで利用し、鍵を書き出す先は
runner一時領域だけとする。secretファイルは常時cleanupする。APKのpackage、
versionName/code、同梱version、既存公式単一署名、SHA、コピー後SHAを検査する。
欠けた設定や署名不一致をローカル鍵などで補わず停止する。

成果物はAPK本体20MiB以下とSHA/検証JSONの小さなメタデータだけを1artifactにし、
保持1日、圧縮0とする。ソース、ログ、一時鍵、Google設定JSON、test APK、Web distは
artifactへ含めない。公開repoのコードとartifactは閲覧可能になる。
tag、Release、latest、Pages、Cloudflare、Supabaseの公開操作はない。
既存CIはmain push/PR、既存Releaseはv* tag/main手動実行であり、指定branch初回pushでは
起動しない。手動dispatchやPR作成は試験手順へ加えない。

## 費用・Web配信の読取根拠

- [GitHub公式の料金説明](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
  では公開repoの標準hosted runnerは無料。artifactは共有storage枠を消費する。
- 担当者の02:27–02:30 UTC読取でGitHub Free、Actions予算$0・Usage blocked、
  storage 0/0.5GBが確認されている。設定変更はしていない。今回の小さなartifactを
  無料枠内で生成する想定とし、枠不足・課金条件変更なら停止する。有料runnerや
  予算変更で継続しない。このworkerでbilling画面を再読取した証拠ではない。
- 12:00 UTCの画面確認ではCloudflare `tracklog-assist` のGit repositoryは
  `Connect` 表示で、native Git連携は未接続。旧pages.ymlは現行workflowに存在しない。
  この限定された試験push経路に自動Web公開は見つからない。アカウント全体の
  無関係な自動化を網羅した保証ではない。
- 今回の再読取でもmainは基準SHA、latestはv0.1.79、試験branchとv0.1.80 tagは未作成。
  workflow一覧GETはconnectorのURL allowlistによる400で取得できず再試行していない。
  既存workflowの根拠は先行読取と一致するmainのcommit内容で保持している。

## 最終ソースの検証

- `npm ci`、`typecheck`、全`test:logic`（IC取得48統合試験を含む）、
  `test:sync`（36）、`test:release-apk`（23）、`check:csp`、`build`、
  `check:offline`（39 precache files）、`cap:sync:android`は成功。
- JDK21/SDK36で `:app:testDebugUnitTest :app:assembleDebugAndroidTest :app:assembleDebug`
  が成功。Androidは15スイート136件、失敗・error・skipは0。
- `:app:lintDebug` は失敗。既存MissingPermission 2エラー・55警告で、基準版の
  lint XMLとID/重大度/メッセージ/対象basenameを比較し、新規0・解消0。
  既存エラーの抑制や無関係な修正はしていない。
- 実workflowの静的契約検査4項目、trigger16ケース、危険変更8ケースの拒否、
  bash/Node構文検査、verifier export確認が成功。Actions実行やactionlintの代用ではない。
- 独立読取レビューで、元パッチを基準へ適用した14ファイルと最終ICソースの
  バイト一致、版の整合、試験workflowの限定条件を確認。ブロッカーなし。
  `git diff --check`、元作業と既存APKを含む18保存対象のhash照合も成功。

## 未検証と次の操作

ローカル検証APKは0.1.80/code78、同梱version一致。署名は検証用であり公式鍵ではない。
配布・実機導入対象ではない。既存APKは上書きしていない。正式署名APKのSHAと取得URLは
将来の試験Actions成功後にしか確定できない。

外部操作を再開する場合は、直前に競合・main/latest/試験branch不存在・費用条件を
再照合し、確定した同一commitを指定branchへ1回だけpushする。そのpushが試験jobを
起動するため、別のdispatchは不要。成否不明時はrefとrunを読取確認してから判断し、
branch作り直しやrerunで単発条件を迂回しない。workflow書込権限や既存secretが不足する
場合は停止し、新規権限付与・鍵コピー・設定変更を自動で追加しない。

本番への反映、端末への導入、実際の導入版、画面OFF・実走・通知回答・既存データ保持・
ログインとFCMは未検証。上流地図障害は解消したと扱わない。本人確認なしに自動終了
しないことと手動名・元時刻保持は合成データによる回帰試験で確認した。
Driveへの外部書込みは行わず、本記録とローカル検証ログを保持する。
