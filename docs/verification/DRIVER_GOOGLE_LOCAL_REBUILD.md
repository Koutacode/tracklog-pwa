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

最終ローカル回帰では `typecheck`、`test:logic`（上記57条件を含む全81コマンド）、`test:auth-enrollment`（19件）、`test:sync`（36件）、`test:release-apk`、`check:csp`、`build`、`check:offline` が成功した。独立した差分レビューとclaim／応答喪失試験も実施した。

## 検証の限界と配布前の確認

- React描画試験は実ブラウザDOMではない。Web Locksの合成試験は実ブラウザ複数タブを保証しない。実OAuth、callback URLの許可設定、Androidでのログイン・復旧は別途確認が必要。
- 再構成試験はAuth専用IndexedDBの独立コピーやOSの書込み耐久性を再現しない。profile一部保存は既存値を再保存する条件である。
- PGliteと最小PostgREST adapterの試験は、実HTTP gateway、JWT検証、本番RLS、実PostgREST競合の検証ではない。409の後は登録再試行が必要で、透過的な成功には変換しない。
- このPRはソースレビューと既存CIによる検証を対象とする。CIのAndroid単体試験・本体／androidTest APKコンパイル結果はPRのChecksを参照する。CI用APKは正式配布物ではない。
- 本PRでversion、package ID、配布URL、正式Release workflow、認証・権限設定を変更しない。本番Edge Functionへの再デプロイや正式APK公開は行わない。
- 正式配布前には既存署名との互換性とversionCodeを確認し、許可された検証端末で上書き更新する。既存認証・運行・日報・未送信queue・profileの保持、管理者／OTP、承認、バックグラウンド位置記録、通知、APK更新を実測する。
- 外部preview連携は未確認。Google Driveへの作業記録は未反映であり、次回は既存月次文書へ非秘密の検証結果を追記する。
