# Google Keep の改善要望への対応

実施日: 2026-09-23（日本時間）。作業ブランチ: `codex/keep-startup-ic-improvements`。
検証候補: v0.1.62 / versionCode 60。公開・実機更新の状況は末尾に記録する。

## 確認した要望

Google Keep を読み取りで確認した。メモ自体の編集・削除・固定変更は行っていない。

- 「アプリ改善点」（9月20日作成、9月21日更新）: IC名が取得待ちのままになる。起動時の「登録状態を確認中」が長く、急いでいるときに記録画面へ進めない。
- 添付画像: v0.1.61 の登録確認画面と、高速道路区間の開始・終了ICが双方取得待ちになっている表示を確認。
- 「トラックログ改善」（8月25日作成、9月10日更新）: IC名の手動編集に合わせて正式名称と住所を修正したい。開始IC・終了ICを表示したい。

## 調査と実装

登録確認では複数の認証・登録通信を直列に待ち、画面に上限時間や回復操作がない経路を確認した。`driverIdentityStartup.ts` と `RequireDriverProfile.tsx` で保存された承認状態とAndroid側の認証設定・拒否状態・プロフィールのメール一致を照合し、既存の承認済み利用者の起動を通信待ちから分離した。確認不能時は8秒で再確認・登録済みログインを操作できる画面へ移る。`nativeAuthBootstrap.ts` の起動前読取は通信を伴わない保存値取得とし2秒で打ち切る。期限後やログアウト後の遅延書込みを禁止し、`main.tsx` の認証更新は描画後に実行する。明示ログアウト・利用停止・未承認のゲートを維持した。

IC取得では、取得済み認証を指定してもデータクライアント内部で再度認証更新を待つ経路を、`icResolverClient.ts` のセッションを保持しない専用通信へ変更した。認証・端末識別・関数要求は各段階35秒の上限で、全体合計35秒という意味ではない。

住所補完によるrevision変更でIC結果を保存できない不具合を再現した。`expresswayIcRetryPolicy.ts` はIC判定に関係する運行・種別・時刻・位置・IC情報を比較し、無関係な住所補完や同期だけの変更は許容する。手動訂正と位置変更は保護する。`expresswayIcResolution.ts` は保存不適用を成功として返さず、キューの古い位置よりDBの現行位置を使用する。1件の削除や例外で後続イベントの再取得を中止しない。アルゴリズム版は13。待機理由と次回再試行日時も詳細に表示する。

手動編集は `expresswayIcManualEdit.ts`、`TripDetail.tsx`、`repositories.ts` とIC関数の `name-search.ts` に追加した。入力名から検索した地図上の候補名と住所を表示し、利用者が選択して保存する。OSM由来の名称を正式名称保証とは扱わない。曖昧な名前を自動確定せず、観測時の座標は保持する。新しい現在地取得を開始しない。住所の自動補完・手動再取得の遅い応答が後発の編集を上書きしないようトランザクションで比較し、番地などの不完全な住所断片も候補住所に採用しない。検索失敗時や旧サーバー接続時は名前だけの保存が可能。

## 端末の読み取り確認

接続AndroidはSCG34、導入版はv0.1.61 / versionCode 59。既存プロセスの動作を確認。native保存状態は承認済み・設定完了・認証保存あり・拒否マーカーなし。native側のactive trip IDは空だったが、WebView側と画面との三点照合は行っていないため、これだけで運行中ではないと確定しない。

アンインストール、データ消去、ログアウト、再登録は行っていない。端末の認証値、座標、運行データは記録へ転記しない。

## 検証・成果物・残る確認

次が成功した。

- `npm run typecheck`、`npm run check:csp`、`npm run test:logic`、`npm run test:sync`（12件）。
- IC解決統合20件、既存サーバーresolver14件、名前検索6件。起動待機・失効・ログアウト・遅延書込み、IC名住所保存・観測位置保持・後着住所との競合の回帰試験を含む。
- `npm run build`、`npm run check:offline`（37 precached files）、`npm run cap:sync:android`、`npm run normalize:android-assets`、`git diff --check`。
- 最終Webビルドの `buildDate`: `2026-09-23T02:07:17.297Z`。
- 独立レビューで指摘された起動3点、手動IC編集2点を修正し、再レビューでは追加P1/P2なし。

Chrome上の隔離fixtureでは実際のReactコンポーネントを使用し、通信だけを合成応答に置き換えた。登録確認画面は幅411pxで、承認済み＋通信無応答から記録画面へ進むこと、8秒で再確認を提示して押下後に回復すること、遅いローカル応答でもクラウド拒否を保持すること、SIGNED_OUTで記録画面を直ちに閉じることを確認した。運行詳細では候補検索→選択→名前住所保存を操作し、開始IC・住所・開始終了IC表示の反映と実IndexedDB上の観測座標保持を確認した。検証画面にコンソールerror/warnはなかった。これは携帯実機や本番通信のE2Eではない。

公知のIC名による外部検索を1回、既存の最大6試行で確認したが全てタイムアウトした。実回線でのIC取得成功、実道路での開始・終了IC、圏外復帰は未確認。候補検索の新しいサーバーactionは未デプロイ。履歴再生成による日報への反映は検証したが、閉じた日報snapshot全件を即時更新する機能は追加していない。

公開latestは読み取りでv0.1.61と確認。候補は公開latestと区別して保管し、公開前の候補を会社配布用APKへ置き換えない。正式反映時はIC関数の対象変更を配備し、新版通常Releaseを公開、`npm run release:verify:apk`で版・署名・SHA一致を確認する。更新直前にnative/WebView/画面で運行中でないことを確認し、その公開APKを `adb install -r` する。以後も認証値・端末データは保持する。

## Android候補APKの検証結果

- 成果物: `output/candidate/tracklog-assist-v0.1.62-debug.apk` と `.sha256`。
- サイズ: 7,372,703 bytes。package: `com.tracklog.assist`、versionName: `0.1.62`、versionCode: `60`。
- APK SHA256: `bebf338bb2b9040d0fea08de762b898db2b3935b27cf63d85bbb8aca902cea23`。
- 署名SHA256: `14121cbf70043af3bd2fe17dd57833ed51b7f5dbf326459dde6b830f07cbb99c`。署名検証成功、既存配布APKと一致。
- Android unit test: 11 suites / 81 tests、失敗・エラー・スキップ0。アプリのandroidTest APKコンパイルとDebug APK生成成功。接続端末上のテストは未実行。
- 通常ファイルミラーのsrc205 + Android143 + package2 = 350ファイルが元ソースと一致。変更・追加されたsrc/Android18件も最終照合で一致。同期資産46件はミラーおよびAPK内部とSHA256一致。
- 携帯へのインストール、GitHub公開、ICサーバー配備は未実施。公開と接続携帯のデータ保持更新について確認を提示した。会社配布用 `output/tracklog-assist-debug.apk` は公開v0.1.61を保持。

Google Driveの既存[「TrackLog｜2026-09-04 UI改善・実機QA 作業ログ」](https://docs.google.com/document/d/1H15GTHTChYKs7g2i-a5YrHjrAIIsaTh9ewExkcjcsdc/edit)へ、「Google Keep改善要望：起動待機・IC再取得・名前住所編集の修正版準備」を16段落で末尾追記した。readbackで本文完全一致、日付3件、見出し、既存タブと前節保持を確認。既存配置 `TrackLog/10_作業ログ/2026/09` と共有状態は維持し、重複文書を作成していない。

## 承認後の正式反映

2026-09-23、利用者から「ではそれで進めて」と、v0.1.62の正式公開、IC検索サーバー反映、接続携帯のデータ保持更新への承認を得た。上記の未公開・未実施表記は承認前の時点を表す。

- [PR #9](https://github.com/Koutacode/tracklog-pwa/pull/9) のCI成功後、mainへ統合。merge commit `d4d4bb8a6fbe0bbb153eeab97939a83a9a117d43` は検証済みソースのtreeと同一。v0.1.62タグを付与し、Android Release run `35811433791` を起動。
- Supabase `tracklog-assist` の `tracklog-ic-resolver` はv3からv4へ反映、ACTIVE、`verify_jwt=true`を維持。公開ソース3件がアップロード元と完全一致。無認証・無効tokenのPOSTはともに401、承認済み端末確認はaction分岐より前に維持。他6Functionのversion/hash/JWT設定とDB/RLS/Auth設定は変更なし。
- Edge公開bundle SHA256: `c7212850cc0519d9eb46a5069402e3a9cbfc62e73e02ba0036222166f603d96b`。v3退避: `output/edge-function-backup/2026-09-23-tracklog-ic-resolver-v3/`。
- 更新前にnativeのactive trip、WebView DBのactiveTripIdとも空、画面も運行待機中・運行開始ボタンありと三点で確認。イベント1,670、ルート点244,628、日報16件。IC状態は306件中resolved301/pending5/failed0、手動修正フラグ6件（statusと重複）。精密・概略・常時位置と通知許可あり、電池最適化除外あり。Exact Alarmの実効許可は未確定。
- 端末退避 `output/device-backup/pre-v0.1.62-20260923-keep.tar` は181,837,824 bytes、SHA256 `add8ae3e3611f2b03c50307c454ac3ad9fe1f75295f3069c7a5e771cb8bb7dda`。tar読取検証成功、253 entries、ファイル権限情報保持。稼働中プロセスからの退避のため原子的snapshotとは扱わない。端末データはローカルに保持しDrive/GitHubへアップロードしない。
- v0.1.62は2026-09-23 11:46:13 JSTに通常Release公開（draft=false/prerelease=false）。公開APKは7,417,506 bytes、SHA256 `f9a0ea9b8ebe157180daa97fbf087f63ad911d3bc84c92d81bf061e20a610d62`、署名SHA256 `14121cbf70043af3bd2fe17dd57833ed51b7f5dbf326459dde6b830f07cbb99c`、embedded buildDate `2026-09-23T02:43:45.259Z`。
- `npm run release:verify:apk` が成功し、latest/versionName 0.1.62/versionCode 60/package/署名/ローカルSHA一致を確認。`output/tracklog-assist-debug.apk` とsidecarは公開版へ置換済み。公開latestのsidecarも再取得してSHA一致を確認。CI内のlatest検証と旧Release APK asset削除工程は成功。会社配布URLは https://github.com/Koutacode/tracklog-pwa/releases/latest/download/tracklog-assist-debug.apk のみ。
- Android Release run `35811433791` は最終success。APIのページング確認でも、全過去49 ReleaseのAPK assetは0件。
- インストール直前もnative/WebView/画面の三点で運行待機中を再確認し、公開APKを `adb install -r`、Success。端末版0.1.62/code60、lastUpdateTime 2026-09-23 11:47:30、firstInstallTime 2026-03-30 00:33:49を保持。端末base.apkのSHAも公開APKと一致。
- 更新後は登録確認待ちのまま止まらずホームを表示。既存イベント1,670、ルート点244,628、日報16件は更新前後で完全一致。運行IDは空。アンインストール、データ消去、ログアウト、再登録、疑似運行は実施していない。
- 精密・概略・常時位置情報・通知の権限を保持し、Exact Alarmは実効grantedを確認。2026-09-23 11:53:23〜11:54:42 JSTの約79秒の背景待機で同一PIDとforeground常駐サービスを保持。現行provider一覧のTrackLog登録0を前後に確認し、ルート点件数も不変。更新後の対象PIDログはFATAL 0・ANR 0。これは全期間の位置コールバック0や実走行の証明ではない。
- 手動再取得や候補保存を行わず、ICはresolved301→304、pending5→2、failed0、手動修正フラグ6、高速イベント306件。残るpending2件は上流サービス系エラーに分類され、両方に次回再試行時刻あり。集計は `output/candidate/pre-v0.1.62-ic-status-summary.json` と `output/candidate/post-v0.1.62-device-summary.json`。
- 通常UIから公知名「札幌南IC」を1回検索。検索中表示は解除されたが候補0で汎用エラーとなり、本番候補検索の成功は未確認。選択・保存なし。Resource TimingでICエンドポイントのHTTP502と200を確認し、401は該当範囲でなし。手動操作近傍の502は02:51:06.673〜02:51:27.958 UTC（約21.3秒）。本文を取得していないため手動検索との対応は推定で、35秒上限の発動証拠でもない。
- 公開Functionの502分岐は `OverpassUnavailableError` であり、外部地図検索失敗が強く示唆される。EdgeログはMCP/CLIに取得経路がなくDashboardも未ログインで取得できず、サーバーの個別endpointや負荷原因は確定していない。同一headersのPC診断では空controlが200/1.64秒、現行16 unionと条件同等2 unionの名前検索は各12秒でタイムアウト。単純なクエリ集約の有効性が示されなかったため、追加コード変更・配備は行っていない。
- 終了時は未保存IC編集を取り消して通常ホームへ復帰。診断用ADB forwardを解除。今回の実機診断ではrawログ・スクリーンショットの一時ファイルを作成していない。
- Google Driveの同じ月次作業ログ、同じ `t.0` タブ末尾へ「Google Keep改善：正式公開・IC関数配備・携帯更新の最終結果」を14段落で追記。readbackで本文完全一致、前回準備節全文の保持、見出し、日付2件、単一タブ維持を確認した。公開・サーバー・実機・未確認事項を区別し、重複文書は作成していない。

### 残る検証と復旧手順

本番での名前候補取得から住所保存までの成功、実走行での高速開始・終了IC、圏外復帰は未確認。地図サービス回復後に候補検索を再確認し、残る2件は保存済みの再試行予定に従う。運行開始・終了や候補保存を検証のために捏造しない。更新復旧が必要になった場合は既存データを保持し、旧APKの再配布・アンインストールではなく、修正版をより大きいversionCodeの通常Releaseとして公開・検証してから `adb install -r` する。退避tarは必要な復旧のためローカルに保持する。

## 一時ファイルの残置

今回作成した通常ファイルミラー `C:\Users\matum\AppData\Local\TrackLog\android-source-v0162-20260923-keep` 内に、初回複製で不要な `android/app/build-*` も入った。以後の同期はソース・設定・資産だけに限定した。不要複製の削除は、対象絶対パスとreparse境界を確認した `Remove-Item` でも自動承認レビューが実行前に `blocked by policy` として拒否した。詳細理由は返されていない。別手段で迂回せず残置する。今回のGradle出力は独立した `android-gradle-v0162-20260923-keep` であり、この旧出力はビルドに使用しない。

UI検証用のlocalhost:4179/4180は両方停止を確認した。今回作成した `.codex-temp/keep-ui-qa` の削除も、境界確認を含むPowerShellコマンドが同じく自動承認レビューに実行前拒否され、詳細理由は返されなかった。迂回せず合成データだけのfixtureファイルを残置する。公開成果物には含まれない。

### 明示承認後の削除結果（2026-09-23）

利用者が「blocked by policy 承認するからやって」と明示承認したため、対象の絶対パス・境界・リンク状態を確認してPowerShellで再試行した。上の残置記録は初回時点の履歴として保持する。

- 通常ファイルミラーの `android/app/` 内にある不要複製 `build-alt`、`build-authfix`、`build-codex`、`build-livefix`、`build-login-fix`、`build-release`、`build-release-v0139`、`build-release-v015`、`build-release-v016` の9フォルダーを削除。4,908ファイル、226,430,441 bytes。再確認で対象 `build-*` は0件。
- `.codex-temp/keep-ui-qa` は通常削除でビルド済み資産3ファイル（765,390 bytes）を削除した後、読み取り専用属性／アクセス権のエラーで停止。属性に対応する `Remove-Item -Force` の再試行は自動承認レビューに実行前 `blocked by policy` として拒否された。詳細理由は返されず、別手段で迂回していない。
- 最終確認でUI fixtureの14ファイル、17,154 bytesが残存。合計削除は4,911ファイル、227,195,831 bytes。完全削除とは報告しない。
- 公開APK・候補APK・端末退避tarのSHA256は削除前および上記記録と一致。ミラーのソースと今回のGradle出力は保持。端末操作は実施していない。
- 同じGoogle Drive月次ログへ今回の削除結果を追記。readbackで追加本文の完全一致と、準備・正式公開の既存節全文の保持を確認した。
