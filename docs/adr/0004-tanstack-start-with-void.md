# TanStack Startを土台にし、VoidでCloudflareへ配置する

利用者が希望するReact・shadcn/uiと組み合わせ、画面遷移・データ取得・通常のサーバー処理を統一するため、TanStack Startをアプリの土台にします。以前検討したnative Voidアプリの構成から変更し、VoidはCloudflare連携と配置を担い、音声中継にはカスタムWorkerエントリでCloudflare標準のDOを組み込みます。Void固有の自動化を全面的に使う構成より連携検証が増えることを受け入れます。

## 影響

Reactの画面描画とブラウザ固有の録音・再生処理を分離します。メタフレームワークモードのローカルQueues、DOのバインディングとマイグレーション、DLQ設定、秘密値注入は実動作で確認する必要があります。

この判断は本番での動作検証が完了したことを意味しません。[技術調査](../research/platform-integration.md)に確認済みの資料と検証範囲を記録します。

## 2026年10月30日のHTTP API契約管理の追加

[ADR 0006](0006-typespec-api-contracts.md)でTypeSpecを正式採用しました。通常のHTTP APIは生成した契約に沿ってStartのServer Routesで実装します。画面・サーバー処理をStart、Cloudflare連携・配置をVoidに置く判断は変えません。面接一覧APIのローカル連携では固定版の組み合わせが成立しましたが、DO・Queuesなどを含む本番構成全体は未検証です。現在の制約は[MVP仕様書](../spec/mvp.md#依存バージョンの制約)を参照してください。
