# 運行開始・終了後の端末準備画面の状態更新

2026-10-22 UTC。基準は正式版 `v0.1.80` / main
`2ae12ecfedb38c79beaa16eeca29389cff6d04f7`。

## 確認した問題

`RequireDriverProfile` は保存済みの進行中運行を起動時と
`tracklog-events-changed` 受信時に読み直し、その状態で端末準備画面を出すか
判断する。しかし `startTrip` / `endTrip` は記録と activeTripId を DB に保存した後、
この通知を出していなかった。位置や他のイベントが届かない場合、画面側の運行状態は
古いままになり得る。運行開始後に準備条件が変わると、進行中なのに端末準備画面が
前面に出る、または終了後に次の運行のための準備確認が遅れる経路になる。

fake IndexedDB の回帰テストでは、修正前の運行開始後の通知数は期待1件に対して
実際0件だった。これはアプリの状態連携の欠落であり、実際の本人端末で当該画面が
出たという証拠ではない。

## 修正

運行開始・終了の DB transaction が成功した後に限り、既存の
`notifyTrackLogEventsChanged()` を各1回呼ぶ。保存が失敗した操作からは通知しない。
DB schema、運行イベント、座標、元時刻、同期ペイロード、GPS の開始停止、手動入力、
IC判定、署名と権限設定は変更しない。

既存の復旧 APK `0.1.81/code79` は v0.1.79 の動作に戻すものなので、今回の
「直前の動作」v0.1.80 への復旧には使わない。修正版の配布候補は
`0.1.82/code80`、直前 v0.1.80 ソースの専用復旧候補は `0.1.83/code81` とし、
後者を正式署名で検証・期限外に非公開保管するまで公開しない。

## 検証と制限

新テストは運行開始・終了で各1件、拒否された二重開始・二重終了で0件を検証。
既存の `deviceSetupGatePolicy` テストは、進行中の運行を端末準備画面で隠さず、
運行終了後に準備確認する条件を検証済み。`npm run typecheck`、
`npm run test:logic`、`npm run test:sync`（36件）、
`npm run test:release-apk`、`npm run build`、`npm run check:offline`、
`npm run check:csp`、`npm run cap:sync:android`、Android unit tests
（136件、失敗0件）、Android debug APK / test APK のビルドが成功。
debug APK の manifest は `com.tracklog.assist` / `0.1.82` / code80。
初回候補の Android lint は既存 Java の `MissingPermission` 2件で失敗
（55 warnings）。後続の位置権限修正でこの2件を解消した。
今回変更した TS、テスト、版番号による新規 lint 指摘は確認されていない。

本人端末の導入版は更新済みとの本人申告のみ。実機 GPS、画面 OFF、更新・復旧の
データ保持操作はこの環境では未検証。実ユーザー記録は閲覧・変更していない。
