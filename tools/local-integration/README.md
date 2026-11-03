# 3 Workersのローカル接続検証

Web・Interview DO・Evaluationを一つのローカルランタイムで起動します。`fixtures/`のローカル専用入口から、アプリの診断処理と共有ジョブ制御を接続します。HTTP→DO→Queue→Consumer→D1、再試行、DLQ、停止後回復を検査します。Cloudflareへの配置や実AI呼び出しは行いません。

日常の操作と失敗時の調査は[ローカル開発手順](../../docs/runbooks/local-development.md)、固定版・観測結果・未検証事項は[検証記録](../../docs/research/local-worker-integration.md)を参照してください。

## 操作

リポジトリルートで実行します。

| コマンド                   | 操作                                             |
| -------------------------- | ------------------------------------------------ |
| `pnpm dev:local`           | HTTP契約を生成し、開発ランタイムを起動           |
| `pnpm build:local`         | HTTP契約を生成し、3 Workersを環境別にビルド      |
| `pnpm preview:local`       | 同じ環境のビルド済み成果物を起動                 |
| `pnpm db:generate`         | 共有スキーマからマイグレーションSQLを生成        |
| `pnpm db:migrate`          | 同じ環境のローカルD1へ適用                       |
| `pnpm db:reset-seed`       | 停止中の同じ環境のDBを初期化し、固定データを投入 |
| `pnpm prepare:integration` | 開発DBを保持したまま統合検査の確認行を準備       |
| `pnpm test:integration`    | 独立したテスト環境で接続検証                     |

起動時にWebのURLとログの保存先を表示します。停止はCtrl+Cです。起動とmigrationはデータを初期化せず、再起動後も保持します。`db:reset-seed`だけが既存データを消します。起動・ビルド・reset・seedは環境単位で排他し、使用中の環境への初期化を拒否します。操作用ロックはD1とは別のローカルファイルで保持し、プロセス終了で解放します。

通常の操作入口は`APP_ENV=development`を補います。明示する場合は`development`または`test`を指定してください。`test`では`LOCAL_TEST_RUN_ID`と0以上の整数の`LOCAL_TEST_SLOT`が必要です。共通設定は環境の未指定・誤記を拒否し、ローカル操作入口は`production`や追加引数を受け付けません。

## 状態と証拠

開発状態は`.local/development/state`、生成設定・ビルド・ログは`.local/development/artifacts`へ保存します。テストは`.local/tests/<実行ID>/<並列番号>/`配下です。別環境の設定が残る生成先は再利用しません。SQLとスキーマの原本は`packages/database`に置き、DB CLIの作業先だけを環境別に分けています。

テストはWeb→DO、3 WorkersとCLIのD1共有、scheduled、D1 batchのロールバック、primaryセッション指定、並列環境の分離、停止後のデータ保持、ビルド済み成果物での接続を確認します。統合検査は成功時も`results.json`を保持し、状態と生成物を削除します。失敗時はログと状態も残します。ローカル検証では本番のreplica遅延やクラウド認可を再現していません。

`prepare:integration`は開発ランタイムを停止して実行します。その後の`test:integration`はtest環境だけを起動し、開発DBと生成物は読み取り専用で前後を照合します。ローカルQueueの未配送メッセージはランタイム全体の停止をまたいで保持されないため、停止境界ごとの検証方法を検証記録で区別しています。
