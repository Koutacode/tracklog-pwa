# TrackLog Agent Rules

この `AGENTS.md` は `C:\Users\matum\OneDrive\デスクトップ\TrackLog` 配下でのみ有効。

## Current Product Policy
- TrackLog は運行記録アプリ。最重要機能は「バックグラウンドでのルート記録」と「高速道路の開始・終了判定」。
- 運転者向けTrackLogアプリの正式対応は Android のみとし、Capacitor Native APKとして扱う。パッケージID `com.tracklog.assist` は変更しない。
- Android APKは会社の利用者へ配布する前提とし、運転者の位置記録、位置共有、管理者からのメッセージ／通知を正式機能として維持する。
- 管理者Web画面と現在地共有サイトは別用途として維持する。管理者のGoogleログイン、端末・位置共有状況の確認、利用者へのメッセージ送信を壊さない。
- 既存PWAは互換・保守目的で残すが、運転者向け新機能やバックグラウンド記録の保証対象にはしない。明示依頼がない限り、PWA配布導線の拡張、アップデータ、汎用インストール誘導は追加しない。

## High Priority Behavior
- 高速道路イベントでは、開始IC名と終了IC名が運行履歴・日報で分かることを優先する。
- IC名解決は、オンライン時に即時実行し、失敗時は既存の再試行ジョブで復旧させる。
- IC候補は `motorway_junction` だけに限定せず、料金所、ETCゲート、高速接続路の名前も補助候補として扱う。
- 高速終了は「終了 / 継続」の確認アクション前提を維持する。
- 診断表示は実態ベースで判定し、黄色固定にしない。
- AI関連の固定文言として `要約してください` を自動挿入しない。

## Build / Artifact
- 会社配布URLは `https://github.com/Koutacode/tracklog-pwa/releases/latest/download/tracklog-assist-debug.apk` のみを案内する。過去タグURLやPWAをアプリ共有文へ入れない。
- ローカルbuildと公開latestに差がある状態で配布しない。version tagの通常Release公開後、`npm run release:verify:apk` でlatest・version・versionCode・署名・SHAを検証し、公開APKで `output/tracklog-assist-debug.apk` を置換してから実機へ `adb install -r` する。
- 新しいReleaseのlatest URLとSHAが確認できた後、過去ReleaseのAPK assetは配布対象から外す。ロールバックは旧APKの再配布ではなく、より大きいversionCodeの新Releaseで行う。
- 基本確認手順:
  1. `npm run typecheck`
  2. `npm run check:csp`
  3. `npm run build`
  4. `npm run cap:sync:android`
  5. `android\gradlew.bat assembleDebug`（`android` ディレクトリで実行）
- 配布用デバッグAPKは `output/tracklog-assist-debug.apk` を最新化する。
- 実機確認や復旧で作った一時スクリーンショット、抽出ログ、検証ファイルは確認後に削除する。
- 恒久保持が必要な端末退避データだけ `output/device-backup/*.tar` のような成果物として残す。

## Device Verification
- 実機確認の既定手順は `adb install -r -> 起動確認 -> ログ確認`。
- 進行中の運行データが残っている可能性がある端末では、ユーザーの明示指示なしにアンインストールしない。
- `アンインストール -> 再インストール` は、データ消失リスクがない検証端末に限る。
- 復旧系の変更では、可能なら先に端末データを退避し、復旧後も `install -r` でクリーンAPKへ戻す。
- 優先確認項目:
  - 起動クラッシュ / ANR がないこと
  - バックグラウンド遷移後もプロセスが維持されること
  - 位置情報 / 通知 / Exact Alarm / 電池最適化除外の状態
  - 高速開始・高速終了イベントにIC名が保存されること

## Google Drive / GitHub
- Obsidian と Notion は今後の記録先として更新しない。Google Drive を第二のノート兼運用記録の正本として使う。
- 今後の TrackLog の運用ログ、実装・検証メモ、APK・Release情報、GitHub/CI作業、調査判断、重要な設定変更、必要なファイル・文章・要約は、最終報告前に Google Drive へ追加または既存文書を編集して反映する。
- 記録には、目的、日付、変更ファイル、検証結果、成果物パス、端末状態、判断理由、未解決事項、次回復旧手順を含める。
- Google Drive 内は年・月単位で整理する。基本構成は `TrackLog/<YYYY>/<YYYY-MM>/` とし、作業ログ、リリース情報、チャット履歴・要約、関連ファイルを後から追跡しやすい名前と日付で保存する。
- 同じ対象・同じ月の記録が既にある場合は、重複文書を増やすより既存文書への追記・更新を優先し、変更履歴と決定事項を保持する。
- Android / Chrome で使う実際のパスワード値は、承認済みの標準保存先として Google Password Manager に保存する。利用できるサービスではパスキーを優先し、パスワードが必要な場合はサービスごとに異なる自動生成パスワードを使う。
- Google Drive に保存してよい認証関連情報は、サービス／アカウント一覧、ID・ユーザー名・メールアドレス、ログインURL、Google Password Manager 内の登録名と保存場所、復旧用メール・電話番号、2段階認証方式、バックアップコードの保管場所、最終確認・ローテーション日時と状態までとする。
- 平文パスワード、APIキー、アクセストークン、JWT、秘密鍵、正確な座標、生の非公開運行データは Google Drive に保存しない。Codexやチャットにも秘密値を貼り付けるよう依頼しない。
- 今後Codexが認証情報を記録する場合は、ユーザーが秘密値を Google Password Manager へ直接保存した後、Google Drive 側の非秘密の索引・復旧情報だけを更新する。
- 過去資料に平文の秘密値が存在する可能性がある場合は、自動で閲覧・転記・公開せず、別途レビューした移行と認証情報のローテーション手順として扱う。
- 既存の Notion 履歴は削除しない。Google Drive への移行・複製は、ユーザーから明示的に依頼された場合に限って行う。
