# 公開情報削減の検証記録

2026-10-11。公開資料の個人発言、私有Driveリンク、端末診断・個人環境の詳細、非公開チャット識別子を保守用の要約へ整理する。初期SQLの個人メール自動登録を除去し、新規環境だけの管理者登録手順を `REMOTE_SETUP.md` に残す。

## 維持する動作

- 公開repo、元の固定Release URL、JS/Androidの更新先、workflow、アプリversionは変更しない。
- アプリコード、認証方式、サーバーの管理者判定、RLS/権限、本番DBの `admin_users` は変更しない。既存環境での再登録・migration再実行は不要。
- 新規環境は管理者が空のまま開始する。登録手順は例示値・空値・既存行ありの場合に拒否し、既存の無効化済み行も再有効化しない。

## ローカル検証

Node.js 22、合成データのみを使用。本番には接続していない。

- `node scripts/test-admin-bootstrap.mjs`: 成功。初期SQLをインメモリPostgreSQL（PGlite）で実行し、空テーブルでの拒否、例示値・不正値の拒否、明示登録、大小文字を含む管理者照合、他アカウントの拒否、既存行・無効化済み行の保持を確認。PGliteで非対応の `create extension pgcrypto` だけ省略する。クラウドのOAuthや全migrationの導入試験ではない。
- `typecheck`、`test:sync`、`test:auth-enrollment`、`test:release-apk`、`check:csp`、`build`、`check:offline`: 成功。
- `test:logic`: 管理者セッション、認証所有、IndexedDB・送信キュー・同期等の先行試験は成功。末尾の `NativeUpdateNotice.test.jsx` が、環境の既存依存に `react-test-renderer` がないため停止。全体成功とは扱わない。CIではlockfileから依存を導入して再確認する。
- `git diff --check`: 成功。アプリ・Android・workflowの差分なし。初期SQLは個人メールseedの除去と説明コメント以外の変更なし。

## 限界と次の確認

本番Googleログイン、本人の管理者画面、Android実機・GPS・通知・実運行・実APK更新は未検証。ローカルAndroidコンパイルは完全なJDK/SDKがないため未実施。既存データ保持は合成データの回帰試験と実装不変更の確認であり、実端末の検証ではない。

この変更は現在の公開ツリーの露出を減らす。過去Git履歴、PR差分、既存コピーには以前の情報が残る。履歴rewrite・force push・repo非公開化・資格情報操作・本番DB操作はしない。下書きPRまでとし、merge・release・deployは行わない。

Google Drive未反映。必要な場合は既存月次記録へこの検証要約とPRリンクを追記し、非公開の保存先URLや個人情報を公開repoへ戻さない。
