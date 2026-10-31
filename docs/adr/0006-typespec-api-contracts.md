# HTTP APIの契約をTypeSpecで管理する

2026年10月30日、通常のHTTP APIの契約管理にTypeSpecを正式採用します。実装から独立した契約を先に定義し、OpenAPI・TypeScriptの型・実行時検証コードを同じ原本から生成することで、画面とサーバーの契約を揃えます。面接一覧APIのローカル試作でReact・TanStack Start・Voidまで接続できたことを根拠とし、生成工程と依存互換性の管理が増える負担を引き受けます。

## 検討した選択肢

- OpenAPIを直接記述する：専用言語を増やさずHTTP契約を管理できます。今回はモデルと操作をTypeSpecで記述し、OpenAPIを生成物にする方針を選びます。
- Zodを原本にする：TypeScriptの型と実行時検証をまとめやすい方式です。今回はHTTPの操作・入力・応答を実装から独立して定義する目的からTypeSpecを選びます。
- Server Functionsの型共有を中心にする：Start内の呼び出しを簡潔に扱えますが、独立したHTTP契約を設計の起点にする目的とは異なるため、通常のHTTP APIはServer Routesで実装します。

## 影響

[ADR 0004](0004-tanstack-start-with-void.md)の責務分担は維持します。TypeSpecは契約の原本、TanStack Startは画面とHTTP APIの実装、VoidはCloudflare連携・配置を担います。契約の二重管理を避け、生成後の型検査と実行時検証を組み合わせます。認可・状態遷移・再試行・削除の振る舞いは引き続き実装とテストで保証します。

検証では、型生成用TypeScriptの5系への固定、Cloudflare Viteプラグインの固定、Babelのsemver依存の限定的な置換、検証コードのES Modules出力が必要でした。この保守負担を採用判断に含めます。現行の固定版・更新時の検証条件は[MVP仕様書の依存バージョンの制約](../spec/mvp.md#依存バージョンの制約)を正とし、再現手順と観測した失敗は[ローカル検証記録](../../apps/typespec-spike/README.md)に残します。

採用は本番構成の検証完了を意味しません。試作の履歴API契約も製品仕様としては確定していません。HTTP以外への適用や本番連携など、残る判断・検証は[MVP仕様書の補足事項](../spec/mvp.md#補足事項)で管理します。
