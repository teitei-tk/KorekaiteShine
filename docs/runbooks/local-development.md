# ローカル開発と接続検査

開発者がWeb・Interview DO・Evaluationの接続を確認するための手順です。リポジトリルートで、固定版のNode.jsとpnpmを使います。診断やモックを使う検査は、トークンや1Passwordの設定なしで実行できます。ここでいうローカルD1は、MiniflareがSQLiteで動かすD1です。

## 起動と停止

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm dev:local
```

表示されたWebのURLを開きます。一覧は架空の2件です。`/diagnostics`では診断ジョブを開始し、DO保存・Consumer完了・DLQ受信を個別に確認できます。停止はCtrl+Cです。通常起動と停止で開発データは消えません。`dev:local`と`preview:local`は起動中に60秒周期で定期回復を実行します。再起動後もD1に残る回復対象を確認します。周期処理が失敗した場合は端末へ表示し、次の周期で再試行します。

Webソースは環境別の生成先へコピーして起動します。元のWebソースを編集した場合は再起動してください。再起動・再ビルドでは削除や改名も反映し、D1の状態は保持します。ビルド済みWorkerへ変更を反映する場合は、再ビルドしてから起動します。

ビルド済みWorkerを確認するときは、開発ランタイムを停止してから実行します。

```sh
pnpm build:local
pnpm preview:local
```

操作入口は`APP_ENV`省略時に`development`を選びます。`test`を明示する場合は、一意な`LOCAL_TEST_RUN_ID`と0以上の整数の`LOCAL_TEST_SLOT`が必要です。`production`と追加引数は拒否します。

## 経験Markdownで音声面接を試す

`/practice` は、Markdownの内容確認、テーマ選択、音声面接、評価結果の閲覧に使います。実AIで練習する場合は、1PasswordのDeveloper Environmentに次の変数を用意します。

| 変数名             | 用途                                      |
| ------------------ | ----------------------------------------- |
| `OPENAI_API_KEY`   | 材料分析・音声・評価に使うAPIキー         |
| `MATERIAL_MODEL`   | テーマ抽出に使うResponses対応モデル       |
| `RESPONSES_MODEL`  | 音声面接中の推論に使うResponses対応モデル |
| `EVALUATION_MODEL` | 面接終了時に固定する評価モデル            |
| `LIVE_VOICE`       | 任意の音声指定。省略時は `marin`          |

リポジトリルートで契約を生成し、1Password CLIで開発サーバーを起動します。`INTERVIEW_1PASSWORD_ENV_ID` には使用するEnvironmentのIDを指定します。

```sh
pnpm --filter @korekaite/api-contracts generate
op run --environment "$INTERVIEW_1PASSWORD_ENV_ID" -- node tools/local-integration/src/run.ts dev
```

開発用の面接画面は `http://127.0.0.1:63286/practice` です。再起動後も同じURLを使います。面接画面を開き、経験Markdownを選んで送信内容を確認します。候補から今回話すテーマを選び、「面接を準備する」を押します。「マイクを許可して開始」で音声接続が始まり、「終了して評価する」で保存済みの回答が評価に渡ります。履歴から同じ面接を開くと評価と引用元を読み返せます。

自動検査では架空のキーを3 Workersへ渡し、生成設定・ログ・開発用ビルド成果物に値が含まれないことを確認しています。実機のマイク、モデルの利用権限、日本語の音声品質は実接続で確認する項目です。

日本時間の1日につき、分析10回・音声60分・新規評価10回までです。1回の面接時間は最大20分です。音声枠は接続が成立して「面接中」だった時間を数えます。一時停止・切断・終了で計測を止め、日本時間の日付をまたいだ区間は日ごとに集計します。実際の料金は各モデルの利用状況によって変わります。

## DBの変更

スキーマの原本は`packages/database`です。生成したSQLをレビューしてから適用します。

```sh
pnpm db:generate
pnpm db:migrate
```

起動時にも同じマイグレーションを適用します。既存データを消して固定データから始める場合だけ、ランタイムを停止して次を実行します。

```sh
pnpm db:reset-seed
```

起動・ビルド・DB操作は環境単位で排他します。使用中というエラーが出た場合は、その環境の操作が終了したことを確認してください。

## 診断シナリオと自動検査

| シナリオ             | 期待する結果                                         |
| -------------------- | ---------------------------------------------------- |
| `success`            | 1回で成功。DO保存・Consumer完了を確認                |
| `retry_then_success` | 30秒以上待ち、2回目で成功                            |
| `exhaust_retries`    | 30・120・300秒以上の間隔で全4回失敗し、DLQ受信を確認 |

応答を受け取れなかった場合の再送は、同じ冪等キーと要求内容を使います。新しい検査を始める操作とは区別します。HTTPエラーと、受付済みジョブの評価失敗も別の表示です。

通常検査と実時間の長い統合検査は入口を分けています。

```sh
pnpm check
pnpm prepare:integration
pnpm test:integration
```

`prepare:integration`は開発ランタイムを停止して実行します。開発DBをリセットせず、マイグレーションと固定の保持確認行・出力を準備します。既存の確認値が異なる場合は上書きせず失敗します。

`test:integration`は独立したtest環境だけを起動・準備・破棄します。開発DBは読み取り専用で検査し、10テーブルの件数・内容のハッシュと開発生成物が変わらないことを確認します。このSQLite読み取りは保持確認用であり、WorkerからD1への接続検査は別途実際のバインディングで行います。

全体検査ではHTTP契約、診断3シナリオ、停止境界と再起動、通常Queue・DLQ、並列環境の分離を確認します。実時間の待機を短縮しないため、数分以上かかります。定期回復はローカルランタイムのscheduled入口を60秒周期で駆動します。

## 結果と失敗時の確認先

開発状態は`.local/development/state`、生成設定・ビルド・ログは`.local/development/artifacts`にあります。テストは`.local/tests/{実行ID}/{並列番号}/`に分離します。

各統合検査の`results.json`には固定版、期待値、実測値、終了コードを記録します。成功時はテストの状態・生成物を削除して結果を残し、失敗時は状態・ログも保持します。まず終了コードと失敗したケースを確認し、同じ保存先の`artifacts/runtime.log`やDB・ビルドのログを調べてください。秘密値や実データを検証入力へ入れないでください。

固定版のローカルQueueは、ランタイム全体を終了すると未配送メッセージを保持しません。Queue送信直後の停止試験ではD1の送信待ち記録から回復します。送信済みDLQ通知も、30秒の猶予後に受信記録がなければ定期回復で再送待ちに戻します。受信済み・用途や世代の不一致・削除済みの通知は対象にしません。結果保存後ack前の試験ではConsumer呼び出しを例外で終了させて同じメッセージの再配送を確認し、ack後にランタイム再起動と結果保持を確認します。クラウドQueueの永続性を検証した結果ではありません。

本番Access、実AI、クラウドD1・Queueへの接続は対象外です。採用構成と後続の検証範囲は[MVP仕様書](../spec/mvp.md)を参照してください。

## 境界検査と実時間の結合検査

HTTP契約（開発・ビルド済みWorker）は通常の`pnpm test`に含め、`pnpm test:integration`では重複実行しません。全体を検査する場合は`pnpm check`に加え、`pnpm prepare:integration`と`pnpm test:integration`を実行します。通常CIでは境界4分割と短い結合3分割を別runnerで並列実行します。長時間の再試行1件は独立した `Worker real-time checks` へ分離します。

## 通常CIと長時間検査の使い分け

`pnpm test:integration:pr` は通常PR向けの結合14件、`pnpm test:realtime` は実時間30・120・300秒の再試行と実DLQ受信1件を実行します。`pnpm test:integration` は両方を含む15件を維持します。結合検査の前には `pnpm prepare:integration` を実行してください。通常の `pnpm test` は時計を制御した再試行境界も含みます。

長時間ワークフローは毎日03:17 JST、手動実行、関連変更のPRで動きます。定期実行はmainを対象とし、GitHub側の都合で遅延する場合があります。手動実行ではGitHub Actionsの `Worker real-time checks` からrefを選びます。新規ワークフローをmainへ取り込むまでは定期・手動の起動を確認できません。

文書だけの変更は対象外です。コード・依存・設定の変更、削除・移動、変更一覧の取得不能は実行対象にします。`Realtime result` で対象外・成功・失敗・中断を確認できます。通常CIの成功だけで長時間検査も成功したとは扱いません。関連変更は長時間検査の成功を確認してから取り込み、失敗時は実行ログの原因を解消します。必須チェックのリポジトリ設定は自動変更しません。

テストの所属は `tools/local-integration/src/test-suites.ts` に集約しています。新規・削除・移動したテストを登録し忘れた場合は起動前に失敗します。分割番号は境界1〜4、通常結合1〜3です。ローカルで特定分割を再現する場合は、例えば `pnpm --dir tools/local-integration test 1 --maxWorkers=2` を使います。
