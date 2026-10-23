# 常駐位置記録の権限失効対策

正式版 v0.1.80 からの修正候補 v0.1.82/code80 に、本人の追加依頼に基づき
Android lint の `MissingPermission` 2件を解消する変更を追加した。

`ResidentLocationService` の GPS・network `requestLocationUpdates()` は、
上位の端末準備判定で精密位置権限を確認し、`SecurityException` を捕捉していたが、
各 provider の登録直前には権限を再確認していなかった。GPS を登録した後、
network の登録前に権限が失効する経路もある。現在の仕様どおり精密位置権限が
なければ新しい位置登録を開始せず、再判定を予約する。登録が一部済んでいれば
既存 `ResidentLocationSamplingPolicy.reconcile()` が listener を解除する。
確認と実際の Android API 呼び出しの間で権限が失効して例外が出る場合も、
既存の解除処理と `reconcileLocationReadiness()` の例外処理でサービスを停止する。

Android の位置権限を追加・緩和せず、GPS の記録間隔・距離・座標・運行時刻・
既存データ・同期・IC 判定・手動入力・署名は変更しない。

Robolectric は権限の拒否→許可→失効で `Readiness` と記録モードが切り替わる
ことを検証。既存 `ResidentLocationSamplingPolicyTest` は provider 登録途中の
`SecurityException` で部分登録が解除され、その後の再試行が可能なことを検証。
Android lint は修正前の errors 2 / warnings 55 から、修正後 errors 0 /
warnings 55 となった。最終状態で型検査、ロジック、同期36件、Release契約23件、
CSP、Web build、offline、Capacitor sync、Android単体試験137件（失敗0）、
Android本体・試験APKビルドと lint が成功。debug APK manifest は
`com.tracklog.assist` / `0.1.82` / code80。実機での権限変更・
バックグラウンド記録は未検証。
