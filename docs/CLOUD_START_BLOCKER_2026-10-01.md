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

## 保存構成の再公開と親チャットでの記録反映

2026-10-01 10:22ごろ、利用者からセットアップチャットの「構築・検証・設定保存は完了し、PublishとDriveは接続のある親で実行してほしい」という結果を受け、親チャットで続行した。最新のセットアップ結果では保存された構成を現在の環境も参照し、ツールの再確認が成功している。ただし、セットアップ側には環境UI・Publish・Drive操作ツールが提供されていないことを確認した。

10:24〜10:26ごろ、親の公式UIで環境名 `TrackLog-APK`、repo `Koutacode/tracklog-pwa`、利用できるユーザー `自分のみ`、すべての変更を保存済みの表示、Install script/Start skillを確認した。15許可ドメインを維持し、ネットワークSecrets・環境変数の追加はない。今回は `Save and publish` が表示されていたため、環境パネルの「公開」を実行し、`Environment published` / `Published` の完了表示を確認した。9:30の公開記録とは別に、今回保存された構成を再公開した結果として記録する。

公開後に環境画面のフォローアップ欄から通常の新規Cloud受入を1回だけ開始したが、`メッセージの送信中にエラーが発生しました` / `Unable to determine project root for task` が再現した。画面は元のセットアップURLのままで、通常タスクIDやコマンド開始を確認できない。試験入力は元の空欄へ戻した。同じ開始試験や公開を繰り返さない。環境のPublish完了と通常タスクの開始問題を区別し、GitHub push権限・通常CloudのDrive能力は未検証として保持する。既存のサポート調査を継続する。

親のDrive接続で既存10月月次ログへ今回の結果を1件追記し、既存全文の保持と読み戻しを確認した。公開済みv0.1.64/code62のAPK・SHAは保存済みのため再アップロードせず、新Release・端末操作・本番DB変更は行わない。

## Google Driveプラグインを明示した追加受入試験

2026-10-01 12:20ごろ、利用者のCloudでのbrowser/Driveツール導入試行の明示依頼により、親のPlugin Managementと公式UIでGoogle Driveのinstalled/ENABLED・アカウント接続済みを確認した。アカウントメールや私的文書IDは記録しない。

セットアップチャット `01a0f4d2-29e2-7420-9e82-b832e6ae208b` の「新しいクラウドチャットでフォローアップ」欄で、`+`のPluginsにGoogle Drive候補があり、`@Google Drive`から実チップを指定できた。既承認の通常Cloud受入として、既存月次文書の名前/mimeTypeのみを読む試験を1回送信したが、`Unable to determine project root for task`が再現した。URLは元のセットアップのままで、新しい通常タスクID・コマンド開始・Drive呼出し結果は確認できない。原入力は空欄へ戻した。

今回確認したのは親の導入/有効化/接続状態とCloud入力欄の候補・明示指定まで。CloudでのDrive実使用・APK保存は未検証であり、別チャットの「候補なし」をアカウント全体の未導入へ一般化しない。公式Cloud制限のComputer/browser use未対応は、このroot開始障害やDrive提供可否とは別に扱う。

アプリ、DB、接続権限、環境設定、Publish/Republish、clone、端末を変更していない。次はサポートによる正式な修復後に、通常タスクでGit rootを確認し、`@Google Drive`を明示した最小読取を再検証する。同じ開始試験や環境再公開を追加で繰り返さない。

今回のDrive指定付き再現結果と、通常Codex CloudでのDrive対応/有効化方法の確認依頼を既存サポート会話へ追加送信し、送信済み本文を確認した。担当者の修復完了回答はまだ確認していない。スクリーンショットではDriveチップ指定を確認できるが、開始エラーのtoastは撮影時点で消えているため、画像だけをエラーの証拠とは扱わない。親の既存10月月次ログへ同内容を追記し、読み戻し済み。

公式参照: [Cloudの制限](https://learn.chatgpt.com/docs/environments/cloud-environments#current-limitations)、[Pluginsの利用](https://learn.chatgpt.com/docs/plugins)。
