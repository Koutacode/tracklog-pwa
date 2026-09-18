# 運行中だけ位置情報を取得する変更

調査開始: 2026-09-18、実装・検証: 2026-09-19（日本時間）。対象版: v0.1.61 / versionCode 59。

## 利用者の指示と方針

「位置情報の取得が多い理由と必要性を調査し、不要なら改善する」に続き、「運行開始後に位置情報を取得し、運行終了後は取得しない」と明示された。運行外の現在地共有より今回の明示指示を優先する。履歴・日報・既存位置記録を削除せず、管理者のメッセージ受信・通知は維持する。

## 実機の変更前測定

v0.1.60、native状態・IndexedDB・ホーム表示とも非運行のまま76秒測定した。TrackLogのGPS/NETWORK要求は各10秒・最小移動距離0m。GPS配信8回、NETWORK配信6回、品質採用8回、ルート保存0回、現在地送信試行2回・成功0回だった。成功0回は認証通信障害の影響があり、送信停止の証拠にはできない。

既存230,379点は2026年3〜9月・26運行ID・位置記録のある147日分の累積。記録のある1分間の中央値8点、95パーセンタイル13点、最大61点。2秒以下の隣接間隔30,780組、2〜5秒38,218組を確認したが、過去版を含むため現在版の取得率とは区別する。集計は端末内で実施し、生座標を外部へ出していない。

## 取得が多かった理由と変更

- 承認・設定完了だけで非運行にもGPS/NETWORKを各10秒要求していた。運行の記録intentがない間は購読を解除し、新しい位置取得・現在地送信をしない。既存の休息・フェリー中の記録停止にも追随する。
- 15秒ごとの定期状態確認で同じ購読を毎回解除・再登録していた。同一条件なら登録を維持し、実際の運行・provider・位置ON/OFF変更だけを反映する。
- Androidの通常共有はnative送信に加え、画面側にも30秒ごとの高精度単発取得があった。画面側の定期取得を除去し、Home表示や権限確認・要求でのGPS起動も撤去した。
- 管理者の現在地要求も運行外では取得しない。取得中に終了した場合は単発watchを取り消し、遅延結果・保留送信・別運行への流用を拒否する。
- 運行開始はDB保存とnative開始を先に行い、その後取得した位置を未編集の開始イベントへ補完する。終了は新しいGPSや逆ジオを待たず、同じ運行の120秒以内の実測位置を使用する。確認時刻で古い位置を複製したevent-anchorは使用しない。
- 認証refreshの通信がCapacitorの処理スレッドやlockを占有し、終了停止を遅らせる経路を解消した。追跡intent反映を短い処理に分離し、古い同期・ログアウトとの競合を防ぐ。
- nativeに反映されていなかったAndroidの高精度/省電力ボタンは、運行中だけ取得する挙動の説明に置き換えた。

運行中の10秒周期は維持する。高速開始判定は連続する道路確認の間隔が25秒を超えると候補を初期化するため、一律30秒化は現在の判定と矛盾する。位置記録はルート保持・高速判定・IC補完に使用し、既存の履歴量だけを理由に走行中の精度を落とさない。[Android公式の電池最適化方針](https://developer.android.com/develop/sensors-and-location/location/battery/optimize)も、用途に応じた頻度削減と不要な位置要求の停止を推奨している。消費電力の削減率は未測定。

## 検証と成果物

開始前・終了後の取得拒否、終了時の未完了watch解除、開始点補完と既存手動値保護、終了位置の他運行・古い時刻・未来・低精度・event-anchor除外を合成データで検証し成功した。nativeでは運行状態・provider変更・登録中終了・遅延callback・送信再試行・認証lock待ちの回帰テストが成功した。

- `npm run test:logic`、`npm run typecheck`、同期テスト12件、CSP、Web build、offline assets、Capacitor同期が成功。
- Androidの `testDebugUnitTest`、`assembleDebug`、`assembleDebugAndroidTest` が成功。単体テスト11 suites / 81 tests、失敗・エラー・スキップ0。追加の端末向けテスト2件はコンパイルのみ確認し、利用者の端末では実行していない。
- OneDrive外の通常ファイルmirrorとソース・assets145ファイルのSHA一致、APK内46 assetsの一致、public44/44件を確認した。
- ローカルcandidate: `output/candidate/tracklog-assist-v0.1.61-debug.apk`、7,368,819 bytes、SHA-256 `f5e71a4af5d379c03c5dc6035d04bd1dc8c65129abdc7a60ab133b59816d9eb8`。公開APKとは区別し、実機には公開検証後のAPKを使用する。
- [PR #8](https://github.com/Koutacode/tracklog-pwa/pull/8) は検証済みhead `91c0dc4` をmain `803b7e9` へmerge済み。[PR CI](https://github.com/Koutacode/tracklog-pwa/actions/runs/35360497409)、[main CI](https://github.com/Koutacode/tracklog-pwa/actions/runs/35360630216) は成功。
- 独立コードレビューで認証削除待ち中の再開競合を検出・修正し、再レビューで追加blockingなし。競合タイミングを作る実機試験とは区別する。

## 通常公開・配布APKの検証

[Android Release](https://github.com/Koutacode/tracklog-pwa/actions/runs/35360645339) は全工程成功。v0.1.61を通常公開（draft=false、prerelease=false）した。署名・version・draft download・latest・旧版APK削除を検証し、旧版APKは連続2回の確認および独立API確認で0件。

ローカルでも `npm run release:verify:apk` が成功し、公開APKで `output/tracklog-assist-debug.apk` を置換した。固定latestの公開checksum sidecarとも完全一致を確認した。

- 配布URL: https://github.com/Koutacode/tracklog-pwa/releases/latest/download/tracklog-assist-debug.apk
- package `com.tracklog.assist`、version `0.1.61`、versionCode `59`
- 公開APK SHA-256: `acc53c7daa82acea93a0d4933017ae3cc1f3a2f16136a97e96b3a93d947b61f6`
- 署名SHA-256: `14121cbf70043af3bd2fe17dd57833ed51b7f5dbf326459dde6b830f07cbb99c`（従来配布APKと一致）
- build date: `2026-09-18T15:10:09.204Z`、サイズ7,413,690 bytes
- Supabase関数の追加デプロイはなし。前版のIC初回解決改善を含む。

## 実機更新

更新直前にnative・WebView IndexedDB・ホームの3面で非運行を再確認し、公開検証済みAPKを `adb install -r` でSCG34へ導入した。インストール後のAPK SHAは公開版と一致し、version0.1.61/code59、firstInstallTime `2026-03-30 00:33:49` は維持された。

運行イベント1,624件、ルート点230,379件、日報16件、IC298件すべて名前あり・解決済みを保持。アンインストール・データ消去・ログアウト・疑似運行作成は行っていない。ホーム表示正常、更新後FATAL/ANR 0。ResidentLocationServiceはforeground待機し、端末の実通知41139は「運行待機中・位置取得停止」と表示された。

更新後、ホーム前面で76.3秒の読み取り専用測定を行い、全期間非運行を確認した。位置取得APIやテスト運行の作成は使用していない。

| 指標 | 変更前・76秒 | 変更後・76.3秒 |
| --- | ---: | ---: |
| TrackLogの現在の位置要求 | GPS/NETWORK 2本 | 0本（測定前後とも空） |
| GPS配信増分 | 8 | 0 |
| NETWORK配信増分 | 6 | 0 |
| 採用位置増分 | 8 | 0 |
| ルート保存増分 | 0 | 0 |
| 現在地送信試行増分 | 2 | 0 |

更新後のfused配信・送信成功の増分も0。停止の根拠は成功件数だけではなく、現在の位置要求が存在せず、位置配信・採用・送信試行も0であること。OS位置履歴やlast-known値を現在の要求と取り違えない専用パーサーで確認した。

背景へ移した後も位置登録0本を確認し、最後は通常のTrackLogホームへ戻した。位置・背景位置・通知権限、OS位置ON、電池最適化除外を維持。2プロセスのログでFATAL/ANRなし。ADB forwardは解除済み。実際の開始・終了操作を含む実走行や消費電力の削減率は未測定であり、開始・停止制御の合成データ回帰テストと待機中の実機測定を区別する。

恒久記録は既存の[2026年9月Google Drive作業ログ](https://docs.google.com/document/d/1H15GTHTChYKs7g2i-a5YrHjrAIIsaTh9ewExkcjcsdc/edit)へ追記する。既存のNotion・Obsidian履歴は変更しない。

## 後片付けの制約

利用者から再実行指示を得た後、以前の一時テキスト3件だけを絶対パスで指定して削除を再試行したが、自動承認審査が実行前に `blocked by policy` として拒否した。詳細理由は示されていない。別ツールや実ブラウザへ迂回せず保留した。前回の一時ビルドミラー、検証用一時ファイルも残存。正式APK・端末DB・復旧用バックアップは保持対象。

認証通信のタイムアウトと実道路でのIC取得速度は、位置取得の開始・停止制御とは別の未確認事項として保持する。更新時は運行中でないことを再確認し、公開latest検証済みAPKだけを `adb install -r` で導入する。
