# TrackLog Cloud通常チャットの開始障害

確認日: 2026-10-01、日本時間。非秘密の引き継ぎ資料。利用者の明示許可後、公式サポートへ送信し、人間の担当者への引き継ぎを依頼済み（後述）。

## 確認された状態

- 対象: GitHub `Koutacode/tracklog-pwa` / main。
- 利用画面: Windows 11上のChromeで、公式 `https://chatgpt.com/` とCloud環境設定UIを使用。
- 既存環境「TrackLog-修復」: Install script/Start skillを更新し、保存/RepublishでPublished成功。しかしsetup側の再実行と通常タスク開始はroot特定エラー。
- 新規環境「TrackLog-APK」: 同じrepoを公式作成UIで選択。既存2環境は保持。自分のみ、ネットワークSecrets/環境変数の追加なし。
- 新規セットアップチャットID: `01a0f4d2-29e2-7420-9e82-b832e6ae208b`。09:16開始、09:27完了。
- セットアップ中のGit root: `/workspace/tracklog-pwa`。基準main SHA: `da16fa6bb80cb970b8815ee30c0b632d3fda9524`。
- Node22、fullJDK21/javac、SDK36、Build Tools36、ghのpreflight成功。Web/同期の基本検証、Android単体85件と本体/テストAPKコンパイル、公開APKのSHA・署名照合も成功。
- Install script/Start skillを保存、親側UIで名前/自分のみを確認してPublish。09:30前後にEnvironment published / Published表示を確認。

## 最小再現手順と結果

1. 公式ホームで実行場所Cloudを使い、環境「TrackLog-APK」を選択する。
2. 対象repoのGit rootとtoolchainを確認する非破壊の受入メッセージを入力して送信する。
3. メッセージ送信中にエラーとなり、`Unable to determine project root for task` が表示される。
4. 画面上で通常チャットIDやコマンドの実行開始を確認できない。
5. 公開後にホームを再読み込みし、環境選択と入力一致を再確認した最後の比較試験でも同じ結果。

通常タスクでのpush dry-runやDrive能力確認は、開始できないため未実行。元の入力下書きは試験後に復元し、空白を正規化した内容一致を確認した。アプリの追加修正、新Release/tag、端末操作、本番DB接続は行っていない。

## 原因として確定していないこと

推論量「軽」、Node/JDK/SDK不足、GitHub認証失敗が原因とは確認していない。セットアップのコマンドは正常に実行できる。画面から保存される環境設定にmount_path編集欄は見つからず、内部原因は未確定。「mount_pathが空」は旧peerの報告であり、この新規環境で内部値を直接確認した事実ではない。

公式Docs/Helpにこの正確なエラーへのrepo mount修復手順は見つからなかった。`project_root_markers`は設定/AGENTS.md発見の仕組みであり、この開始前エラーの修復として変更する根拠はない。内部API探索、認証情報取得、セキュリティ制約回避、別clone、既存環境削除を解決策として実行していない。同じエラーへの無制限再試行も行わない。

## 次に必要な確認

開始前エラーの原因調査と、公式UIまたは提供ツールで利用者が実施できる復旧方法の案内をサポートへ依頼する。上記の日時・環境名・セットアップチャットID・repo・Published成功・通常開始前エラーが調査資料となる。秘密値、署名鍵、端末データ、座標は添付しない。

復旧後は通常の新規CloudチャットでGit root/checkout/共有skill、保存toolchain、Web/同期/Android検証、公開APK照合、GitHub送信先認証、Drive能力を再確認する。Publish成功やsetup成功だけをこの受入の代わりにしない。受入試験ではアプリの追加修正・新Releaseは不要。

公式参照: [Cloud環境の更新とトラブルシューティング](https://learn.chatgpt.com/docs/environments/cloud-environments)、[Project root detection](https://learn.chatgpt.com/docs/config-file/config-advanced#project-root-detection)、[OpenAIサポート](https://help.openai.com/en/articles/6614161-how-can-i-contact-support)。

## 公式サポートへの送信と追加試験

2026-10-01、利用者が非秘密再現資料のOpenAIサポート送信を「許可」と明示承認。公式Help Centerへ既存アカウントでログインし、09:46前後に日本語で問題・再現手順・日時・環境名・repo/main・セットアップチャットID・成功した検証を送信した。チャットの送信済みメッセージと仮想アシスタントの返信を確認した。メールアドレス、認証値、HAR、端末データ、正確な位置情報は資料へ追加していない。

一次回答は、環境画面からの新規タスク開始、Republish、新規環境での比較を案内した。後者2項目は既に実施済みのため繰り返さず、未確認だった環境画面からの開始だけを09:48〜09:49前後に1回確認した。「TrackLog-APK」のrepoとPublished表示を確認し、Environment published直下の「新しいクラウドチャットでフォローアップ」から読み取り検証を送信したが、`メッセージの送信中にエラーが発生しました` / `Unable to determine project root for task` が再現した。通常タスクの開始は確認できず、試験入力は元の空欄へ戻した。設定・既存環境・コード・APKを変更していない。

両環境とホーム／環境画面の両経路で再現することを追加送信し、技術担当者への調査引き継ぎと受付番号を依頼。09:50〜09:51前後に確認画面の「エスカレート」を選び、`Escalation requested` と `Escalated to a support specialist` を確認した。画面では今後数日以内の返信とメールへの返信通知が案内された。受付番号は表示されていない。送信・引き継ぎ依頼の完了を、原因確定・修復完了・担当者の回答済みとは扱わない。

Cloud通常受入は引き続き未完了。サポートの回答または正式な修復後に、通常タスクの開始、保存ツール、GitHub送信権限とDrive能力を確認する。今回のアプリ統合v0.1.64は既に正式公開・実機更新・Drive保存済み。利用者の「最終的に公開まで」という追加指示と、今後の改善依頼を検証・push・CI・正式Release・公開APK照合・Drive保存まで進める既存承認を維持する。資料のみの追記のため、新APK Releaseや端末の再導入は不要。
