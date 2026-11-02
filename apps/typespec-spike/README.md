# TypeSpecとTanStack Start・Voidのローカル連携検証

2026年10月30日、架空の面接2件を返すAPIで、TypeSpecからReact画面までの連携を検証しました。開発サーバーとビルド済みWorkerの両方でHTTP通信が成立しました。採用判断用の試作であり、本番アプリの実装ではありません。

## 検証した構成

[TypeSpec定義](main.tsp)を原本にOpenAPI 3.1、TypeScriptのAPI型、Ajvの検証コードを生成します。Reactはopenapi-fetchでAPIを呼び、応答を検証してから表示します。TanStack StartのServer RoutesがAPIを提供し、VoidがCloudflare Viteプラグインを組み込みます。実行環境はローカルのworkerdです。

`GET /api/interviews`は日時の降順で一覧を返します。任意の`limit`はASCII数字だけで表す1〜20の十進整数で、省略時は最大20件です。範囲外・小数・空文字・文字列・重複指定は400になります。2026年10月31日のレビュー対応で、数値化前の表記検査を追加し、指数・基数接頭辞・符号・空白付き表記も拒否します。未定義のクエリも拒否します。日時・テーマ・材料種別・時間・評価状態だけを扱う検証用の契約であり、ページングや完了後の点数を含む正式な履歴APIの設計は未確定です。

DB、Accessによる認可、DO、Queues、外部AI、クラウドへの配置は検証していません。認証のない架空データ専用の試作のため、実データを入れず、ローカルで使用してください。

## 再実行

Node.js 26.12.1、pnpm 12.15.0を使用します。以下はリポジトリルートで実行します。インストール時の保護設定は維持し、依存のインストールスクリプトは実行しません。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir apps/typespec-spike dev
```

開発画面は `http://127.0.0.1:4317` です。別のターミナルでHTTP検証を実行できます。

```sh
pnpm --dir apps/typespec-spike verify:http
```

ビルド済みWorkerを確認する場合は次を実行します。

```sh
pnpm --dir apps/typespec-spike build
pnpm --dir apps/typespec-spike preview
```

画面は `http://127.0.0.1:4318` です。別のターミナルでHTTP検証を実行します。

```sh
pnpm --dir apps/typespec-spike verify:http http://127.0.0.1:4318
```

ブラウザでは面接2件が表示されることと、「再取得」で再び表示されることを確認します。画面の一覧取得はブラウザ側で行います。サーバーは初期HTMLを返しますが、一覧データのSSR取得や認証情報の転送は検証していません。

`dev`、`build`、`test`は契約を事前生成します。起動中にTypeSpecを変更した場合は、別のターミナルで次を実行してください。生成物は編集せず、Gitにも含めません。

```sh
pnpm --dir apps/typespec-spike generate
```

ルートの`pnpm check`で全体の検査を実行します。この試作の`typecheck`は、ルート型を生成するビルドを先に実行するため、クリーンなcheckoutでも実行できます。ローカルソケットを禁止するサンドボックス内では既存テストが失敗するため、ローカル通信を許可した環境で検査します。

CIでも試作の`typecheck`と`test`を実行し、契約生成・ビルド・型検査・200/400応答の契約検証を行います。400応答の契約だけを変更した場合に、実装との不一致でテストが失敗することも確認しています。実HTTP通信とブラウザ表示の検証は上記のローカル手順で行います。

## APIを追加・変更するときの契約テスト

[面接一覧の共通ケース](tests/contracts/interviews.ts)をひな形に、APIごとの入力ケースと応答検証を用意します。[ハンドラーのテスト](tests/interviews.test.ts)と[HTTP検証](scripts/verify-http.ts)は同じケースを実行し、ステータス・JSONのContent-Type・生成バリデーターによる本文の検証を行います。成功時の件数など、業務上の期待値は契約や実装から計算せず明記します。

- クエリは変換前の文字列で保持します。省略・上下限の成功例に加え、範囲外・空文字・重複・未定義のキー・指数・基数・小数・符号・空白・非ASCII数字を確認します。URLエンコード、二重エンコード、`+`による空白も区別します。
- エラー入力でもステータスだけで終わらず、すべての応答本文を生成した契約に照合します。手書きの応答スキーマは追加しません。
- OpenAPIの応答ステータスと、バリデーターおよび実行ケースのステータスを照合します。新しい応答を定義したら、その応答を実際に返すケースと検証コードを追加します。現在の照合対象は面接一覧APIです。新しいAPIにも同じ照合テストを設けます。

通常のテストはルートの`pnpm test`、実HTTP検証は前述の`verify:http`で実行します。今回、入力の表記検査を外す変更とエラーコードを契約外にする変更を一時的に加え、失敗を検出してから実装を復元しました。応答ステータスの網羅は各エラー分岐の網羅を保証しないため、同じステータスでも異なる入力ケースを残します。

## 確認結果と互換性の制約

| 項目         | 確認内容                                           |
| ------------ | -------------------------------------------------- |
| 契約生成     | TypeSpecからOpenAPI・API型・検証コードを生成       |
| API          | 一覧・件数制限・共通の契約ケースを実HTTP通信で検査 |
| 実行時検証   | 必須項目が欠けた応答をクライアントで拒否           |
| React        | ブラウザで一覧2件と再取得を確認                    |
| 配置用成果物 | Voidを含むViteビルドでclientとWorkerを生成         |

検証時の主な固定版はTypeSpec 1.17.0、React 19.3.1、TanStack Start 1.169.4、Void 1.3.0、Vite 8.3.5、openapi-typescript 7.13.0です。詳細は[package.json](package.json)と[共有ロックファイル](../../pnpm-lock.yaml)を参照してください。

次の調整が必要でした。

- openapi-typescriptはTypeScript 5系のCompiler APIを使います。既存の7.0.2では型生成に失敗したため、この試作だけ5.9.3に固定しました。既存の文書・レビュー用ツールは7系を維持します。
- Cloudflare Viteプラグイン1.66.0では開発時に`Parent environment not initialized`が発生しました。Voidの依存範囲内の1.64.0に固定した構成では起動しました。原因となる上流の変更までは特定していません。
- 生成したCommonJS形式の検証コードはビルド後には動作しましたが、開発時は`exports is not defined`で失敗しました。AjvのES Modules出力へ変更し、両方で使用します。実行時にスキーマをコンパイルしません。
- Babel経由のsemver 6.3.1はpnpmの信頼ポリシーに拒否されました。Babelのcoreとhelper-compilation-targetsに限り、provenanceのある7.8.5へ置換しています。使用する比較・範囲判定APIを確認し、この構成のビルドで検証しました。メジャーをまたぐ置換のため、Babelの全機能の互換性を保証するものではありません。

依存固定は[ワークスペース設定](../../pnpm-workspace.yaml)にあります。TypeSpec自体の実行時依存はありませんが、生成ツールとフレームワークのバージョン調整が必要です。この結果だけでDO・Queues・認可を含む本番構成の互換性を保証しません。

## 参照した公式資料

- [TypeSpec OpenAPI emitter](https://typespec.io/docs/emitters/openapi3/reference/)
- [TanStack Start Server Routes](https://tanstack.com/start/latest/docs/framework/react/guide/server-routes)
- [VoidのTanStack Start連携](https://void.cloud/integrations/frameworks/tanstack-start)
- [openapi-fetch](https://openapi-ts.dev/openapi-fetch/)

今回の試作は[ADR 0004](../../docs/adr/0004-tanstack-start-with-void.md)の責務分担を維持します。この結果を踏まえ、2026年10月30日に[ADR 0006](../../docs/adr/0006-typespec-api-contracts.md)でTypeSpecを正式採用しました。試作の履歴API契約は製品仕様として未確定です。現在の採用範囲・依存制約・未確定事項は[MVP仕様書](../../docs/spec/mvp.md#http-apiの契約管理)を参照してください。
