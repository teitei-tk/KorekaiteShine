# 基盤連携の調査記録

2026年10月24日整理。音声連携・外部保持・クレジットは2026年10月30日にOpenAI公式資料で更新。同日にTypeSpecを使うHTTP APIのローカル検証結果への参照を追加しました。公式資料による確認と実動作の検証範囲を分けて記録します。モデル・SDK・料金・制限は採用版の固定時と配置前に再確認します。

製品が満たすべき動作と未確定事項の一覧は[MVP仕様書](../spec/mvp.md)を正とします。

## Void・TanStack Start・UI

| 資料上で確認した内容                                                                       | 公式資料                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VoidとTanStack StartのViteプラグインを組み合わせる連携手順がある                           | [TanStack Start連携](https://void.cloud/integrations/frameworks/tanstack-start)                                                                                                           |
| カスタムWorkerエントリからDOクラスを公開し、Cloudflareのバインディングを設定する方式がある | [同・カスタムWorkerエントリ](https://void.cloud/integrations/frameworks/tanstack-start#custom-worker-entry)                                                                               |
| native Void向けDO自動検出と、メタフレームワーク構成のDO組み込みは区別が必要                | [Durable State](https://void.cloud/guide/durable-state)                                                                                                                                   |
| Void標準の型付きWebSocketルートはnative Void向けで、直接のバイナリメッセージには対応しない | [WebSockets](https://void.cloud/guide/websockets)                                                                                                                                         |
| shadcn/uiにTanStack Router向けの導入案内がある                                             | [shadcn/ui](https://ui.shadcn.com/docs/installation/tanstack-router)                                                                                                                      |
| TanStack StartにCloudflareへの配置とカスタムエントリの案内がある                           | [ホスティング](https://tanstack.com/start/latest/docs/framework/react/guide/hosting)、[サーバーエントリ](https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point) |

2026年10月30日、[面接一覧APIのローカル試作](../../apps/typespec-spike/README.md)でTypeSpecからOpenAPI・型・検証コードを生成し、React・TanStack Start・Voidを接続しました。開発サーバーとビルド済みWorkerのHTTP応答、ブラウザでの一覧表示・再取得を確認しています。固定版と互換性の調整、再現手順は同記録を参照してください。

この結果を根拠に[ADR 0006](../adr/0006-typespec-api-contracts.md)でTypeSpecを正式採用しました。採用構成全体の互換性は未検証です。音声中継・D1・Queue・DLQ・認可・クラウド配置が一体で動くとは判断しません。現在の依存制約と残る検証は[MVP仕様書](../spec/mvp.md#依存バージョンの制約)を正とします。

## WebSocket・再開・外部保持

| 資料上で確認した内容                                                                                                                          | 公式資料                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 通常WorkerとDOの両方でWebSocketを扱える                                                                                                       | [Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/)                                  |
| DOの外向きWebSocketは休止の対象外                                                                                                             | [DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)                             |
| DOのメモリと接続は再起動をまたいで保証されないため、永続状態からの復旧が必要                                                                  | [DOのライフサイクル](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)                |
| GPT-Liveは音声とイベントの双方向WebSocket接続に対応する。DOとの実連携は未検証                                                                 | [GPT-Live WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets?api=live)                            |
| 日本語音声があり、入力・出力の文字起こしを断片と時刻で取得できる。発言IDやターン完了イベントはなく、発言の区切りはアプリで扱う                | [セッション管理](https://developers.openai.com/api/docs/guides/live-conversations)                                        |
| 保存済みテキストで新しい接続を開始できる。初期履歴は最大128メッセージ・合計8,192トークン                                                      | [履歴からの開始](https://developers.openai.com/api/docs/guides/live-conversations#seed-a-session-with-prior-conversation) |
| マイクのミュートだけでは生成・委譲処理は止まらない。音声再生の管理もアプリ側に必要                                                            | [入力制御](https://developers.openai.com/api/docs/guides/live-conversations#control-microphone-input)                     |
| GPT-Liveの録音保存は既定で無効。保存録音からの再開には保存の有効化と録音の完了が必要                                                          | [録音保存と再開](https://developers.openai.com/api/docs/guides/live-conversations#store-and-fork-a-session)               |
| 録音保存を有効にすると録音を30日保持する。公開の保存セッション削除APIはない。通常の不正利用監視ログは最大30日保持され、録音保存の無効化とは別 | [データ保持](https://developers.openai.com/api/docs/guides/your-data#v1livesessions)                                      |
| GPT-Liveは会話を担当し、推論・ツール実行をバックエンドに委譲できる。委譲先の保持条件・料金は別途確認が必要                                    | [GPT-Live概要](https://developers.openai.com/api/docs/guides/live)                                                        |

2026年10月30日にGemini LiveからGPT-Liveへ採用方針を変更しました。以前のGoogle側の再開ハンドル・最大24時間保持を前提とする調査結果は、現構成には適用しません。[ADR 0001](../adr/0001-server-relayed-interviews.md)に変更理由を記録しています。

再開は録音保存を無効にした状態（`store: false`）で、D1の文字起こしと面接状態から行います。保存録音からの再開は採用しません。再開用の選択・要約と評価用の原文を区別します。長期会話ではGPT-Live側でも文脈が要約され得るため、重要な面接状態はアプリで保持する必要があります。

以上は資料上の確認です。日本語の技術用語・深掘り品質、15分の接続、DO中継、発言と再生済み範囲の対応、停止・切断・再起動からの復旧は未検証です。接続時間の具体的上限と利用アカウントでの可用性も未確認です。実装前の確認事項は[MVP仕様書の補足事項](../spec/mvp.md#補足事項)を正とします。

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

2026年10月30日確認の[OpenAI料金](https://developers.openai.com/api/docs/pricing)では、GPT-Liveはセッション1分あたり0.05ドルで秒単位課金です。15分で0.75ドルは音声セッションだけの計算であり、委譲先のモデル・ツール、材料分析、評価、Cloudflareの料金は含みません。[ProのAPIクレジット](https://developers.openai.com/api/docs/guides/chatgpt-api-credits)はGPT-LiveとResponses APIを対象に含みます。対象組織への紐づけと有効化が必要で、未使用分は請求期間末に失効します。特典の継続を前提に総費用をゼロとは見積もらず、利用アカウントでの適用と特典なしの費用を確認します。

## 調査結果の更新方法

資料の変更を確認した時は、確認日、対象バージョン、変わった前提、仕様への影響を記録します。実動作で確認した場合は、環境と観測した結果を記載し、資料を読んだだけの項目と区別します。秘密値や業務の原文を調査証拠として保存しません。
