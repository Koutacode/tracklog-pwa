# IC名が初回に取得できず、後から表示される問題の調査

実施日: 2026-09-18（日本時間）。検証候補: v0.1.59 / versionCode 57。正式公開版: v0.1.60 / versionCode 58。

## 症状と確認できた範囲

利用者が確認した症状は「最初は取得できず、後から表示される」。接続端末の保存済み高速道路イベント298件はすべてIC名あり・resolved、手動修正は5件だった。直近30日の50件も取得済みだった。取得成功時には過去のエラーと試行回数が消去されるため、これを初回成功率の証拠にはできない。

端末の位置情報・背景位置・通知権限、電池最適化除外、常駐サービスは有効。ネイティブ状態、WebViewのIndexedDB、ホーム表示の3点で進行中の運行なしを確認した。端末データはローカルの `output/device-backup/ic-diagnosis-20260918.tar` に保全した。バックアップには非公開情報を含むため、外部へ送信しない。

調査中は認証更新のSocketTimeoutExceptionが発生し、前面での自然再試行でも回復しなかった。認証有効期限とアップロード最終成功から約8時間経過していた。失敗カウンター5は上限値であり、失敗総数ではない。HTTP 401という明示的証拠は得られていない。

## 再現・確認した原因

1. ネイティブ認証復元の通信例外を認証拒否と同じ分類にし、IC解決を初回から15分後へ延期していた。一時的タイムアウトでも表示が遅くなる経路であり、観測症状と整合する。ただし過去の各イベントへの因果は未確定。
2. IC再試行は60秒周期で、アプリ復帰時の再開契機がなかった。通常の通信失敗も初回2分待ちだった。
3. 地図APIはHTTP 200でもremarkに実行エラーを返す場合がある。従来は空・部分結果を「候補なし」の成功として処理・キャッシュしていた。
4. 地図APIのタイムアウトはヘッダー受信までで解除され、本文が止まると代替サーバーへ進まなかった。クライアントのHTTPエラー本文にも同種の無期限待機があった。
5. サーバーは順位最上位1件のみ返し、クライアントは距離で棄却する。合成データの1400mのIC候補が1150mの料金所候補を隠し、利用可能な候補があっても失敗することを再現した。
6. 有効なイベント位置があると、候補なしでも同じ位置だけを再照会していた。またネイティブ道路照会の15秒待機は、サーバーの最大約27秒の代替先探索より短かった。

本番のIC関数は調査時点でACTIVE/version 2。取得したindex.ts/resolver.tsは、修正前ローカルソースと改行正規化後のSHA256が一致した。地図APIと認証サービスへのPC経由試験でも応答遅延を観測したが、端末やSupabase実行環境と同一の経路ではないため、サービス全体の障害とは断定しない。

## 修正

- `src/services/icResolver.ts`: ネイティブ復元失敗だけを一時障害に分類。401/403やセッションなしは従来の認証待機を維持。関数通信35秒、エラー本文2秒の上限を設定。
- `src/services/expresswayIcRetryPolicy.ts` / `src/app/IcResolverJob.tsx`: 一時障害の初回待ちとジョブ周期を15秒へ変更。指数バックオフを維持し、起動・復帰時に未取得処理を再開。復帰イベントの連発は15秒間まとめる。
- `supabase/functions/tracklog-ic-resolver/resolver.ts`: エラーremarkを失敗扱いにして代替先へ移行。本文を含むタイムアウトを実施。距離条件を満たす候補を先に絞り、その中で順位付けする。
- `src/services/expresswayIcResolution.ts`: 初回が正常な候補なしの場合だけ、同一運行の直前90秒〜直後30秒から最大3つの独立GPS点を照会。精度100m以内、点間200m以上、距離上限2km、候補名の一致を要求。通信失敗や候補の矛盾は確定しない。自動終了は確認時刻ではなく検知時刻を使う。
- `src/db/repositories.ts`: 取得に使った位置種別と時刻差だけを記録し、手動修正時には解除。既存の手動編集保護を維持。
- `ResidentLocationUploader.java`: IC道路照会に限りread timeoutを35秒へ変更。通常の位置送信と認証更新の設定は維持。
- アルゴリズム版12に更新し、旧方式で試行上限に達した未取得イベントを再評価。既に確定したIC名は一括書換えしない。

## 検証と残る確認

`npm run typecheck`、`npm run test:logic`、`npm run test:sync`（12件）、`npm run check:csp`、`npm run build`、`npm run check:offline`、`npm run cap:sync:android`、`git diff --check`が成功。新しいIC解決統合テスト15件、サーバーの14件、認証復元失敗分類とHTTPエラー本文停滞の回帰試験を含む。独立レビューでも重大回帰は検出されなかった。

Android通常ファイルミラーで単体テスト65件（8スイート、失敗・スキップ0）とassembleDebugが成功。変更ソース14ファイルと同期資産46ファイルは元の作業内容とSHA256が一致した。

- 候補APK: `output/candidate/tracklog-assist-v0.1.59-debug.apk`（7,366,711 bytes）
- package: `com.tracklog.assist` / versionName `0.1.59` / versionCode `57`
- APK SHA256: `ef2d205d42fb9e2392ed916581ad730f8a36f749b9095ac04319832095775752`
- 署名SHA256: `14121cbf70043af3bd2fe17dd57833ed51b7f5dbf326459dde6b830f07cbb99c`（現公開APKと一致）
- 実装commit: `e128738` / branch: `codex/fix-ic-resolution`

候補APK完成時点では本番反映・公開・実機更新の明示承認を確認中だった。この時点の公開latestと端末はv0.1.58、本番IC関数はversion 2。承認後の反映結果は末尾へ追記する。本番反映はIC関数だけを対象とし、DB/RLS/Auth設定や他の関数は変更しない。APK公開・固定latest URL検証を行い、その公開APKを `adb install -r` で導入する。更新直前にも運行中でないことを再確認する。

追加切り分けでは、端末の現在のデフォルト回線はCELLULAR・VPNなし。画面側から認証health endpointへ1回だけ照会しても10.9秒で応答ヘッダー未受信のままタイムアウトした。ネイティブだけの問題ではない。管理APIのプロジェクト状態はACTIVE_HEALTHYだったが、これは実通信の成功を保証しない。[公式ステータス](https://status.supabase.com/)ではAuthはOperational、API GatewayはJWT拒否事象によりDegraded Performanceと表示されていた。今回のタイムアウトとの直接の因果は未確定であり、共用プロジェクトの再起動や設定変更は行っていない。

実道路での初回表示までの時間、開始・終了ICと日報への反映、圏外からの回復は未確認。通信自体が応答しない間の即時取得は保証できない。公開後の端末確認では、既存データ保持、起動、認証回復、常駐サービスを区別して記録する。

## 承認後の本番反映と公開工程の修正

利用者から本番反映・公開・携帯への更新の明示承認を得た。IC関数だけをversion 3へ反映し、ACTIVE・JWT検証有効・配備ソース一致を確認。認証なしの照会は401となることを確認した。認証通信のタイムアウトが継続しているため、認証付き実IC照会の成功は未確認。

実装PR #6をマージした後、v0.1.59のAndroid Release run 35356136351がSDK準備で失敗した。`setup-android@v3` の既定指定にある廃止済み `tools` が取得できないことが原因で、APK作成・Release公開には到達していない。[setup-android公式説明](https://github.com/android-actions/setup-android#the-deprecated-tools-package)に従いv4と `packages: platform-tools` へ変更する。既存タグを変更せず、versionCodeも58へ増やしたv0.1.60として公開し、公開APK検証後に実機更新する。

## 正式公開の確認結果

- PR #7のCI run 35356704574は全項目成功。mainへマージしたcommit `edbb2ad6806d495a6f3927d217106ed39efc48dd` にv0.1.60タグを付けた。
- [Android Release run 35356870174](https://github.com/Koutacode/tracklog-pwa/actions/runs/35356870174)はSDK準備、Androidテスト・ビルド、署名・版確認、draft APK検証、通常公開、latest照合、旧APK削除を含め全工程成功。
- `npm run release:verify:apk` が成功し、`output/tracklog-assist-debug.apk` を公開APKで置換。package `com.tracklog.assist`、versionName `0.1.60`、versionCode `58`、サイズ7,395,162 bytes。
- 公開APK SHA256: `f7e23a20a84173fac918c816a532507a9808df61ef8b6794f6e255b64b5fd957`。既存と同じ署名SHA256: `14121cbf70043af3bd2fe17dd57833ed51b7f5dbf326459dde6b830f07cbb99c`。
- 固定latestのSHA sidecarも別途取得して一致を確認。過去の全ReleaseからAPK配布assetが除かれ、v0.1.60だけにAPKが存在することを再確認した。
- 会社配布URL: https://github.com/Koutacode/tracklog-pwa/releases/latest/download/tracklog-assist-debug.apk

公開中に追加した認証healthの1回の検査でも10秒タイムアウトが継続。公式API GatewayのJWT拒否障害は掲載されているが、今回のタイムアウトとの因果は未確定。共用プロジェクトの再起動・アップグレード・Auth/DB設定変更は実施していない。

一時ビルドミラー `C:\Users\matum\AppData\Local\TrackLog\android-source-v0159-20260918` の削除は、自動承認レビューが `blocked by policy` として実行前に拒否した。具体的な理由は返されていないため、回避せず残置した。配布成果物には含まれない。

公開後の `output/ic-resolution-pr-body.md`、`output/ic-sdk-pr-body.md`、`output/ic-resolution-release-notes.md` の削除も同じ自動承認レビュー理由で実行前に拒否された。別手段で回避せず、実機検証用の一時ファイル削除も停止した。端末バックアップはもともと保持対象であり、この削除とは別扱い。

## 携帯への反映と最終確認

更新直前に運行中でないことを確認し、公開APKを `adb install -r` で上書きした。アンインストール・データ消去・ログアウト・再登録はしていない。実機APKのSHA256は上記公開版と完全一致し、versionName `0.1.60` / versionCode `58`、初回インストール日時も保持された。

更新前後で運行イベント1,624件、位置記録230,379点、日報16件、高速道路イベント298件（全件resolved）が一致。位置・背景位置・通知権限、位置情報ON、電池最適化除外、foreground `ResidentLocationService` を維持した。WebViewの411×903 viewportで通常ホーム、履歴、運行開始の表示とerror boundaryなしを確認。現行プロセスのFATAL/ANRは0件で、更新時の終了記録は `PACKAGE UPDATED` のみだった。

約35秒のバックグラウンド遷移でも同一プロセスと常駐サービスが維持され、通常のTrackLogホームへ復帰した。端末の認証は自然再試行後も期限切れ・以前のアップロード成功時刻・失敗カウンター上限5の状態が続き、認証通信の回復は未確認。アプリ側の待機・再試行・候補選択の改善と、外部認証通信の未解消は区別する。実道路での初回表示速度、開始・終了ICと日報、圏外からの復帰は引き続き未検証。

今後の復旧では、認証通信とAuth/API Gatewayログを確認し、通信回復後のIC取得を観察する。既存アカウント・端末データを保持し、再インストールによる初期化や認証設定の無断変更は行わない。旧APK配布によるロールバックは行わず、必要な追加修正はversionCodeを増やした新しい通常Releaseとして検証・配布する。
