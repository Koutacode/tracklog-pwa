# 公開情報削減の検証記録

2026-10-12。公開資料の個人発言、私有Driveリンク、端末診断・個人環境の詳細、非公開チャット識別子を保守用の要約へ整理する。初期SQLの固定メールによる管理者自動登録を除去し、新規環境だけの登録手順を [REMOTE_SETUP.md](../REMOTE_SETUP.md) に残す。

## 維持する動作

- 公開repo、元の固定Release URL、JS/Androidの更新先、workflow、アプリversionは変更しない。
- アプリコード、認証方式、管理者判定関数、RLS/権限は変更しない。本番DBに接続せず、既存の `admin_users` は維持する。既存環境での再登録・migration再実行は不要。
- 新規環境は管理者が空のまま開始する。全migration適用後、信頼された管理者が非公開コピーで明示登録する。例示値・不正値・既存行ありの場合は拒否し、無効化済み行も再有効化しない。空判定と登録は同じトランザクション内で排他ロックする。

## ローカル検証

Node.js 22、合成データのみを使用。

- `node scripts/test-admin-bootstrap.mjs`: 成功。初期SQLをインメモリPostgreSQL（PGlite）で実行し、未登録者拒否、例示値・不正値拒否、明示登録、大小文字照合、他アカウント・JWTメール欠落の拒否、既存・無効化済み管理者と運行・イベント行の保持を確認。初期の公開関数と後続migrationの現行private管理者判定関数の両方を実行する。PGliteで非対応の `create extension pgcrypto` のみ省略する。この試験を `test:logic` に登録した。
- `typecheck`、`test:logic`、`test:auth-enrollment`、`test:sync`、`test:release-apk`、`check:csp`、`build`、`check:offline`: すべて成功。追加した現行private判定の試験も単独で再実行して成功。
- `git diff --check`: 成功。アプリ・Android・workflow・lockfile・配布設定の差分なし。初期SQLは固定メールseedの除去と説明コメント以外の変更なし。package.jsonは試験の登録のみ変更。
- 追跡テキストの機械走査では対象の初期メール実値、私有Drive URL、個人Windowsパス、私用thread URLの残存なし。資料の技術的原因・検証限界・復旧方法は保持する。機械走査は全種類の個人情報の不存在を保証しない。

## 限界と次の確認

本番Googleログイン、本人の管理者画面、Android実機・GPS・通知・実運行・実APK更新は未検証。ローカルAndroidコンパイルは完全なJDK/SDKがないため未実施。既存データ保持は合成データの回帰試験と実装不変更の確認であり、実端末の検証ではない。SQL試験は全migrationの新規導入、実OAuth、本番RLS、複数接続の同時bootstrapを検証したものではない。

この変更はPRブランチの現在のツリーで露出を減らす。未マージのmain、過去Git履歴、PR差分、既存コピーには以前の情報が残る。履歴rewrite・force push・repo非公開化・資格情報操作・本番DB操作は行わない。下書きPRまでとし、merge・release・deployは行わない。CIの最終SHAと結果はPR本文で記録する。

運用記録は既存の非公開月次ログへ反映する。私有リンクや個人情報を公開repoへ戻さない。反映できなかった場合は最終報告で未反映と次の同期手順を明記する。
