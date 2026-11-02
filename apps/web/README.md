# Webのローカル検証

既存試作の一覧画面とAPIを移行したWebアプリです。架空の2件を使い、一覧の正式な履歴仕様、認可、音声、D1・DO・Queue連携はまだ含みません。契約の原本は`packages/api-contracts/http/main.tsp`に集約し、型と検証コードを生成して使用します。

## 起動と検査

リポジトリルートで実行します。Node.js・pnpmはルートの固定版を使います。

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

旧試作は全接続検証と検証履歴の移管が終わるまで残しています。現行の一覧APIも暫定契約です。
