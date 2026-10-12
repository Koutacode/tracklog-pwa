# Google運転者登録の検証

## 変更後の動作

- Googleを初回登録の入口とし、サーバーで確認したアカウントからメールを取得する。名前・自己申告の電話番号・車番を入力する。電話番号を本人確認済みとは扱わない。既存メールOTP復旧、管理者Googleログイン、管理者判定、新端末の承認は維持する。
- 確定前の認証候補は試行IDごとに保存先・PKCE・通知先を分離する。callbackの宛先、nonce、期限、phaseを検証し、既存Web／native認証へ混入させない。取消は候補だけを破棄する。
- 確認済みuser IDを既存DB／nativeの所有者と照合し、メールが同じでもIDが異なる場合は拒否する。確定・取消・再認証を試行IDに結び付け、古い画面から別の候補を操作できないようにする。
- Google開始、OTP／callback完了、登録、SDK保存を用途別のWeb Locksで直列化する。既存の同一所有者の通常refreshは維持し、確定前に新しいnative資格情報を適用しない。
- 明示確定後は保存済みのcommitting記録から同じIDで再開する。active認証、native、profile、承認申請の保存は一括transactionではないため、途中保存をUIに示し、失敗後は同一候補で再試行する。
- claimの初回登録はINSERTと主キー制約で競合を拒否する。既存行は更新日時・所有者・承認情報が読取り時と一致する場合だけUPDATEする。競合は409として返し、先行登録や管理者の承認・却下を上書きしない。API・SQL migration・権限は追加しない。

## 合成試験

Node.js 22、既存Auth SDK、合成アカウント・通信・DB・native bridgeを使用する。fixtureに実ユーザーや端末データは使用しない。

`npm run test:driver-google` はGoogle登録49条件とclaim処理8条件の計57条件を検証する。

- 新規登録、既存の同一／異なる所有者、native側だけに残る認証、取消、期限切れ、遅延callback／refresh、保存失敗と再試行。
- 古い候補画面からの操作、owner pinとDB／nativeの所有者不一致、既存認証との登録排他。
- 8つの保存中断点から別Nodeプロセスで再構成し、運行・経路・日報・削除tombstone・未送信mutation・profileの保持を照合。
- 同一／異なる所有者による初回claim競合、読取り後の管理者承認／却下、メール一致・user ID不一致の拒否。
- 実handlerで受理したサーバー状態を保持して応答だけを喪失させ、再送時の所有者・申請時刻・承認状態を確認。

claim試験はTypeScript ASTから実handlerを抽出し、既存migrationと更新日時triggerを適用したPGliteで実行する。変更前に4件の競合不具合を再現し、修正後は8条件が成功した。

0.1.73 / versionCode 71のローカル候補では、Node.js 22.23.3で `typecheck`、`test:logic`（上記57条件を含む全81コマンド）、`test:auth-enrollment`（19件）、`test:sync`（36件）、`test:release-apk`（44件）、`check:csp`、`build`、`check:offline` がすべて成功した。検証は追跡ファイル458件が作業ツリーと一致する分離コピーで実施し、生成した `dist/version.json` の版も0.1.73だった。元の作業ツリーが試験で変化していないことを照合した。独立した差分レビューでは版番号の整合、依存関係の不変、既存認証・データ保持・claim試験の範囲を確認した。

## 検証の限界と配布前の確認

- React描画試験は実ブラウザDOMではない。Web Locksの合成試験は実ブラウザ複数タブを保証しない。実OAuth、callback URLの許可設定、Androidでのログイン・復旧は別途確認が必要。
- 再構成試験はAuth専用IndexedDBの独立コピーやOSの書込み耐久性を再現しない。profile一部保存は既存値を再保存する条件である。
- PGliteと最小PostgREST adapterの試験は、実HTTP gateway、JWT検証、本番RLS、実PostgREST競合の検証ではない。409の後は登録再試行が必要で、透過的な成功には変換しない。
- 今回は0.1.73 / versionCode 71への版整合とローカル検証までで、commit・push・PR更新・マージ・tag・Release・本番デプロイは行っていない。変更は `package.json`、`package-lock.json`、`android/gradle.properties` と本書の4ファイルに限定し、依存関係や登録処理を追加変更していない。
- ローカルの `bash scripts/setup-tracklog-cloud.sh --check` は完全なJDK 21（javaとjavac）がないため失敗した。ツールの追加導入やAndroidコンパイルは実施していない。これはローカル環境の制約であり、ActionsのAndroidビルド失敗を意味しない。
- [PR CI run 38263862712](https://github.com/Koutacode/tracklog-pwa/actions/runs/38263862712) はHEAD `d64f919ea9d5cc13184e85e1d768b8043b0cecb5` で3ジョブすべて成功し、Android単体試験・本体／androidTest APKコンパイルも成功している。このCI結果は今回の未commitの版番号変更を含まない。
- [既存v0.1.72のAndroid Release run 37473444270](https://github.com/Koutacode/tracklog-pwa/actions/runs/37473444270) は、既存署名によるビルド、package ID・版番号・署名の検査、公開後のlatest APK検証まで成功している。既存の配布経路の成功証拠であり、0.1.73のAPK生成・署名・公開を検証したものではない。CI用APKと正式配布APKも区別する。
- package ID、配布URL、正式Release workflow、認証・権限設定は維持する。本番Edge Functionの再デプロイは行わない。正式公開時は署名・版番号・SHA・固定latest URLを照合する。
- 正式配布前には既存署名との互換性とversionCodeを確認し、許可された検証端末で上書き更新する。既存認証・運行・日報・未送信queue・profileの保持、管理者／OTP、承認、バックグラウンド位置記録、通知、APK更新を実測する。
- 外部preview連携は未確認。外部文書への作業記録の反映は今回の範囲に含めていない。
