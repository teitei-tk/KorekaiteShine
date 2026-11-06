# HTTP APIの契約をTypeSpecで管理する

2026年10月30日、通常のHTTP APIの契約管理にTypeSpecを正式採用します。実装から独立した契約を先に定義し、OpenAPI・TypeScriptの型・実行時検証コードを同じ原本から生成することで、画面とサーバーの契約を揃えます。面接一覧APIのローカル試作でReact・TanStack Start・Voidまで接続できたことを根拠とし、生成工程と依存互換性の管理が増える負担を引き受けます。

## 検討した選択肢

- OpenAPIを直接記述する：専用言語を増やさずHTTP契約を管理できます。今回はモデルと操作をTypeSpecで記述し、OpenAPIを生成物にする方針を選びます。
- Zodを原本にする：TypeScriptの型と実行時検証をまとめやすい方式です。今回はHTTPの操作・入力・応答を実装から独立して定義する目的からTypeSpecを選びます。
- Server Functionsの型共有を中心にする：Start内の呼び出しを簡潔に扱えますが、独立したHTTP契約を設計の起点にする目的とは異なるため、通常のHTTP APIはServer Routesで実装します。

## 影響

[ADR 0004](0004-tanstack-start-with-void.md)の責務分担は維持します。TypeSpecは契約の原本、TanStack Startは画面とHTTP APIの実装、VoidはCloudflare連携・配置を担います。契約の二重管理を避け、生成後の型検査と実行時検証を組み合わせます。認可・状態遷移・再試行・削除の振る舞いは引き続き実装とテストで保証します。

検証では、型生成用TypeScriptの5系への固定、Cloudflare Viteプラグインの固定、Babelのsemver依存の限定的な置換、検証コードのES Modules出力が必要でした。この保守負担を採用判断に含めます。現行の固定版・更新時の検証条件は[MVP仕様書の依存バージョンの制約](../spec/mvp.md#依存バージョンの制約)を正とし、再現手順と観測した失敗は[ローカル検証記録](../research/local-worker-integration.md)に残します。

採用は本番構成の検証完了を意味しません。試作の履歴API契約も製品仕様としては確定していません。HTTP以外への適用や本番連携など、残る判断・検証は[MVP仕様書の補足事項](../spec/mvp.md#補足事項)で管理します。

## 2026年11月6日：型とHTTPクライアントをHey APIで生成する

利用者の希望により、openapi-typescriptとopenapi-fetchから@hey-api/openapi-tsへ移行します。開発停止とは断定せず、今後の生成基盤を見直す判断として扱います。TypeSpecを原本とする方針とAjvによる実行時検証は維持し、名前付きモデル・操作ごとの入力と応答・Fetch SDKを生成します。

既存構成の維持は変更量が少なく、OrvalもFetchクライアントを生成できます。今回は型とSDKを同じ生成設定で管理できるHey APIを選択しました。従来のcomponents・operations型への参照と検証コードの型宣言を置き換える負担を引き受けます。HTTP失敗、入力エラーの詳細、冪等キーの再利用、通信例外の伝播を維持します。

[診断機能を本番から除外する方針](0011-access-and-diagnostics-isolation.md)に従い、通常API用SDKは診断操作を除いて別ディレクトリへ生成します。ツリーシェイキングだけでは同じ生成ファイルの診断コードがソースマップに残るため、生成時点で分離します。

公開版0.99.0はTypeScript 7のCompiler APIに未対応です。生成専用パッケージをTypeScript 6.0.3へ固定し、アプリは7.0.2を維持します。独自pnpmフックは削除できますが、コンパイラの版を分ける保守負担は残ります。更新時は公開版の型生成・型検査・既存のHTTP契約テストを再確認します。

出典：[Hey APIの型生成](https://heyapi.dev/docs/openapi/typescript/plugins/typescript)、[Fetchクライアント](https://heyapi.dev/docs/openapi/typescript/clients/fetch)、[OrvalのFetch生成](https://orval.dev/docs/guides/fetch/)。公開版での観測結果は[検証記録](../research/local-worker-integration.md)を参照してください。
