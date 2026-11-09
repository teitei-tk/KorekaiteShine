# Webのローカル検証

`/practice` で経験Markdownを確認してテーマを選び、音声面接と五軸評価の振り返りを行います。履歴には本人の記録を表示し、評価の引用から原文を参照できます。ローカルWorkerとモックAIを通す検査、マイク操作をモックにした画面検査を用意しています。実AIでの試行手順は[ローカル開発手順](../../docs/runbooks/local-development.md#経験markdownで音声面接を試す)を参照してください。

`/` は架空の一覧を使う既存試作の入口で、`/practice` へのリンクがあります。`/diagnostics` は開発用の接続・障害検証に使います。HTTPの契約は `packages/api-contracts/http/main.tsp` から生成します。

## 起動と検査

リポジトリルートで実行します。Node.js・pnpmはルートの固定版を使います。

3 Workersと診断画面の起動には[ローカル開発手順](../../docs/runbooks/local-development.md)の`pnpm dev:local`を使います。以下は一覧画面だけを検査する入口です。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir apps/web dev
```

開発画面は`http://127.0.0.1:4327`です。別のターミナルから実HTTPを確認できます。

```sh
pnpm --dir apps/web verify:http
```

ビルド済みWorkerは次の手順で`http://127.0.0.1:4328`に起動します。

```sh
pnpm --dir apps/web build
pnpm --dir apps/web preview
```

```sh
pnpm --dir apps/web verify:http http://127.0.0.1:4328
```

一覧APIの入力境界と応答契約は既存試作から保持しています。`limit`の不正表記・重複・未知キーなど28ケースを、単体テストと実HTTPで共用します。ブラウザでは日時降順の2件と「再取得」を確認します。

`dev / build`は共有契約を事前生成します。通常のテストはルートの`pnpm test`を使い、共有契約を依存順に一度生成してから各パッケージを検査します。単独の`test`実行前には`pnpm --dir apps/web generate`が必要です。`typecheck`はルート型生成のためビルド後に型検査します。APIの型生成だけTypeScript 5.9.3、アプリの型検査は7.0.2を使用します。生成物は編集せず、Gitにも含めません。

## 移行時の確認

2026年11月2日、Void 1.4.0で開発・ビルド済みWorkerそれぞれのHTTP契約28ケース、一覧順序、HTML応答を確認しました。ブラウザでも両方の一覧2件と再取得を確認しました。favicon未配置による404が残っています。全体の進行は[実装計画](../../docs/superpowers/plans/2026-11-02-local-worker-skeleton.md)を参照してください。

互換性の制約、回帰ケースの移管先、診断機能の確認範囲は[検証記録](../../docs/research/local-worker-integration.md)にまとめています。

## 移行元の依存更新履歴

移行元の試作では2026年11月4日、Void 1.5.0への更新に合わせてCloudflare Viteプラグインを、Voidが要求する2.0.0-beta.v.9へ固定し直しました。旧1.64.0固定ではBuild Outputの`config.json`が生成されずビルドが失敗しました。更新後は契約生成・ビルド・型検査、開発サーバーとビルド済みWorkerそれぞれのHTTP契約28件、ブラウザでの一覧2件表示・再取得を確認しました。開発とプレビューを同時に起動するとローカルSQLiteのロックが競合するため、検証は片方を終了してからもう片方を起動します。新しいビルド出力の`.cloudflare/`もGit管理から除外します。

## テストの配置

通常の検証はリポジトリルートの`pnpm test`、型・Lint・整形・文書を含む検証は`pnpm check`を使います。

| 対象                                 | テスト                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 一覧の表示・再取得・古い応答の無視   | [interviews-page.test.tsx](tests/interviews-page.test.tsx)                                             |
| 診断の開始・再送・連打防止・状態取得 | [diagnostics-page-interactions.test.tsx](tests/diagnostics-page-interactions.test.tsx)                 |
| 診断画面のSSR初期状態・結果表示      | [diagnostics-page.test.ts](tests/diagnostics-page.test.ts)                                             |
| HTTPクライアントの応答検証           | [client.test.ts](tests/client.test.ts)、[diagnostics-client.test.ts](tests/diagnostics-client.test.ts) |
| 入力エラーの分類・JSON Pointer整形   | [diagnostics-errors.test.ts](tests/diagnostics-errors.test.ts)                                         |

画面テストはReact Testing Libraryで本物のコンポーネントを操作し、fetch境界で応答を制御します。HTTPクライアントと生成validatorも実装本体を使います。DOMを必要とするファイルだけjsdomで動かし、既存HTTPテストのNode環境を維持します。[DOM補助](tests/helpers/dom.ts)で各ケース後に画面と差し替えを片付けます。

追加した開発依存はReact Testing Library 16.3.3、user-event 14.6.8、DOM Testing Library 10.4.2、jsdom 30.1.3です。DOM Testing LibraryはReact Testing Libraryのpeer依存です。固定版のNode.js 26.12.1・React 19.3.1・Vitest 5.0.5に合わせ、操作と応答順序を実ブラウザ起動なしで再現するために選びました。実ブラウザ全体のE2Eへケースを増やす方法より起動・応答制御の負担が少ない一方、DOM用の依存が増えます。CSS・実ブラウザ固有の挙動・クラウドの動作はこの検査だけでは確認できません。
