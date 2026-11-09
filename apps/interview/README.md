# 面接DO

面接ごとの`InterviewObject`がWebSocket接続、操作するタブ、音声中継、保存と終了を管理します。D1を状態の正本とし、終了時に固定入力・評価ジョブ・送信待ちを一体保存します。評価AIはEvaluation Workerが実行します。

実DO・WebSocket・D1・QueueとモックAIによる開始から評価保存までは検証済みです。ローカル本人確認、音声利用枠、環境変数からの設定注入を実装しました。実マイク・実AIの動作は最終確認項目です。

## 接続とイベント

Web Workerは本人確認後、`INTERVIEW_SESSION`の`${APP_ENV}:interview:${interviewId}`へ転送します。内部ヘッダー`X-Interview-Actor`と`X-Interview-ID`はWeb側で上書きします。DOは名前と面接ID、D1の所有者、保存済みの対応を確認します。Interview Worker自体の公開HTTP入口は404を返します。

JSONイベントの原本は[interview.tsp](../../packages/api-contracts/events/interview.tsp)です。許可された操作、接続世代、操作IDを検証し、任意の上流モデル・指示は受け付けません。1面接に最大4接続、音声操作は1接続に限定します。操作IDの直近100件は接続ごとに照合します。

- 入力音声：先頭8バイトにbig-endian float64の接続世代、その後にPCM16・24kHz・モノラルの音声を置きます。世代は正の安全な整数、音声本体は2〜9600バイトの偶数長です。
- 出力音声：`audio`イベントの直後に、`byteLength`と一致するPCMバイナリを送ります。世代と再生位置はJSONイベントに含めます。
- 保存通知：状態と文字起こしはDB保存後に通知します。再生確認は実際に送信した位置以下に限定して別保存します。

未処理イベントは64件・512KiBまでです。上限に達した接続は閉じます。入力の順序を保ち、タブ引き継ぎ後の古い世代からの音声・操作・切断で新しい接続を停止しません。

Workerの音声受信は`binaryType = 'arraybuffer'`を明示します。現在の互換日付では既定値が`Blob`となるためです。[Cloudflareの変更記録](https://developers.cloudflare.com/changelog/post/2026-04-21-websocket-standard-binary-type/)を参照してください。

## 状態と設定

DOのアラームに接続・停止・再接続・面接の期限を設定します。再起動時はD1から復旧し、失われた接続は文字起こし欠落の可能性として記録します。終了時の指示・採点基準は[evaluation-configuration.ts](src/application/evaluation-configuration.ts)で固定入力へ渡します。

設定は`RESPONSES_MODEL`、`EVALUATION_MODEL`、`LIVE_VOICE`、`OPENAI_API_KEY`です。モデルは明示指定し、voiceの既定は`marin`です。開発時は1Password CLIから起動プロセスへ渡します。[起動手順](../../docs/runbooks/local-development.md#経験markdownで音声面接を試す)を参照してください。

## 検査

[面接制御](tests/interview-session.test.ts)と[タブ・イベント制御](tests/interview-room.test.ts)は音声接続をモックにして検査します。[実DOから評価まで](../../tools/local-integration/tests/voice-interview.test.ts)は独立したtest環境で材料分析・音声・評価AIを代替し、画面と同じ正式HTTP・WebSocket経路を通します。代替クラスとテスト用HTTP入口は本番成果物に含めません。

通常検査はルートで`pnpm check`、新規の実DO検査を含む結合検査は`pnpm test:integration:pr`です。
