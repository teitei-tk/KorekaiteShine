# Evaluationのテスト

再試行・実行制御の単体テストはこのアプリに置き、D1・Queue・複数Workerが必要な検査は[ローカル接続検証](../../tools/local-integration/README.md)へ置きます。正式評価Workerは、保存済みの面接入力から五軸評価を生成し、引用を検証して結果を保存します。実D1・実QueueとモックAIの接続は検証済みです。実AIの品質・所要時間と、面接画面からの全経路は未検証です。

リポジトリルートで`pnpm test`を実行します。型・Lint・整形・文書も含める場合は`pnpm check`を使います。

| 対象                                       | テスト                                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 五軸評価・引用検証・Responses境界          | [interview-evaluation.test.ts](tests/interview-evaluation.test.ts)                                             |
| 正式Worker・実D1・実QueueとモックAI        | [interview-evaluation-worker.test.ts](../../tools/local-integration/tests/interview-evaluation-worker.test.ts) |
| 再試行回数・待機時間・Retry-After          | [retry-policy.test.ts](tests/retry-policy.test.ts)                                                             |
| AI待機期限・実行権更新・保存の再試行と中止 | [execution-control.test.ts](tests/execution-control.test.ts)                                                   |
| 通知時刻の丸め・遅延上限・部分失敗         | [dispatch-notifications.test.ts](../../tools/local-integration/tests/dispatch-notifications.test.ts)           |

実行制御の6ケースはローカル接続検証から移し、仮想時計による120秒・180秒の境界検査を維持しています。単体テストはD1や実AIを起動しません。通知配送テストは本物の配送処理とローカルD1を使い、Queue送信だけを記録・失敗注入へ差し替えます。実Queueの配送は既存の接続検証で確認します。

## 正式評価と診断の分離

`worker.ts`が正式評価Queue・DLQと定期回復を担当します。`worker.local.ts`は開発・テストの診断入口を追加し、正式評価の通知は`worker.ts`へ渡します。実APIのキーは`OPENAI_API_KEY`バインディングから読みます。利用枠は本人・日本時間の日付・ジョブIDごとに管理します。キーの注入は[ローカル起動手順](../../docs/runbooks/local-development.md#経験markdownで音声面接を試す)を参照してください。

診断の確認結果は、ローカル入口から渡すDB更新処理により、ジョブ完了やDLQ受信と同じトランザクションで保存します。本番Workerは診断処理と診断Schemaを読み込まず、本番成果物の分離検査で確認します。

AI代替を使う結合検査は、独立した`test`環境で`interviewEvaluationMock`を指定します。実DBの固定入力読取・実行権・Queue配送・結果保存は正式処理を使い、AI生成だけを代替します。この設定は通常の開発起動と本番には適用しません。
