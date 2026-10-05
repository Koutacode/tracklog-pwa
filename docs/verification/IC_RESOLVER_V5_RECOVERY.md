# IC resolver v5 ソース回収・検証

2026-10-06 JST。基点 main: 612a4ff88c72b753cf82790d274e16d82a6bcd98。

## 保存した変更

デプロイ済み tracklog-ic-resolver v5（ACTIVE / verify_jwt=true）の3ファイルを読戻し、resolver.tsだけがmainと異なることを確認。回収したソースは変更せず保存。個別10秒・全体28秒の上限、既定1巡、406/429等のcooldown、Retry-After、非秘密の固定エラーを含む。index.ts/name-search.tsはmainと同一。再読取でもv5の3ファイルに変化なし。

旧ローカルcommitはこの環境に存在せず、指定SHAをGitHub APIで読む試行も422。通常メールの孤立commitのSHAは不明で、その範囲の確認はできていない。既存履歴を変更せず、新規noreply commitとして保存する。

## 検証

- Node22、npm ci、typecheck、test:logic、test:sync（24件）、CSP、Web build、offline（38資産）成功。
- resolver 20件：旧4.5秒を超える応答、総時間制限、停止中endpointの再試行抑止、406/429とRetry-After、body stall、診断秘匿、候補安全条件。
- 合成IndexedDB/transportで推定名pendingのdownload、再試行許可、guard付き正式名置換、時刻/住所/他項目保持を確認。既存日報の確定名へpending推定を投影しない境界も確認。
- Capacitor sync、Android単体112件（失敗0）、本体/debugAndroidTestコンパイル成功。実機操作なし。
- デプロイ済みソースをローカル実行し公開IC名称のみで照会した小規模試験は、約5秒・既定3宛先すべてnetwork request failed。ユーザー座標の取得/送信なし。本番Edge認証経路の成功を示す試験ではない。
- v5反映後の限定時間窓でfunctionログの取得結果なし。これを本番成功または失敗の証拠にしない。

## データ・同期の確認範囲

対象6件は開始時点ですでに推定名/複数推定候補と出典が保存されていた。再読取でrevision/change_seq/名前/statusが同じ。二重UPDATEはせず、実データは変更しなかった。元作業の変更前状態がないため、その作業による時刻・住所・距離保持を遡って断定しない。

trip_eventsの同期採番/日報無効化triggerが存在。対象のクラウド保存日報は0件。現在の画面はextras.icNameを読む。pendingの推定は再試行対象であり、成功時は自動取得名へ置換される。icNameEstimateは履歴として残るのでdisplayNameとの一致を確認して解釈する。端末が同期したことや表示完了をDB保存から推定しない。

住所からの候補には利用IC・方向の確定力はない。地域対応の強い候補と複数候補を区別し、確定手動名フラグやresolvedには変更していない。非公開レコードID・住所・座標・生データはこの公開記録に含めない。

## 未完了・次の確認

本人の既存認証セッション/承認済み端末経路をこのCloudへ持ち込まず、新規認証もしないため、本番Edgeの認証付き呼出と実機表示は未検証。端末の通常同期・再試行後に対象ICメタデータだけを再確認する。外部取得が引き続き失敗する場合はv5の固定エラーを使い調査する。

ドラフトPRまで。マージ、追加デプロイ、タグ、正式APK公開なし。Google Drive既存月次ログには最終PR/CI結果を追記する。
