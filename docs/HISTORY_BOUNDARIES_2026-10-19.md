# 住所未取得の休息・フェリー境界表示（2026-10-19）

基準 main は 7277b30、最新公開は v0.1.76。作業開始時に実行中 CI なし、同内容の公開済み修正なし。v0.1.77 / versionCode 75 を準備。

## 変更とレビュー

- tripDetailLocationInfo.ts: rest_start / rest_end / boarding / disembark に限定し、住所なしでも地点情報を表示。空白住所も未取得として扱う。
- TripDetail.tsx: 対象境界に「住所未取得」を表示。運行境界の保存時刻属性、既存の15分丸め、高速道路表示、住所なし drive_start 等の除外を維持。
- 回帰試験: 4種の境界、同時刻の終了、null・未定義・空・空白住所、住所あり、入力不変、画面HTMLを確認。
- 保存・同期・認識・署名・更新経路は変更なし。イベント補完や住所推定なし。実装差分を自己レビュー済み。

## 検証

Node 22 / JDK 21 / Android SDK 36 を確認。npm ci、typecheck、test:logic、test:sync（36項目）、check:csp、build、check:offline（39 precache / 32 build assets）、cap:sync:android、test:release-apk が成功。
Android testDebugUnitTest / assembleDebugAndroidTest / assembleDebug 成功。
表示確認は合成データの React 静的 HTML。実機インストール・実走行・GPS・通知は未確認。

## 公開と記録

PR と main の CI 成功後、同じ main SHA の未使用タグから既存 Android Release を起動する。公開後は latest / タグ / APK 内版 / versionCode / 既存署名 / SHA sidecar を照合し、版別フォルダーへ保存する。既存 output APK と過去 Release 資産は上書きしない。
本依頼の他サービスへの情報送信制限を優先し、Google Drive へは送信しない。Drive 未反映。必要時は別途承認後に既存月次文書と非公開年月フォルダーへ検証済み APK・SHA と記録を同期する。
復旧は既存 APK の差替えではなく、より大きい versionCode の修正版 Release を作成する。
