# Android自家用インストール手順（Capacitorラップ）

ブラウザPWAをネイティブラッパー化して、自分用にAPKをサイドロードする手順です。Google Play登録は不要です。

## 0. 事前準備
- PC: Node.js 18+、Android Studio（SDK/エミュレータ付き）をインストール
- リポジトリを最新に取得（`git pull`）
- 依存をインストール:
  ```bash
  npm install
  ```

## 1. ビルドとCapacitor同期
```bash
npm run build              # dist を生成
npm run cap:sync           # capacitor.config.ts を元にプラットフォームへ反映
```

## 2. Android プラットフォーム追加（初回だけ）
```bash
npm run cap:add:android
```

## 3. Android Studioで開く
```bash
npm run cap:open:android
```
Android Studio が開くので、`app` モジュールを選択してビルド/インストール。

### サイドロード（自分用）
- デバッグビルドでも構いません。`Run` ボタンでデバイスへインストール。
- 端末で「提供元不明のアプリを許可」をオンにする必要があります。
- 再インストール時は同じ署名キーが必要です。自分用ならデフォルトのデバッグキーでもOK、長期運用するなら `app/release.keystore` を作って署名設定してください。

## 4. 背景位置情報を使う場合（任意）
PWA単体ではバックグラウンド動作が制限されるため、ネイティブ側で前景サービス＋通知を使う必要があります。
1) 前景サービス対応の背景位置プラグインを追加（例）
   ```bash
   npm install capacitor-background-geolocation
   ```
   ※ 実際に使うプラグインに合わせて修正してください。
2) Android Studio で `AndroidManifest.xml` に以下を追加（権限/前景サービス/通知チャネル）。  
   - `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` / `ACCESS_BACKGROUND_LOCATION`  
   - `FOREGROUND_SERVICE_LOCATION`
3) アプリ起動時に権限リクエストと前景サービス起動コードを呼ぶ（プラグインのREADMEに従う）。
4) 端末側で「常に許可」「電池最適化から除外」をユーザーに案内する。

## 5. アイコン・アプリID
- 現在の `appId`: `com.tracklog.pwa`
- 変更する場合は `capacitor.config.ts` の `appId` を編集し、`npm run cap:sync` を再実行。
- アイコンは `android/app/src/main/res/mipmap-*` に配置。Capacitorの公式ドキュメントの Asset Generator を使うと便利です。

## 6. トラブルシュート
- `npm run build` が失敗する → NodeがPATHにあるか確認。`node -v` で 18+ を確認。
- `cap:sync` でプラットフォームがないと言われる → 先に `npm run cap:add:android`。
- 住所が出ない → ネット接続後にアプリ再起動。バックフィルが動けば詳細住所が埋まります。
