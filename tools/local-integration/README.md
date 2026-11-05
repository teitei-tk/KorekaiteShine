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

## テストの配置

`pnpm test`はD1・DOの境界を含む通常検査、`pnpm test:integration`は実時間の配送・停止後回復・環境分離の検査です。実時間の統合検査は15ケースです。HTTP契約2件は通常検査だけで実行します。

- [通知配送](tests/dispatch-notifications.test.ts)：ローカルD1と本物の配送処理で時刻境界と部分失敗を確認します。送信関数はtest専用probeで差し替えるため、実Queue配送の証拠とは区別します。
- [DO入口](tests/check-object-guards.test.ts)：本物の初期化処理とDO storageで、不正UUID・別ジョブ・許可外環境の拒否と副作用を確認します。禁止環境は対象DOへの値だけを差し替え、リソースは独立test環境のままです。
- Interviewの既存の保存・通知・停止回復は[check-object.test.ts](tests/check-object.test.ts)にあります。アプリ配下に空のtestスクリプトは追加していません。
- 純粋な再試行・実行制御は[Evaluationのテスト](../../apps/evaluation/README.md)、画面操作は[Webのテスト](../../apps/web/README.md)で確認します。

test専用probeは`fixtures/`に置き、本番成果物への非包含を既存検査で確認します。クラウドD1や実AIの資格情報は使いません。

契約Schemaの参照抽出は[reachable-schema.test.ts](../../packages/api-contracts/tests/reachable-schema.test.ts)で、循環・欠落・外部URL・エスケープ・入力保持を確認します。

## テスト追加時の検証記録

2026年11月4日、[不足テストの追加計画](../../docs/superpowers/plans/2026-11-03-application-test-gaps.md)に沿って65ケースを追加し、既存の実行制御6ケースをEvaluationへ移しました。`pnpm check`で通常511件と文書65件、`pnpm test:integration`で17件が成功しました。本番成果物の診断除外検査、開発DBの保持確認行と10テーブルの件数・内容ハッシュの前後一致も確認しました。

追加テストでアプリの動作修正を要する不具合は再現しませんでした。アプリ本体の変更は一覧コンポーネントの名前付きexportのみです。検査途中には既存DLQテストの起動タイムアウトが2回、既存の同時配送テストでローカルD1のsession commit token内部エラーが1回発生しました。対象ケースと全体検査はコード変更なしの再実行で成功しています。発生原因は未確定であり、修正済みとは扱いません。

画面操作の追加検査はjsdomで実行しました。CSS・実ブラウザ固有の挙動・実AI・クラウドD1の動作、およびカバレッジ100%は今回の検証範囲に含みません。

## 境界検査と実時間の結合検査

HTTP契約（開発・ビルド済みWorker）は通常の`pnpm test`に含め、`pnpm test:integration`では重複実行しません。全体を検査する場合は`pnpm check`に加え、`pnpm prepare:integration`と`pnpm test:integration`を実行します。通常CIでは境界4分割と短い結合3分割を別runnerで並列実行します。長時間の再試行1件は独立した `Worker real-time checks` へ分離します。

通知時刻の境界8ケースは、ファイルごとの独立した環境を1回起動して直列実行します。各ケースが発行したジョブIDを追跡し、正常終了時にそのoutboxとジョブだけを削除します。失敗・タイムアウト後は後続ケースを拒否し、Workerを停止してDBとログを残します。全ケースが成功した環境だけを削除します。再起動・DO保存・実Queue配送を検証する他のテストは個別環境を使います。

## 通常CIと長時間検査の使い分け

`pnpm test:integration:pr` は通常PR向けの結合14件、`pnpm test:realtime` は実時間30・120・300秒の再試行と実DLQ受信1件を実行します。`pnpm test:integration` は両方を含む15件を維持します。結合検査の前には `pnpm prepare:integration` を実行してください。通常の `pnpm test` は時計を制御した再試行境界も含みます。

長時間ワークフローは毎日03:17 JST、手動実行、関連変更のPRで動きます。定期実行はmainを対象とし、GitHub側の都合で遅延する場合があります。手動実行ではGitHub Actionsの `Worker real-time checks` からrefを選びます。新規ワークフローをmainへ取り込むまでは定期・手動の起動を確認できません。

文書だけの変更は対象外です。コード・依存・設定の変更、削除・移動、変更一覧の取得不能は実行対象にします。`Realtime result` で対象外・成功・失敗・中断を確認できます。通常CIの成功だけで長時間検査も成功したとは扱いません。関連変更は長時間検査の成功を確認してから取り込み、失敗時は実行ログの原因を解消します。必須チェックのリポジトリ設定は自動変更しません。

テストの所属は `tools/local-integration/src/test-suites.ts` に集約しています。新規・削除・移動したテストを登録し忘れた場合は起動前に失敗します。分割番号は境界1〜4、通常結合1〜3です。ローカルで特定分割を再現する場合は、例えば `pnpm --dir tools/local-integration test 1 --maxWorkers=2` を使います。
