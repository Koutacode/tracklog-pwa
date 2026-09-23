# TrackLog Changelog

## 2026-09-23 v0.1.63

### 管理者確認の重複認証待ちを改善

- 取得・検証済みトークンを明示する管理者確認などの通信で、別の古いWebView認証の更新を待たないよう修正
- Android起動時にSDKが期限切れ保存情報を独自に更新する競合を防止。元の認証情報は保持し、更新はnative処理へ任せる
- 通常Web通信、利用者検証、サーバーの管理者権限照合、HTTPエラーの扱いを維持
- 実SDKによる期限切れセッション・並行トークン・認証エラーの回帰テストを追加
- 詳細は `docs/ADMIN_ACCESS_RECOVERY_2026-09-23.md`。Android `versionName=0.1.63` / `versionCode=61`

## 2026-09-23 v0.1.62

### 起動待機とIC取得・編集の改善

- 承認済みAndroid端末は保存済み登録情報と認証主体の一致を先に確認し、クラウド確認を背景で継続。登録確認が返らない場合は8秒後に再確認操作を表示
- 起動前の認証更新待ちを除去し、保存情報の読み取りも2秒で打ち切る。ログアウト・拒否・失効と遅延応答の競合を保護
- 住所補完とIC取得が競合して取得結果を保存できない問題を修正。IC通信の重複認証待ち、無期限待機、1件の例外で後続の再取得を止める問題も修正
- IC名から地図上の候補を検索し、選択した名前と住所を一緒に保存。元の観測位置と手動修正を保持し、後着の住所取得による上書きを防止
- 未取得理由と次回再試行日時を表示。名前検索を含むIC検索サーバーv4を反映し、既存認証・承認端末の確認を維持
- `versionName=0.1.62` / `versionCode=60`を通常Release公開。latestの版・署名・SHAを検証し、会社配布用APKを公開版へ更新。公開・実機検証の詳細は `docs/KEEP_IMPROVEMENTS_2026-09-23.md` に記録

## 2026-09-19 v0.1.61

### 位置取得を運行開始から終了までに限定

- 運行開始前・終了後はGPS/NETWORK購読と新しい現在地送信を停止。既存の休息・フェリー中の記録停止にも追随
- 運行中の高速道路判定に必要な10秒周期を維持し、定期確認による同じ位置購読の解除・再登録を抑止
- Home表示・権限設定・定期共有による重複位置取得を除去。管理者の現在地要求も運行中だけ取得し、メッセージ受信は維持
- 開始を保存してから位置を取得し、終了時は同じ運行の直近の記録位置を使用。未完了の単発取得も終了時に取り消す
- 認証更新の通信待ちが運行終了時の位置停止を遅らせないよう、追跡状態の反映を分離
- Androidを `versionName=0.1.61` / `versionCode=59` に更新

## 2026-09-18 v0.1.60

### IC取得改善版の正式配布とAndroid SDK準備の修正

- v0.1.59で実装・検証した以下のIC取得改善を含む正式配布版。v0.1.59はSDK準備工程で停止したためAPKを公開していない
- Android SDKセットアップをv4へ更新し、配布が終了した `tools` を要求せず `platform-tools` を明示するよう修正
- Androidを `versionName=0.1.60` / `versionCode=58` に更新。失敗したv0.1.59タグは履歴として保持

## 2026-09-18 v0.1.59

### 高速道路IC取得の候補選択と通信復旧

- IC候補の距離条件を満たす候補を先に絞り込み、遠い候補に近い料金所・接続路の候補が隠れる問題を修正
- 地図APIのHTTP 200に含まれる実行エラーを「IC候補なし」として保存せず、代替サーバーと再試行へ引き継ぐよう修正
- 地図APIのタイムアウトを応答本文の読取まで適用し、本文の通信停止でも代替先に切り替えるよう修正
- IC照会の待ち時間をサーバーの代替先探索と整合させ、Android側の道路判定が途中で待機を打ち切る問題を修正
- 認証更新時の一時的な通信失敗を15分の認証待ちに分類する問題を修正。一時障害の初回待ちを15秒に短縮し、アプリ復帰時にも未取得ICの再試行を再開
- イベントの記録位置で候補がないとき、近接する同一運行のGPS軌跡を限定的に照会。自動終了は確認操作時刻でなく検知時刻を基準にし、候補の矛盾や通信失敗時は確定しない
- 既存の手動修正と遅延結果の競合保護を維持し、以前の方式で試行上限に達した未取得ICを更新後に再評価
- Androidを `versionName=0.1.59` / `versionCode=57` に更新

## 2026-09-05 v0.1.58

### 位置情報OFF中の待機を画面側でも維持

- v0.1.57の実機検証で、端末の位置情報をOFFにすると画面側の定期確認が権限取り消しと判定し、待機中のネイティブサービスを停止する経路を確認して修正
- 利用登録・設定が完了し、位置情報スイッチだけがOFFの場合は、既存の認証・運行状態とネイティブの待機を保持。ONに戻すと位置取得を再開
- 実際の権限取り消し、利用登録の無効化、明示的なログアウトなどの既存停止処理は維持
- Androidを `versionName=0.1.58` / `versionCode=56` に更新

## 2026-09-05 v0.1.57

### バックグラウンド位置記録と高速道路判定の復旧

- サービス再生成後、高速終了判定の通信結果が初回位置情報より先に返っても、保存済みの運行状態から終了確認を復元して処理を継続するよう修正
- 通信失敗後の再試行待ち中にサービスが再開された場合も、保留中の高速道路判定と残り待ち時間を復元するよう修正
- 記録サービスの動作中に位置情報をOFFにした場合は、通知を「位置情報OFF・記録待機中」に切り替えて待機し、利用者がONへ戻した後に位置取得と保留中の判定を再開。OFF中の新規記録を停止し、OS設定は変更しない
- 初めから位置情報がOFFの状態での新規常駐サービス起動は行わず、利用登録・権限等が取り消された場合の既存停止処理を維持

### 日報と運行詳細

- 削除済みの日報が運行詳細の自動保存によって復活しないよう修正。削除状態の確認と保存を同一トランザクションで行い、明示的な日報復元の動作は維持
- 運行詳細の日別集計と時間軸を同時表示し、重複する日報・TL切替導線を整理。自動保存を直列化し、最新の保存要求と失敗時の再試行を保持
- 給油を時間幅のないイベントとして時間軸・日報へ表示し、給油量を保持しながら時間集計への重複加算を防止
- ダークテーマのカード背景・文字コントラストを調整
- Androidを `versionName=0.1.57` / `versionCode=55` に更新

## 2026-08-30 v0.1.56

### 運転者ホームと高速道路操作

- 運転集中モードを廃止し、運行前・運行中とも「ホーム／履歴／メッセージ／その他」の固定ナビから全機能へ到達できる単一画面へ統合
- 現在の基本作業、フェリー、高速道路を最大3行の独立タイマーで表示し、乗船前からの休息と乗船時に自動開始した休息を区別。休息開始から8・9・10・12時間後の目安も15分丸めで表示
- 位置記録が正常な場合は「記録正常」の1行に整理し、実際に位置記録を妨げる異常時だけ、運行操作を隠さず原因と復旧ボタンを表示
- 高速終了は画面ボタンと音声では確認なしで即時保存し、自動判定だけ従来の「終了／継続」確認を維持。手動終了後は残っている自動確認と通知を無効化

### 運行詳細・修正・軌跡表示

- 運行詳細を日別の「項目別時間／TL」中心へ整理し、既存の日報と同じ15分丸め・日本時間24時締めの運転、業務、休憩、フェリー、休息時間を大きな文字で表示
- TLは運転を除外し、積込・荷卸・休憩・休息・フェリーなどを「開始／終了／作業時間」が分かる区間として表示。日跨ぎ、進行中、同時刻、欠損した旧記録も安全側で扱う
- 高速開始IC・終了IC、高速区間時刻、各地点の住所を主要画面に維持し、距離、提出前確認、共有、編集・削除は「詳細・修正」へ整理
- 運転者・管理者の過去運行から走行軌跡地図を削除。現在地共有、高速自動判定、IC名解決に必要なバックグラウンド位置記録は維持
- 未終了の休息・休憩・積込・荷卸の開始記録を別の開始種別へ変更可能にし、対応する終了記録がある場合は同一トランザクションで整合。フェリー自動休息、高速、孤立終了、曖昧な旧記録は変更を拒否

### 端末設定・認証・管理者画面

- 初回端末設定を、位置情報ON、正確な位置、常時位置、通知、電池最適化除外、常駐サービス確認の順に1項目ずつ案内する方式へ変更。Android設定から戻った時だけ最新状態を1回確認
- Android 10の常時位置単独要求、Android 11以降の端末ローカライズ済み許可名、Android 13以降の初回通知許可、公開Intentのフォールバック、常駐サービス実動確認に対応
- 未使用のExact Alarm権限・設定・診断を削除。運行中に設定が外れた場合は全画面を置き換えず警告し、運行終了後は復旧まで次の開始を停止
- OTP後のセッション・トークン・メール・端末認証保存を検証し、未申請、申請失敗、承認待ちを区別。「承認申請を再送」で現在の認証セッションから安全に復旧
- Androidは現在の運転者セッションを管理者本人確認にも再利用し、既存の `admin_users.enabled` をサーバーで照合。Web/PWAの独立管理者OAuthと非管理者の拒否を維持
- Androidの管理者本人確認をAuth API対応clientへ修正し、同じ検証済みtokenでサーバー側allowlistを照合。復旧イベントが発生しない場合も60秒ごとに再確認し、再ログインなしの管理画面導線を復旧
- Androidを `versionName=0.1.56` / `versionCode=54` に更新

## 2026-08-29 v0.1.55

### メール認証後の端末承認申請を修正

- Androidでメール認証に成功した直後は、その場で確認済みのセッションを承認申請に限定して使い、Android常駐側への認証保存が遅延または失敗しても管理者の「承認待ち一覧」に端末を登録できるよう修正
- 承認申請用のアクセストークンはAuthorizationヘッダーだけで渡し、通常の位置・運行データ送信は従来どおりAndroid常駐側が所有する認証情報を使用
- Androidへの認証情報保存後に返されたトークンがメール認証済みセッションと一致することを確認し、競合で古いアカウントの認証情報が返った場合を成功扱いしないよう改善
- `pending` と `unregistered` の端末は位置記録だけを停止して認証情報を保持し、管理者承認の再確認と申請の自動復旧を可能に修正。拒否済みと明示サインアウトだけは従来どおり認証情報を削除
- 画面表示を「承認申請未完了」「管理者承認待ち」「拒否済み」に分け、メール認証済みで申請が届いていない場合は「承認申請を再送」から復旧できるよう変更
- OTP認証から承認申請、承認待ち中の認証保持、画面状態、Edge Functionの初回 `pending` 登録を回帰テストで固定
- Androidを `versionName=0.1.55` / `versionCode=53` に更新

## 2026-08-23 v0.1.54

### Android APK配布の最新版一本化

- 「アプリ共有」と管理者画面の共有文をAndroid APKだけに統一し、過去タグを含まない固定のlatest直接ダウンロードURLだけを共有するよう変更
- 共有前にGitHubの最新通常Releaseと固定名APKを確認し、端末／画面の版より古いAPKしか公開されていない場合は共有を停止して、公開漏れを利用者へ配らないよう修正
- 最新Releaseに固定名 `tracklog-assist-debug.apk` がない場合、別名APKへフォールバックせずエラーにするよう変更
- Android内蔵アップデータは公式latest URLだけを受け付け、package、署名、versionCodeの既存検証と合わせて旧版・別APKの導入を防止
- 新しい通常Releaseの公開時は従来どおり起動・画面復帰・5分周期で検知し、「最新版をインストール」案内からPC接続なしで上書き更新できる動作を維持
- GitHub Releaseをdraftで作成し、添付APKのSHA-256を照合してから公開。公開後もlatestタグと固定URLのAPKが一致しない場合はdraftへ戻す検証を追加
- 新版の公開照合後、過去Releaseから名前違いを含むAPKとSHA assetだけを削除し、固定された旧版URLを通常配布に使えない運用へ変更。リリースノートとタグは保持
- 公開Releaseから再取得・検証したAPKを正式ローカル成果物へ置換し、その同じ公開APKを実機へ `adb install -r` することで公開版と端末版の差を防止
- 公開APKと `.sha256` sidecarを同一トランザクションで更新・再照合し、片方の失敗時は両方を元へ戻すよう検証スクリプトを強化
- Androidを `versionName=0.1.54` / `versionCode=52` に更新

## 2026-08-23 v0.1.53

### Android常駐記録・高速道路判定・IC名の信頼性

- Android常駐位置点を品質判定後に耐久JSONLキューへ保存し、追記中ファイルと送信用spoolを分離。ACK位置の原子的保存、部分行・破損行の隔離、idle時の強制sealで再起動や通信障害時も位置点を失わないよう改善
- WebView停止中もJava常駐サービスを高速道路判定の唯一の主体とし、道路・ETCの強い信号を2回かつ12秒継続して確認した場合だけ開始候補を保存。速度だけでは高速開始を確定しない
- 高速終了は従来どおり「終了する／まだ高速中」の確認を必須とし、通知・ホーム画面の回答を同じ耐久状態へ保存。旧通知、遅延イベント、アプリ更新前の確認が後から状態を巻き戻さないよう世代番号とIDで保護
- IC名解決は一時失敗後も既存名を残して再試行し、同一運行のイベント前後90秒から精度の良い位置点を安全側で補完。遅い自動結果が手入力したIC名を上書き・失敗状態へ降格しないCASを追加
- 開始IC・終了ICの解決結果をホーム、運行履歴、日報へ即時反映し、明示された高速セッションIDが異なる区間を誤結合しないよう修正

### Google認証・管理者機能・画面改善

- AndroidのGoogle／メールPKCEコールバックを直列・単回処理し、cold start、二重コールバック、通信障害、コード交換直後のプロセス終了から安全に復旧。管理者WebのGoogleログインにも同じ一時障害再試行を適用
- 高速確認と管理者メッセージの通知タップを単一dispatcherで振り分け、cold startで片方が失われる問題を修正。位置更新依頼は端末へ保留し、認証・通信復旧後に重複なく再送
- 管理者メッセージの通常ACKが、位置更新依頼の受領時刻を競合で消さないようEdge Functionのupsertを修正（本リリースではローカルコードのみ。サーバーへのデプロイは別工程）
- ホームに位置記録、端末内未取込、最終送信、高速区間、IC解決状態を事実ベースで表示。高速終了ダイアログ、管理者端末一覧、運行履歴をモバイル幅・キーボード・スクリーンリーダー向けに改善
- 未運行のWeb画面では位置APIを自動実行せず、開発時を含む不要な位置許可ポップアップの繰り返しを抑制

### 配布方針・検証・依存関係

- 運転者向け正式対応を会社配布のAndroid APKへ一本化。管理者WebのGoogleログイン、端末・位置共有、管理者メッセージ／通知、現在地共有サイトは正式機能として維持し、既存PWAは互換保守のみとした
- リリース補助を全事前検査、外部Gradleビルド、AndroidTestコンパイルへ統一。APKのpackage/version/埋込version/署名を検証後、原子的に配布成果物へ置換するよう改善
- React Router、tar、brace-expansionを既知の高重要度アドバイザリ修正版へ更新
- Androidを `versionName=0.1.53` / `versionCode=51` に更新

## 2026-08-19 v0.1.52

### 認証更新障害時の再試行抑制

- Supabaseの認証更新が一時的にタイムアウトまたは5xx系エラーになった際、Android常駐サービスとWebViewが短い間隔で同じ更新を繰り返さないよう改善
- 認証更新の一時失敗を端末内で共有し、30秒から最大5分の段階的な待機後に再試行することで、位置情報キューと既存ログイン状態を保持したままサーバー負荷を抑制
- 運転者データ取得用のアクセストークン更新を単一処理へまとめ、15秒周期の監視処理から同じ更新を重複実行しないよう修正
- 新しいWebView認証をAndroid常駐側へ渡す前のユーザー確認も、同じ認証候補で通信障害が続く場合は段階的に待機し、新しいログインは待機中でも直ちに検証できるよう調整
- 新しい認証の保存、トークン更新成功、サインアウト時には待機状態を解除し、古い障害状態が次のログインを妨げないようにした
- ローカル配布ヘルパーを、Android組み立てを実行した場合だけ外部Gradle成果物を配布APKへコピーするよう修正し、古いビルド成果物による上書きを防止
- Androidを `versionName=0.1.52` / `versionCode=50` に更新

## 2026-08-19 v0.1.51

### Androidの管理者・運転者ログイン復旧

- AndroidでGoogleログインやメールのログインリンクからアプリへ戻った際、開始したログイン種別を保持し、管理者用と運転者用の認証セッションを正しく振り分けるよう修正
- AndroidのGoogleログインとメールリンクをPKCEへ切り替え、カスタムURLには長期トークンではなく短時間・一回限りの認証コードだけを返すよう改善
- AndroidのコールバックはPKCEの認証コードだけを受け付け、外部からアクセストークンを注入して端末のログイン先を差し替える経路を遮断
- コールバックの遷移先がURLのクエリまたはハッシュに入る場合の両方を処理し、管理者ログイン後は管理画面へ戻るよう補強
- アプリの初期化前に届いた認証URLを端末内へ一時保持し、起動後に再処理することでコールバックの取りこぼしを防止
- 処理済みの認証URLとログイン種別をすべての端末ストレージから消去し、次回起動時に使用済みコールバックを再処理しないよう修正
- Googleログインのキャンセルや期限切れコードは端末へ再保存せず、ログイン画面へエラーを戻してその場で再試行できるよう改善
- 管理者のGoogleログインとメール認証、運転者ログインの既存導線を維持
- Androidを `versionName=0.1.51` / `versionCode=49` に更新

## 2026-08-17 v0.1.50

### 3時間休憩から休息への変更確認とODO記録

- 休憩が3時間に達しても自動確定せず、「休息に変更してよろしいですか」の確認を回答するまで固定表示するよう変更
- 「はい」を選ぶと休息開始ODO入力へ進み、入力完了後に休憩開始時刻まで遡って休息として表示・集計
- 休息開始ODOに0 kmを入力した場合は休息へ変更しつつ、距離のチェックポイントとしては記録しない
- 「いいえ」を選んだ休憩は休憩のまま継続し、同じ休憩では確認を再表示しない
- 「いいえ」の回答後はAndroidの3時間停止境界を解除し、その後のルート記録を再開
- 回答とODO入力待ちの状態を端末内に保持し、画面復帰やアプリ再起動後も未完了の手順を復元
- Androidを `versionName=0.1.50` / `versionCode=48` に更新

## 2026-08-17 v0.1.49

### 3時間休憩の全区間を休息へ変更

- 休憩が3時間に達したとき、到達後だけを休息にするのではなく、休憩開始時点まで遡って連続区間全体を休息として表示・集計するよう変更
- v0.1.43〜v0.1.48で記録済みの自動変換も、同期済みの元イベントを書き換えず、読み取り時と派生日報の生成時に補正し、運行履歴・日報・月次・法令タイムラインへ同じ判定を適用
- 自動変換済みの休憩開始・終了は通常表示から除き、日報の最低15分補正によって休憩15分が残る問題を防止
- 日付をまたいで3時間へ到達した場合も、休息開始を元の休憩開始日に戻して両日の集計を補正
- Androidの画面OFF中ルート記録は従来どおり「休憩開始から3時間」の境界で停止し、位置記録の判定時刻は変更しない
- Androidを `versionName=0.1.49` / `versionCode=47` に更新

## 2026-08-11 v0.1.48

### フェリー時間の15分集計修正

- フェリー区間だけ実時刻の差分を合計していたため、`14:11` 乗船・`18:06` 下船が `3時間55分` と表示され、日合計が `24時間10分` になる問題を修正
- フェリー内訳、休息からの差し引き、項目別集計を同じ15分境界へ統一し、該当区間を `14:15–18:00 / 3時間45分` として集計
- 元の乗船・下船時刻と法令判定用の実時間は変更せず、過去の日報も表示時に正しい15分集計へ直るようにした
- 実機の該当時刻を使った回帰テストで、通常日の合計が必ず `24:00` になることを確認
- Androidを `versionName=0.1.48` / `versionCode=46` に更新

## 2026-08-07 v0.1.47

### 開始・終了イベントの誤結合と休息状態の復旧

- 積込・荷卸・休憩・休息・フェリー・高速道路などの開始／終了を、セッションIDの完全一致だけに依存せず、時系列の因果関係に基づくFIFOの共通判定へ統一
- すでに終了済みの操作へ遅れて届いた終了イベントと、対応する開始がない孤立終了イベントを、元データを削除せず通常履歴・日報・AI用データ・現在状態から除外するよう変更
- 運行詳細の通常一覧は採用済みペアだけを表示し、編集一覧では元イベントを保持したまま `除外済み` と理由を確認できるようにした
- Workで確認された実データを回帰テスト化し、積込の実時間 `182分 / 76分`、日報投影 `270分`、その後の休息継続を固定
- DBの開始／終了ガード、ホーム画面、バックグラウンド位置送信、同期状態、法令タイムラインを同じ判定へ揃えた

### 高速IC・日跨ぎ・同時刻遷移の補強

- 高速道路区間を全日イベントから解決し、日跨ぎや開始／終了ID不一致でも、開始日の区間へ終了時刻と終了IC名を表示するよう修正
- 除外済みの休息終了が日締め番号を進めないよう、採用済み休息ペアだけで `dayIndex` を計算・再採番するよう変更
- 同一時刻の自動遷移を、別操作の終了 → 同一操作の0分ペア（開始→終了）→ 別操作の開始の順に安定化し、`休憩終了 → 休息開始` が入力順にかかわらず休息状態になるよう修正
- Androidを `versionName=0.1.47` / `versionCode=45` に更新

### 検証

- Supabase Edge Functionsの `deno check`
- `npm run typecheck`
- `npm run test:logic`
- `npm run test:sync`（12件）
- `npm run check:csp`
- `npm run build`
- `npm run check:offline`
- `npm run cap:sync:android`
- `android\\gradlew.bat testDebugUnitTest assembleDebug`

### APK

- Package: `com.tracklog.assist`
- Version: `versionCode=45` / `versionName=0.1.47`
- Local artifact: `output/tracklog-assist-debug.apk`
- Release: `https://github.com/Koutacode/tracklog-pwa/releases/tag/v0.1.47`

## 2026-07-17 v0.1.44

### 高速IC再取得の優先順位修正

- v0.1.43で再取得アルゴリズムを更新した際、すでにIC名取得済みの旧イベントまで再処理対象となり、未取得イベントが後回しになる問題を修正
- IC名が保存済みのイベントはアルゴリズム世代にかかわらず再処理せず、未取得・失敗イベントだけを再取得対象にした
- 既存IC名を無駄に上書きせず、過去に「ログインが必要です」で止まった未取得イベントを優先して復旧できるようにした

## 2026-07-17 v0.1.43

### 日報・フェリー・休憩・認証・高速ICの安定化

- 日報タイムラインを日報集計と同じ15分丸め・最低15分の投影時刻で表示し、日付またぎも翌日へ分割しつつ、実測時刻と法令計算は変更しないようにした
- 休息中でもフェリー乗船を記録でき、位置取得を待たずボタンを押した時刻を乗船時刻として保存するようにした。乗船が自動作成した休息だけは下船時に自動終了する
- 休憩が3時間に達した時点で休憩終了と休息開始を重複なく自動記録し、ODOなしの自動休息を距離計算から除外した。Androidは画面OFF中も3時間の閾値でルート点追加を停止する
- 認証済み端末のセッションをlocalStorageとIndexedDBへ二重保存し、一時的なトークン更新失敗で登録画面や位置記録停止へ戻りにくくした。確定ログアウト・失効時は承認キャッシュで利用を継続しない
- AndroidネイティブとWebViewのトークン復元順序を整理し、一時的な401では位置記録設定を消去せず再試行するようにした
- 高速IC解決前に認証を更新し、401は1回再送、一時障害は失敗回数を消費せず、認証復旧時に即再取得するようにした
- IC解決アルゴリズムをv9へ上げ、旧版で取得失敗になったイベントも再取得対象へ戻した

## 2026-07-10 v0.1.39

### AI要約用データの長文コピー改善

- `運行詳細・編集 > AI要約` は共有シート経由ではなく、全文を直接クリップボードへコピーする方式へ変更
- コピーした全文の文字数を表示し、JSONの後ろに運行IDと文字数を含む終端マーカーを追加
- 長文時は約5,500文字ごとの番号付き分割コピーを表示し、貼り付け先側の文字数制限を回避可能にした
- クリップボードAPIが応答しない場合は1.5秒で従来方式へ自動フォールバック
- Android APKではネイティブのクリップボードAPIを利用し、WebViewの権限制限を回避

## 2026-05-16 v0.1.8

### アプリ内Obsidian送信の削除

- 今後の記録先をNotionに集約する運用に合わせ、`運行詳細・編集` の `Obsidian送信` ボタンを削除
- Obsidian向けMarkdown生成、`obsidian://` URL起動、`md.obsidian` 指定共有、Obsidian専用のAndroid package visibility設定を削除
- AI要約用の共有、設定画面のアプリ共有、管理画面の共有リンク、外部URLを開く処理は維持
- Androidの配布バージョンを `0.1.8` / `versionCode=6` に更新

### 検証

- `npm run typecheck`
- `npm run build`
- `npx cap sync android`
- `android\\gradlew.bat -PtracklogAppBuildDir=build-release-v018 --no-daemon assembleDebug`
- `adb install -r output\\tracklog-assist-debug.apk`
- `adb shell am start -W -n com.tracklog.assist/.MainActivity`
- `adb shell dumpsys package com.tracklog.assist` で `versionCode=6` / `versionName=0.1.8` を確認
- `adb shell pidof com.tracklog.assist` で起動後プロセス維持を確認
- 直近ログに TrackLog の `FATAL EXCEPTION` / `AndroidRuntime` / `ANR` なし
- `dist` / Android同梱assets / `src` / Android manifest から、現行の `Obsidian送信` / `md.obsidian` / `obsidian://` が消えていることを確認
- Cloudflare Pages本番 `https://tracklog-assist.pages.dev/version.json` が `version=0.1.8` を返すことを確認
- 本番 `https://tracklog-assist.pages.dev/sw.js` に `tracklog-shell-v2` と `version.json` バイパスが反映済み
- GitHub Release `v0.1.8` を作成し、`tracklog-assist-debug.apk` を添付済み
- GitHub latest APKリンクが `https://github.com/Koutacode/tracklog-pwa/releases/download/v0.1.8/tracklog-assist-debug.apk` にリダイレクトされることを確認

### APK

- File: `output/tracklog-assist-debug.apk`
- Version: `versionCode=6` / `versionName=0.1.8`
- SHA-256: `1D65B19D44337ACD19DDCBC6874545F8214D16FDE881816A58CB34FEFFEEDB09`
- Size: `6,020,890 bytes`
- Release: `https://github.com/Koutacode/tracklog-pwa/releases/tag/v0.1.8`
- Device install: completed on `SCG34` (`RFCY70L6HTF`) with `adb install -r`

## 2026-05-16 v0.1.7

### Android更新通知の誤検知修正

- 接続中の端末は `versionCode=4` / `versionName=0.1.6` で、GitHub latest も `v0.1.6` だったため、その時点では実際の更新は不要だった
- 更新通知が出た原因は、同一バージョンでも GitHub Release asset の更新時刻がAPKビルド時刻より後だと「新しいリリース」と見なす fallback 判定が残っていたため
- Androidの更新通知判定を修正し、Release tag に `vX.Y.Z` がある場合はアプリ内 `APP_VERSION` より大きい時だけ更新ありと判定するようにした
- 誤検知修正を反映した `0.1.7` / `versionCode=5` のAPKを作成し、接続中の端末へ `adb install -r` で上書きインストールした
- Cloudflare Pages本番 `https://tracklog-assist.pages.dev` へ v0.1.7 をデプロイし、iPhone PWA が `version.json` で最新ビルドを検出できる状態にした

### 検証

- `npm run typecheck`
- `powershell -ExecutionPolicy Bypass -File skills/tracklog-release-notion/scripts/prepare-tracklog-release.ps1 -Build -SyncAndroid -AssembleDebug -AppBuildDir build-release-v017`
- `adb install -r output\\tracklog-assist-debug.apk`
- `adb shell am start -W -n com.tracklog.assist/.MainActivity`
- `adb shell dumpsys package com.tracklog.assist` で `versionCode=5` / `versionName=0.1.7` を確認
- `adb shell pidof com.tracklog.assist` で起動後プロセス維持を確認
- 直近ログに TrackLog の `FATAL EXCEPTION` / `AndroidRuntime` / `ANR` なし
- 本番 `https://tracklog-assist.pages.dev/version.json` が `version=0.1.7` を返すことを確認
- 本番 `https://tracklog-assist.pages.dev/sw.js` に `tracklog-shell-v2` と `version.json` バイパスが反映済み

### APK

- File: `output/tracklog-assist-debug.apk`
- Version: `versionCode=5` / `versionName=0.1.7`
- SHA-256: `BBBF4EAAC910E3254F2DD190A82FF255A2E999DAFDE79082A385CAEA060189F0`
- Size: `6,023,554 bytes`
- Device install: completed on `SCG34` (`RFCY70L6HTF`) with `adb install -r`

## 2026-05-16 v0.1.6

### 常に最新化する更新導線

- PWA向けにビルドごとの `version.json` を生成し、iPhone PWAが起動中/復帰時/定期チェックで最新ビルドを検出できるようにした
- PWAが新しい `version.json` を検出した場合、同一セッションで1回だけ自動リロードして最新画面へ切り替えるようにした
- Service Workerを `tracklog-shell-v2` に更新し、`version.json` / `sw.js` は常にネットワーク優先、通常リソースもネットワーク優先でキャッシュを更新するようにした
- Androidの更新通知は、GitHub Releaseの公開時刻だけでなく `vX.Y.Z` とアプリ内 `APP_VERSION` のバージョン比較でも判定するようにした
- Cloudflare Pages本番 `https://tracklog-assist.pages.dev` へ v0.1.6 をデプロイ済み
- GitHub Release `v0.1.6` を作成し、`tracklog-assist-debug.apk` を添付済み。`/releases/latest/download/tracklog-assist-debug.apk` は v0.1.6 に解決される

### 検証

- `npm run typecheck`
- `npm run build`
- `dist/version.json` が `version=0.1.6` を返すことを確認
- `powershell -ExecutionPolicy Bypass -File skills/tracklog-release-notion/scripts/prepare-tracklog-release.ps1 -Build -SyncAndroid -AssembleDebug -AppBuildDir build-release-v016`
- `adb install -r output\\tracklog-assist-debug.apk`
- `adb shell am start -W -n com.tracklog.assist/.MainActivity`
- 起動後20秒待機しても `com.tracklog.assist` プロセスが維持されることを確認
- 直近ログに TrackLog の `FATAL EXCEPTION` / `ANR` なし
- 本番 `https://tracklog-assist.pages.dev/version.json` が `0.1.6` を返すことを確認
- 本番 `https://tracklog-assist.pages.dev/sw.js` に `tracklog-shell-v2` と `version.json` バイパスが反映済み
- GitHub latest APKリンクが `https://github.com/Koutacode/tracklog-pwa/releases/download/v0.1.6/tracklog-assist-debug.apk` にリダイレクトされることを確認

### APK

- File: `output/tracklog-assist-debug.apk`
- Version: `versionCode=4` / `versionName=0.1.6`
- SHA-256: `5FCB014CE3A563C06928820B5470BC50A856CAA25DE09DB9A67EA01D514FD14A`
- Device install: completed on `SCG34` (`RFCY70L6HTF`) with `adb install -r`

## 2026-05-16

### Android APK / iPhone PWA 配布方針の整理

- 配布方針を「AndroidはAPK、iPhoneはPWA」に更新
- 設定画面の共有文言を新方針に合わせ、Android APKリンクとiPhone向けPWA共有URLを維持
- `@capacitor/app` に存在しない `openAppSettings()` 呼び出しをやめ、既存の `NativeSetup.openAppSettings()` ラッパー経由に修正
- GitHub Release のAPK添付名を `tracklog-assist-debug.apk` に統一し、Release workflow に `npm run typecheck` を追加
- `package.json` / `package-lock.json` / `android/gradle.properties` を `0.1.5` 系へ更新
- Notion API token 未設定のため、GitHub Actions による Notion 自動同期は使わない運用として文書化

### 検証

- `npm run typecheck`
- `npm run build`
- `npm run cap:sync:android`
- `powershell -ExecutionPolicy Bypass -File skills/tracklog-release-notion/scripts/prepare-tracklog-release.ps1 -Build -SyncAndroid -AssembleDebug -AppBuildDir build-release-v015`
- `adb install -r output\\tracklog-assist-debug.apk`
- `adb shell am start -W -n com.tracklog.assist/.MainActivity`
- Home遷移後20秒待機しても `com.tracklog.assist` プロセスが維持されることを確認
- 直近ログに TrackLog の `FATAL EXCEPTION` / `ANR` なし
- `POST_NOTIFICATIONS` / `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` / `ACCESS_BACKGROUND_LOCATION` は許可済み、`SCHEDULE_EXACT_ALARM` は `allow`
- 電池最適化除外 whitelist に `com.tracklog.assist` を確認

### APK

- File: `output/tracklog-assist-debug.apk`
- Version: `versionCode=3` / `versionName=0.1.5`
- SHA-256: `69AD1CE468EE1C491FDAE162E6FC0170C2A0D73622B1014AB02A1B75F56FC730`
- Device install: completed on `SCG34` (`RFCY70L6HTF`) with `adb install -r`

## 2026-04-25

### PCソース本線化 / 権限診断 / 配布バージョン

- PC上の `src` をビルド元の正として扱う運用に戻し、端末APK抽出物は一時復旧・バックアップ扱いに整理
- Android の `versionCode` / `versionName` を `android/gradle.properties` で管理し、`versionCode=2` / `versionName=0.1.3` へ更新
- `npm run normalize:android-assets` を追加し、OneDrive配下で Capacitor assets が `ReparsePoint` になって Gradle が失敗する問題を回避
- Android ネイティブ権限診断で `ACCESS_BACKGROUND_LOCATION` を個別判定し、前景のみ許可の場合はエラーとして表示
- ネイティブ設定に `権限設定を開く` / `位置情報設定を開く` を追加し、常時位置情報許可へ移動しやすくした
- 進行中運行の日報・Obsidian出力で、運行終了前でも現在時刻までの集計を反映するよう改善

### 検証

- `npm run typecheck`
- `npm run release:prepare`
- `adb install -r output\\tracklog-assist-debug.apk`
- `adb shell pm grant com.tracklog.assist android.permission.ACCESS_BACKGROUND_LOCATION`
- `adb shell am start -W -n com.tracklog.assist/.MainActivity`
- Home遷移後20秒待機しても `com.tracklog.assist` プロセスが維持されることを確認
- 起動後ログに `FATAL EXCEPTION` / `ANR` なし

### APK

- File: `output/tracklog-assist-debug.apk`
- Version: `versionCode=2` / `versionName=0.1.3`
- SHA-256: `B654BA7B0F4A76ACCFD67281B3B05F122359DB3DA7AC7122272A0D6EF2B22E97`
- Device install: completed on `SCG34` (`RFCY70L6HTF`) with `adb install -r`

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
