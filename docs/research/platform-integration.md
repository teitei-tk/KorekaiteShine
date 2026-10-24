# 基盤連携の調査記録

2026年10月24日整理。2026年10月20日から24日の設計相談で参照した公式資料を記録します。以下は資料上の確認であり、アプリを動かしての検証ではありません。モデル・SDK・料金・制限は採用版の固定時と配置前に再確認します。

製品が満たすべき動作と未確定事項の一覧は[MVP仕様書](../spec/mvp.md)を正とします。

## Void・TanStack Start・UI

| 資料上で確認した内容 | 公式資料 |
|---|---|
| VoidとTanStack StartのViteプラグインを組み合わせる連携手順がある | [TanStack Start連携](https://void.cloud/integrations/frameworks/tanstack-start) |
| カスタムWorkerエントリからDOクラスを公開し、Cloudflareのバインディングを設定する方式がある | [同・カスタムWorkerエントリ](https://void.cloud/integrations/frameworks/tanstack-start#custom-worker-entry) |
| native Void向けDO自動検出と、メタフレームワーク構成のDO組み込みは区別が必要 | [Durable State](https://void.cloud/guide/durable-state) |
| Void標準の型付きWebSocketルートはnative Void向けで、直接のバイナリメッセージには対応しない | [WebSockets](https://void.cloud/guide/websockets) |
| shadcn/uiにTanStack Router向けの導入案内がある | [shadcn/ui](https://ui.shadcn.com/docs/installation/tanstack-router) |
| TanStack StartにCloudflareへの配置とカスタムエントリの案内がある | [ホスティング](https://tanstack.com/start/latest/docs/framework/react/guide/hosting)、[サーバーエントリ](https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point) |

採用構成全体の互換性と具体的なパッケージバージョンは未検証です。資料の存在だけで、音声中継・D1・Queue・DLQが一体で動くとは判断しません。

## WebSocket・再開・外部保持

| 資料上で確認した内容 | 公式資料 |
|---|---|
| 通常WorkerとDOの両方でWebSocketを扱える | [Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/) |
| DOの外向きWebSocketは休止の対象外 | [DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) |
| DOのメモリと接続は再起動をまたいで保証されないため、永続状態からの復旧が必要 | [DOのライフサイクル](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) |
| Geminiの接続時間には制限があり、終了予告と再開用ハンドルを扱う必要がある。参照時の案内は接続約10分、圧縮なしの音声セッション15分 | [Geminiセッション管理](https://ai.google.dev/gemini-api/docs/live-api/session-management) |
| Geminiのセッション再開を有効にすると、音声を含む会話状態が最大24時間保持される | [Googleのデータ保持](https://ai.google.dev/gemini-api/docs/zdr) |
| 学習・製品改善への利用条件と、サービスのデータ保持は別の条件 | [Gemini API利用条件](https://ai.google.dev/gemini-api/terms) |

日本語の対話・文字起こし、発言の確定タイミング、切断直前の欠落、再開可能な状態、再開失敗時の動作は未検証です。モデル名を調査時の例から採用済みとして転記しません。実際の利用アカウントでの可用性も確認が必要です。

## Queues・DLQ・ローカル実行

- VoidはQueueのConsumerと再試行設定を提供します。参照時の資料では、Void管理のQueueはDLQを自動設定しません。[Void Queues](https://void.cloud/guide/queues)
- 同資料では、native Voidのローカル送信はConsumerを自動起動しますが、メタフレームワーク構成は手動の開発用呼び出しが案内されています。TanStack Startで送信から評価までを自動実行するローカル構成は未検証です。
- Queuesは少なくとも1回の配送を前提とし、重複に備える必要があります。[配送保証](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- 再試行上限後、DLQがなければメッセージは削除されます。DLQを失敗記録の永久保存先とはせず、アプリの実行履歴へ反映する必要があります。[DLQ](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)、[再試行](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- DOのAlarmは接続なしで実行できますが、同時に設定できる予約は一つです。配送確認に利用する場合、面接の待機期限と予約を競合させない設計が必要です。[Alarm](https://developers.cloudflare.com/durable-objects/api/alarms/)

Queueの同時実行設定だけで、期限切れ実行や重複配送を含む評価の同時1件を保証できるかは別途検証します。D1保存とQueue送信の中断、結果保存直前の削除、DLQ処理自体の失敗を含めて確認します。

## 1Passwordと秘密値

1Password Environments MCPの公式資料は、環境・変数の名前を扱い、秘密値をエージェントに返さない仕組みと、正規UIでの承認を説明しています。[MCP公式資料](https://www.1password.dev/environments/mcp-server)

調査時のCLIリリース情報では2.41.0にEnvironmentからの実行時注入の対応が記載されています。初期の調査で見つかったベータ版前提の説明だけでは導入版を決めません。[CLIリリース](https://releases.1password.com/developers/cli/)、[実行時注入](https://www.1password.dev/cli/reference/commands/run)

初回の環境確認では利用可能なMCPツールとCLIを確認できませんでした。その後、利用者からインストールの報告があり、スキルの存在は確認しましたが、MCPの接続成功は未確認です。秘密値の取得は行っていません。

Voidの資料にはシェル環境変数の利用が記載されています。ただし1PasswordからTanStack Start・ローカルWorkersへの受け渡しと、生成設定・ブラウザ用ビルド・ログに残らないことは未検証です。[Void環境変数](https://void.cloud/guide/env-vars)

本番の秘密値供給先は未合意です。開発用の1Password連携がそのままデプロイ済みWorkerへ供給されるとは扱いません。

## 費用と運用上限

音声中継はDOの稼働時間、評価はAI呼び出しとQueue・Consumer、記録はD1等の利用量に影響します。再試行や待機も含めて計測し、個人用だから費用が必ず一定になるとは扱いません。

- [Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)
- [DO料金](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [D1料金](https://developers.cloudflare.com/d1/platform/pricing/)
- [Queues料金](https://developers.cloudflare.com/queues/platform/pricing/)

相談時にはCloudflareの小規模利用を月額最低料金の含有枠内で運用できる可能性を確認しましたが、採用モデル・利用回数・実測値が未確定のため、総額の見積もりとしては扱いません。具体的な日次上限は仕様の未確定事項です。

## 調査結果の更新方法

資料の変更を確認した時は、確認日、対象バージョン、変わった前提、仕様への影響を記録します。実動作で確認した場合は、環境と観測した結果を記載し、資料を読んだだけの項目と区別します。秘密値や業務の原文を調査証拠として保存しません。
