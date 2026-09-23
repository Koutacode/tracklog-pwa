# 管理画面の認証待ち改善

実施日: 2026-09-23。利用者から「何故かまた管理画面に入れなくなっているので解決して」と依頼。先行する一時作業フォルダー管理はPR #10でmainへ反映し、今回とは別に完了している。

## 現物と原因の切り分け

接続携帯はv0.1.62 / versionCode 60。ホームの「その他」に管理画面の入口があり、押すと「管理者権限を確認中…」を表示した後、通常の管理画面まで到達した。永続的な拒否は再現していない。初回待ち時間の厳密な計測は行っていない。既存セッションを使用し、ログアウト・再登録・運行操作・管理データの変更は実施していない。

PCの正式管理URL `https://tracklog-assist.pages.dev/admin` は `/login` に遷移し、表示版はv0.1.54だった。Googleログインのボタンを1回操作した後、ブラウザー操作ツールの画面取得がタイムアウトしたため、その先のログイン成功・失敗は未確定。ツール障害をサイトの認証失敗と扱わない。

コードと実SDKを使う合成通信で、明示的に新しいAuthorizationを渡していても通常Auth clientのfunctions通信が先に別の保存セッションを読み、期限切れなら更新を待つことを再現した。Androidで取得・検証済みのトークンを送る管理者確認でも、この余分な更新待ちが割り込む。これが利用者のその瞬間の発生原因だったとまでは確定していない。

## 修正

`src/services/tracklogExplicitTokenClient.ts` にセッションを保存・更新しない通信クライアントを追加し、`tracklogPrivilegedApi.ts` の明示トークンを持つ要求だけを切り替えた。トークンを明示しない通常Web通信は従来クライアントを使用する。

呼出し元のトークン選択、Authによる利用者検証、サーバーの有効な `admin_users` 照合、メール一致確認、管理画面の表示ガードは維持する。認証情報・管理者権限・DB設定は変更しない。

さらに、実際の起動用セッション生成・二重保存アダプター・SDKを組み合わせた合成検証で、初期化時の `INITIAL_SESSION` でも期限切れ情報の更新が始まり、アプリの更新ロックとは独立して認証を書き換える経路を確認した。`nativeOwnedAuthStorage.ts` をAndroidのSDK読み取り口にだけ適用し、期限切れ／SDKの更新余裕90秒以内のセッションをSDKへ渡さない。元の保存情報・復旧用読み取り・PKCE・明示ログアウトは保持し、更新はnative処理へ任せる。SDKへの復元直前も有効期限を確認し、利用者照合は取得済みトークンを明示する。通常Webの保存処理は変更しない。

`tracklogPrivilegedApi.test.ts` は実SDKと模擬通信で、期限切れ保存セッションへのアクセス・余分なAuth通信がなくなること、Authorization/API key/body保持、並行トークン分離、通常Web互換、401/403/503やアプリ拒否・通信例外の伝播を確認する。独立レビューで重大・中程度の追加指摘はなかった。

## 検証と反映

新規回帰試験、既存の認証所有11件、管理入口contract11件、登録19件、型検査が成功。全体検証・公開・実機更新の結果は以下へ追記する。実利用のトークン・個人情報・座標は記録しない。

更新前の端末退避は `output/device-backup/pre-v0.1.63-20260923-admin.tar`（183,561,216 bytes、SHA256 `04a4fc100c26abf9204a3215b71ac6805b6db44829226aa45b04cc466a161481`）。254 entriesのtar読取に成功。稼働中の退避で原子的snapshotではない。nativeとWebViewの運行IDは空、管理画面を表示中、既存件数はイベント1,670・ルート点244,628・日報16。権限と初回インストール日時を保持。診断用に新しい管理一時領域を使用し、終了時のID指定削除に成功した。

全体確認: `npm run typecheck`、`npm run test:logic`（新規2試験を含む）、`npm run test:sync`（12件）、`npm run check:csp`、`npm run build`、`npm run check:offline`、`npm run cap:sync:android`、`npm run normalize:android-assets`、`git diff --check` が成功。SDK起動・90秒境界・native復元・明示利用者照合・PKCE保存・明示ログアウトの回帰試験も成功。独立レビューで重大・中程度の未解決指摘なし。Android版v0.1.63 / versionCode 61として生成し、通常Releaseの公開後に正式APKを検証して携帯へ上書きする。

### 候補APKとGitHub反映

PR #11 `https://github.com/Koutacode/tracklog-pwa/pull/11` をCI run `35814499749`（Linux validate / Windows temporary-workspaces両方成功）で検証し、main `af9a145b589188e4d417c422d8baf7f30982a89b` へ統合。検証済みheadとmerge後のソースツリー一致を確認して `v0.1.63` をタグ付けした。

通常ファイルの新規管理領域でGradleの単体テスト・instrumentation APK生成・debug APK生成が成功。11 suites / 81 tests、失敗・エラー・skip 0。instrumentationはコンパイルのみで端末実行はしていない。ソース・設定・必要依存464ファイルとAPK内同期資産46ファイルの一致を確認した。

候補: `output/candidate/tracklog-assist-v0.1.63-debug.apk`（7,373,315 bytes、SHA256 `282e881b06022741d3a291562c935a4dcb92b09c8d17d4bd8c02056fe7703b10`）、署名SHA256 `14121cbf70043af3bd2fe17dd57833ed51b7f5dbf326459dde6b830f07cbb99c`。根拠を `output/candidate/tracklog-assist-v0.1.63-build-evidence.json` へ保存した。候補は正式APKへ上書きせず、公開確認を待った。

新しい一時領域で実施した端末事前診断、PR作成、AndroidビルドはいずれもID指定の片付け成功。Androidの深いパスはWindows PowerShell 5.1のコピー制限に達したため、PowerShell 7で同じ管理領域のコピー済みファイルをSHA照合して継続し、既定管理スクリプトで片付けた。以前削除を拒否されたフォルダーを操作したり移したりしていない。

### 正式公開APK

Android Release run `35814687900` の31ステップが全成功し、2026-09-23 12:36:25 JSTに通常版v0.1.63を公開。latestのtag・draft=false・prerelease=false、公開SHA sidecar、GitHub asset digestを確認。過去50 ReleaseのAPK assetは0件になっている。

`npm run release:verify:apk` 成功。正式 `output/tracklog-assist-debug.apk` を公開APKで置換し、package `com.tracklog.assist`、versionName `0.1.63`、versionCode `61`、従来署名一致、embedded buildDate `2026-09-23T03:33:02.764Z` を確認した。7,418,182 bytes、SHA256 `a4dffcabc142f9123453925351b464d1b77c09513c9980041ddc557be2be3134`。公開側のdigest・latest sidecarとローカルAPKの一致も別途確認した。

会社配布URLは従来どおり `https://github.com/Koutacode/tracklog-pwa/releases/latest/download/tracklog-assist-debug.apk`。ローカル候補と公開版はbuild環境・日時が異なるため別のSHAとして記録し、実機には検証済みの公開版だけを使用する。

### 携帯の上書き更新

更新直前にnative、WebView DB、通常ホーム表示の3点で非運行を確認し、検証済み公開APKを `adb install -r` で更新した。v0.1.63 / code61、端末上のAPK SHAと公開APKの一致、初回インストール日時 `2026-03-30 00:33:49` の維持、通常ホーム起動を確認。アンインストール・データ消去・ログアウト・再登録・テスト運行は行っていない。

管理画面は通常ホームの「その他」から開き、端末一覧の表示まで初回2,577ms、画面の「戻る」でホームへ戻って再入場した際は1,608msだった。両回 `/admin` の通常内容を確認し、確認中／再確認中／読み込み／ログイン画面に止まる状態はなかった。測定前の画面外クリック1回は遷移が発生しておらず、待機時間の測定には含めていない。

更新後もイベント1,670・ルート点244,628・日報16を完全保持。native承認／設定完了／ready／runningがtrue、認証設定あり・blocked=false・送信待ち0。精密・概略・常時位置情報と通知は許可、Exact Alarm許可、電池最適化除外を維持。nativeとWebViewの運行IDは空で、通常ホームの開始操作が表示され終了操作・登録待ちは非表示。12:38:51以降の対象ログでFATAL0・ANR0、PID維持、確認時のlocation provider登録はTrackLog分0だった。これは停止時の確認であり、実走行や長時間経過後の再認証の実機試験ではない。

端末のAPK SHAとembedded buildDateも公開APKに一致。最後に通常ホームへ戻し、ADB診断用forwardを解除、使用した新規管理一時領域の削除成功を確認した。生ログ・スクリーンショットは保存していない。

### 残る確認と次回

利用者が遭遇した瞬間の原因を断定していない。二重更新の2経路は実SDKの合成試験で再現し修正済み、実機の更新後管理画面2回到達を確認した。PCブラウザー版は既存v0.1.54の/login到達まで観測し、その後のブラウザー操作ツールによる読取は再試行でも失敗したためGoogle OAuth完了は未確認。PC Webの公開変更は行っていない。実走行のルート・高速判定、新しいサインイン、長時間後の期限切れ回復は今回の実機完了範囲に含めない。

再発時は発生画面と時間を確認し、nativeの承認・認証設定・activeTripIdとWebViewの表示状態を秘密値を出さずに突き合わせる。ログアウトやデータ消去で復旧しない。バックアップを保持し、修正が必要ならversionCodeを上げた新Releaseで上書きする。
