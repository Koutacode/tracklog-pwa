# TrackLog Changelog

## 2026-03-30

### stable device / 初回プロフィール / 常時同期

- クラウド同期の端末識別を `Supabase anonymous user.id` 依存から外し、Android では `ANDROID_ID` ベースの stable device id を使うよう変更
- Supabase 側の stable device migration を適用し、`device_profiles` / `trip_headers` / `trip_events` / `trip_route_points` / `report_snapshots` の `device_id` を text 化
- `claim_tracklog_device_profile` / `migrate_tracklog_device_records` を追加し、同じ端末なら再インストール後も同じ `device_id` を再利用できるよう変更
- 初回起動時は `/setup` で `表示名` と `車番・識別名` の入力を必須化
- `表示名` だけではなく `車番・識別名` も未設定なら通常画面へ入れないよう変更
- `設定 > クラウド同期` の ON/OFF を廃止し、同期は常時有効に固定
- Dexie hook で `events` / `routePoints` / `reportTrips` の変更を拾い、記録や更新のたびにデバウンス付きで即時同期するよう変更
- Android 実機 `SCG34` (`RFCY70L6HTF`) で `アンインストール -> 再インストール` を2回実施し、2回目の再インストール後はプロフィール再入力なしでホームへ復帰することを確認
- Supabase 上の端末一覧は最終的に `android:040861b7b0aaa9e0 / SCG34 メイン端末 / SCG34` の1件へ整理
- Cloudflare Pages を再デプロイし、`https://tracklog-assist.pages.dev/` の本番バンドルを更新

### 検証

- `npm run typecheck`
- `npm run build`
- `npx cap sync android`
- `android\\gradlew.bat -PtracklogAppBuildDir=build-stable-device assembleDebug --no-daemon`
- `adb uninstall com.tracklog.assist`
- `adb install -r android\\app\\build-stable-device\\outputs\\apk\\debug\\app-debug.apk`
- `adb shell am start -W -n com.tracklog.assist/.MainActivity`
- Android WebView DevTools で初回 `/setup?next=%2F` 表示を確認後、プロフィール保存で `/` へ遷移することを確認
- 再インストール後は `/setup` に戻らず `https://localhost/` を開くことを確認
- `Invoke-WebRequest https://tracklog-assist.pages.dev/` で本番 URL が最新バンドル `index-BN4B4Z-c.js` を返すことを確認

### APK

- File: `output/tracklog-assist-debug-stable-device.apk`
- SHA-256: `A6CC81E551CC129859A556A8B090999211C576A20B52DB62A802B3C943AA4C20`
- Device install: completed on `SCG34` (`RFCY70L6HTF`)
- Launch check: `am start -W -n com.tracklog.assist/.MainActivity` returned `Status: ok` (`TotalTime: 281ms`)

## 2026-03-29

### クラウド同期・管理者画面・PWA 初回公開

- Supabase を導入し、一般ドライバー向け `anonymous sign-in` と管理者向け `magic link` ログインを追加
- `device_profiles`、`trip_headers`、`trip_events`、`trip_route_points`、`report_snapshots`、`admin_users` を含む初期 schema と RLS を追加
- アプリ側に `設定 / 同期` 導線、端末ID保持、同期状態表示、手動同期、リモート同期ブートストラップを追加
- 管理者向けに `/login`、`/admin`、`/admin/devices/:deviceId`、`/admin/trips/:tripId` を追加し、端末一覧・運行詳細・日報スナップショットを閲覧できるようにした
- PWA 用 `manifest.webmanifest`、`sw.js`、`_redirects`、Apple touch icon メタデータを追加し、Cloudflare Pages へ初回公開
- 本番 URL は `https://tracklog-assist.pages.dev/`
- 管理画面 URL は `https://tracklog-assist.pages.dev/admin`
- 管理者ログイン URL は `https://tracklog-assist.pages.dev/login`
- Supabase Auth の `site_url` / `uri_allow_list` を本番 URL に更新し、公開環境でのメールリンク遷移に対応

### 検証

- `npm run typecheck`
- `npm run build`
- `npx wrangler whoami`
- `npx wrangler pages project create tracklog-assist --production-branch main`
- `npx wrangler pages deploy dist --project-name tracklog-assist --branch=main --commit-dirty=true`
- `Invoke-WebRequest https://tracklog-assist.pages.dev/`
- 実ブラウザ確認で `/` `/login` `/admin` を開き、未ログイン時 `/admin -> /login` 遷移を確認
- `adb install -r output\\tracklog-assist-debug.apk`
- `adb shell am start -W -n com.tracklog.assist/.MainActivity`
- 起動直後の `logcat` に `FATAL EXCEPTION` / `ANR` なし

### APK

- File: `output/tracklog-assist-debug.apk`
- SHA-256: `5A96F7E4E8A207AAFEF4E49CBF885EFF899902BB78CAF7259EDE67A2555610C6`
- Device install: completed on `SCG34` (`RFCY70L6HTF`) with `adb install -r`
- Launch check: `am start -W -n com.tracklog.assist/.MainActivity` returned `Status: ok` (`TotalTime: 326ms`)

## 2026-03-21

### ルート直線化の修正と構成整理

- ルート地図でイベント由来の補助地点を実 GPS ルート線へ混在させないよう修正し、一直線表示になりやすかった経路を改善。
- 補助ルート側は OSRM の道路経路補完を優先し、補正前に近接重複点を間引くようにして、通過道路に沿った見え方へ寄せた。
- `RouteMapScreen` で `GPS 実記録` と `イベント補助地点` を分離し、補完件数が分かる状態表示を追加。
- 構成見直しとして、未使用だった `src/ui/components/ConfirmDialog.tsx` を削除。
- `.gitignore` に `android/app/build-alt/`、`.codex-temp/`、`temp-debug/`、`temp_report_repro.mjs`、各種 `output` 一時生成物を追加し、作業ゴミが残りにくいよう整理。
- `src/app/App.tsx` を route-level lazy load 化し、初回バンドルを単一大容量 chunk から分割。`index` は約 `396kB`、主要画面は個別 chunk 化。
- 一連の整理と機能差分は `44302a1 Refine TrackLog route, report, and Obsidian workflows` としてコミット済み。

### 検証

- `npm run typecheck`
- `npm run build`
- `npx cap sync android`
- `gradlew -PtracklogAppBuildDir=build-alt assembleDebug --no-daemon`
- `adb install -r`
- 実機 `RFCY70L6HTF` で起動確認。`am start -W -n com.tracklog.assist/.MainActivity` は `Status: ok`。
- 直後の `logcat` に `FATAL EXCEPTION` / `ANR` なし。
- ルート画面で `補正完了`、`OSRM経路補完 7 区間 / 生データ 2854 区間` を確認。

### APK

- 出力: `output/tracklog-assist-debug.apk`
- SHA-256: `F46DB299EF11E4987AE15EF53954EDDE96867D62CA77C9905F182EA750B6BAFD`

## 2026-03-20

### ルート線表示・高速表示・Obsidian 復元 JSON

- 位置情報付きイベントを保存するたびに `routePoints` へアンカー点も残すよう変更し、運行履歴のルート線が再び見えやすくなるよう修正
- `routePoints` が弱い日でも、イベント位置情報から日別の補助ルートを描画する fallback を追加
- `ルート表示` 画面に `記録点` と `補助地点` の件数を表示し、どの程度 GPS 記録と補助線が使われているか分かるよう変更
- 日報タイムラインで `高速開始 / 高速終了 / 高速道路` を明示ラベル・明示色で表示するよう変更
- `運行詳細 > Obsidian送信` の保存ノートに `## 復元用JSON` を追加し、`operation_log` JSON をそのまま保存して Obsidian 側から復元しやすくした
- Obsidian 保存先は `AI` vault の同一ノート更新を維持

### 検証

- `npm run typecheck`
- `npm run build`
- `npx cap sync android`
- `android\\gradlew.bat -PtracklogAppBuildDir=build-alt assembleDebug --no-daemon`
- 実機 `SCG34`（`RFCY70L6HTF`）で `ルート表示` を確認し、`記録点: 2855 件 / 補助地点: 94 件 / 日数: 8 日` を表示できることを確認
- 実機で `Obsidian送信` を実行し、`AI/Inbox/TrackLog運行記録 2026-03-12 38e18a0d.md` が更新されることを確認
- 端末保存ノートを pull して、`## 復元用JSON` と `"recordType": "operation_log"` が含まれることを確認
- `adb install -r android\\app\\build-alt\\outputs\\apk\\debug\\app-debug.apk`
- `adb shell am start -W -n com.tracklog.assist/.MainActivity`
- 直後の `logcat` に `FATAL EXCEPTION` / `ANR in com.tracklog.assist` なし

### APK

- File: `output/tracklog-assist-debug.apk`
- SHA-256: `485E0E10A63425C862EE16C76D6EE2B6B032B61934CBD2EB26747C8520146D49`
- Device install: completed on `SCG34` (`RFCY70L6HTF`) with `adb install -r`
- Launch check: `am start -W -n com.tracklog.assist/.MainActivity` returned `Status: ok` (`TotalTime: 342ms`)

## 2026-03-10

### フェリー運用と法令チェックの最終確定

- `フェリー乗船 / フェリー下船` イベントをホーム画面と音声操作から扱えるようにした
- `フェリー乗船` を押した時点で休息中でなければ、同時刻で `休息開始 -> フェリー乗船` を自動記録するよう変更
- `フェリー下船` を押さないまま `休息終了` した場合は、同時刻で `フェリー下船` を自動補完するよう変更
- 日報では `フェリー` を `休息` から分離し、`休息` は乗船前後のみ、`フェリー` は乗船から下船までを別表示するよう変更
- 法令チェックは `休息相当 = 休息 + フェリー` として扱い、`一般 / 長距離特例候補 / フェリー特例` の自動判定、`48時間運転 18時間`、`2週平均 44時間/週`、`連続運転 4時間 / 4時間30分` の警告表示を追加
- `長距離特例候補` の自動判定は `450km 以上` と複数日構成・休息地情報からの推定で、`住所地外休息` と `週4勤務以内` の厳密条件入力は未対応

### 検証

- `npm run typecheck`
- `npm run build`
- `npx cap sync android`
- `android\\gradlew.bat -PtracklogAppBuildDir=build-alt assembleDebug --no-daemon`
- ローカル再現で `休息 -> フェリー -> 休息` が `休息 30分 + フェリー 2時間30分 + 休息 3時間` のように分離されることを確認
- `adb install -r output\\tracklog-assist-debug.apk`
- `adb shell am start -W -n com.tracklog.assist/.MainActivity`
- 起動直後の `logcat` に `FATAL EXCEPTION` / `ANR in com.tracklog.assist` なし

### APK

- File: `output/tracklog-assist-debug.apk`
- SHA-256: `C04DF56846B589554E158F373A7B3AE300A642B4AB5714504B08B87CCD2F06D3`
- Device install: completed on `SCG34` (`RFCY70L6HTF`) with `adb install -r`
- Launch check: `am start -W -n com.tracklog.assist/.MainActivity` returned `Status: ok` (`TotalTime: 284ms`)

### 日報項目別集計の業務統合

- `運行日報 > 日報 > 項目別集計` を `運転 / 業務 / 休憩 / 休息 / 合計` の構成へ整理
- `業務` には従来の `業務` に加えて `積込 / 荷卸 / 待機` を含めるよう変更し、`待機` の単独表示を削除
- 上段の `稼働時間` カードも同じ定義へ揃え、`運転 / 業務` の2区分で表示するよう変更
- 15分丸めと各日合計 `24:00` の仕様は維持

### 検証

- `npm run typecheck`
- `npm run build`
- `npx cap sync android`
- `android\\gradlew.bat -PtracklogAppBuildDir=build-alt assembleDebug --no-daemon`
- `adb install -r output\\tracklog-assist-debug.apk`
- `adb shell am start -W -n com.tracklog.assist/.MainActivity`
- 起動直後の `logcat` に `FATAL EXCEPTION` / `ANR in com.tracklog.assist` なし

### APK

- File: `output/tracklog-assist-debug.apk`
- SHA-256: `869AC3DD3932CBCAEF9B76A389977DE532B1FEC35A5843F962B0B3737FDF1D09`
- Device install: completed on `SCG34` (`RFCY70L6HTF`) with `adb install -r`
- Launch check: `am start -W -n com.tracklog.assist/.MainActivity` returned `Status: ok` (`TotalTime: 450ms`)

## 2026-03-09

### 日報インポート修正

- `運行日報 > 新規登録` で、`運行履歴データ:` 付き共有テキストをそのまま貼っても JSON を取り込めるよう修正
- `dayRuns` が日報用形式ではない共有データでも、同梱の `events` から日報化できるよう修正
- `operation_log` を日報登録側でも受け付け、主要イベント時刻を再構成して日報化できるよう修正
- 日報に変換できるイベントがない場合は、空の運行を保存せず明示エラーを返すよう変更

### 実データ確認後の追加修正

- 実機に残っていた貼り付けテキストを確認したところ、`運行履歴データ:` の共有文字列が途中で切れ、末尾の `}` / `]` が欠けていた
- `運行詳細 > AI要約` の共有 payload を `operation_log` の compact 形式へ変更し、`validation` / `dayRuns` / `events` と整形空白を省いて短縮
- `parseJsonInput` で共有テキストの途中切れを判定し、`共有テキストが途中で切れています。最新版のアプリで再共有して貼り付けてください` を返すよう変更
- 実データから再構成した compact payload は `4119` 文字で、ローカル検証では `6日分` の日報へ変換できることを確認

### 日報15分丸め / Obsidian直送

- 日報集計を `00 / 15 / 30 / 45` の15分単位に丸め、`運転 / 業務 / 積込 / 荷卸 / 待機 / 休憩 / 休息` の合計が必ず `24:00` になるよう変更
- 休息が日をまたぐ場合は `24:00` で日を区切り、翌日 `00:00` 以降の休息を次の日の日報へ入れるよう変更
- `運行日報` 画面に `積込 / 荷卸 / 合計` を追加し、時刻表示も15分単位に揃えた
- `運行詳細` から `Obsidian送信` を追加し、丸め済み日報の Markdown と compact `operation_log` JSON を `md.obsidian` へワンクリック送信できるよう変更
- Android 側に `AppSharePlugin` を追加し、`ACTION_SEND` を `md.obsidian` へ直接送れるようにした
- Windows の `app/build` ロック回避用として、必要時に `-PtracklogAppBuildDir=...` で代替 build dir を使えるようにした

### 検証

- `npm run typecheck`
- `npm run build`
- `npx cap sync android`
- `android\\gradlew.bat -PtracklogAppBuildDir=build-alt assembleDebug --no-daemon`
- ローカル検証で、日またぎ休息を含むサンプル日報の各日合計が `24:00` になることを確認
- 実機 `SCG34` (`RFCY70L6HTF`) で `md.obsidian` パッケージ存在を確認し、`ACTION_SEND` の直接起動が `Status: ok` で解決されることを確認

### APK

- File: `output/tracklog-assist-debug.apk`
- SHA-256: `9767767CF5F2867FFD89042017DDDD3BCD1DBCA8415EAD980102B2FF2DB46337`
- Device install: completed on `SCG34` (`RFCY70L6HTF`) with `adb install -r`
- Launch check: `am start -W -n com.tracklog.assist/.MainActivity` returned `Status: ok` (`TotalTime: 367ms`)
- Immediate log check: no `FATAL EXCEPTION` / `ANR in` detected after launch
- Obsidian direct-share smoke test: `am start -W -a android.intent.action.SEND -t text/plain -p md.obsidian ...` returned `Status: ok`
