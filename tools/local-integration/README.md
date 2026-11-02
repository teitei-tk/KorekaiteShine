# 3 Workersのローカル接続検証

Web・Interview DO・Evaluationを一つのローカルランタイムで起動します。現在の接続入口は`fixtures/`の検証専用コードです。診断ジョブのQueue配送・再試行・DLQの実装完了を意味しません。Cloudflareへの配置や実API呼び出しは行いません。

## 操作

リポジトリルートで実行します。

| コマンド                | 操作                                        |
| ----------------------- | ------------------------------------------- |
| `pnpm dev:local`        | HTTP契約を生成し、開発ランタイムを起動      |
| `pnpm build:local`      | HTTP契約を生成し、3 Workersを環境別にビルド |
| `pnpm preview:local`    | 同じ環境のビルド済み成果物を起動            |
| `pnpm db:generate`      | 共有スキーマからマイグレーションSQLを生成   |
| `pnpm db:migrate`       | 同じ環境のローカルD1へ適用                  |
| `pnpm test:integration` | 独立したテスト環境で接続検証                |

起動時にWebのURLとログの保存先を表示します。停止はCtrl+Cです。起動とmigrationはデータを初期化せず、再起動後も保持します。固定データのreset・seed入口はまだ未実装です。

通常の操作入口は`APP_ENV=development`を補います。明示する場合は`development`または`test`を指定してください。`test`では`LOCAL_TEST_RUN_ID`と0以上の整数の`LOCAL_TEST_SLOT`が必要です。共通設定は環境の未指定・誤記を拒否し、ローカル操作入口は`production`や追加引数を受け付けません。

## 状態と証拠

開発状態は`.local/development/state`、生成設定・ビルド・ログは`.local/development/artifacts`へ保存します。テストは`.local/tests/<実行ID>/<並列番号>/`配下です。別環境の設定が残る生成先は再利用しません。SQLとスキーマの原本は`packages/database`に置き、DB CLIの作業先だけを環境別に分けています。

テストはWeb→DO、3 WorkersとCLIのD1共有、scheduled、D1 batchのロールバック、primaryセッション指定、開発・テスト同時起動、停止後のデータ保持、ビルド済み成果物での接続を確認します。成功したテストの作業先は削除し、失敗時はログと状態を残します。ローカル検証では本番のreplica遅延やクラウド認可を再現していません。
