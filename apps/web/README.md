# Webのローカル検証

既存試作の一覧画面とAPIを移行したWebアプリです。一覧は架空の2件を使う暫定契約です。診断機能ではWebからDO・Queue・評価Consumer・ローカルD1への接続を確認できます。正式な履歴仕様、認可、音声、実AIは後続範囲です。契約の原本は`packages/api-contracts/http/main.tsp`に集約し、型と検証コードを生成して使用します。

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
