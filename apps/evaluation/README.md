# Evaluationのテスト

再試行・実行制御の単体テストはこのアプリに置き、D1・Queue・複数Workerが必要な検査は[ローカル接続検証](../../tools/local-integration/README.md)へ置きます。正式なAI評価は後続範囲です。

リポジトリルートで`pnpm test`を実行します。型・Lint・整形・文書も含める場合は`pnpm check`を使います。

| 対象                                       | テスト                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 再試行回数・待機時間・Retry-After          | [retry-policy.test.ts](tests/retry-policy.test.ts)                                                   |
| AI待機期限・実行権更新・保存の再試行と中止 | [execution-control.test.ts](tests/execution-control.test.ts)                                         |
| 通知時刻の丸め・遅延上限・部分失敗         | [dispatch-notifications.test.ts](../../tools/local-integration/tests/dispatch-notifications.test.ts) |

実行制御の6ケースはローカル接続検証から移し、仮想時計による120秒・180秒の境界検査を維持しています。単体テストはD1や実AIを起動しません。通知配送テストは本物の配送処理とローカルD1を使い、Queue送信だけを記録・失敗注入へ差し替えます。実Queueの配送は既存の接続検証で確認します。
