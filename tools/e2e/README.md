# 音声面接のブラウザE2E

[会話・復帰](features/voice-interview.feature)、[質問操作と割り込み](features/voice-questions.feature)、[タブ間の引き継ぎ](features/voice-takeover.feature)の受け入れ条件をCucumberが直接実行する。シナリオを追加するときは対応するfeatureを先に編集する。PRでは外部の音声AIをローカルのWebSocketサーバーに接続し、開始と手動再接続には同じステップで実AIを使うプロファイルも用意している。

## 実行

ルートで依存をインストールし、対象アプリのTypeSpec契約を生成してから実行する。音声面接のある作業ツリーで実行する場合は次の手順を使う。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @korekaite/api-contracts generate
pnpm --filter @korekaite/e2e exec playwright install chromium
pnpm test:e2e
```

別の作業ツリーの面接を検査するときは、その作業ツリーで依存のインストールと契約生成を済ませ、環境変数 `E2E_APP_ROOT` に絶対パスを指定する。システムのChromeを使う場合は `E2E_CHROME_PATH` に実行ファイルを指定する。シナリオを絞るときは名前の正規表現を渡せる。

```sh
node tools/e2e/run.mjs pr '接続に繰り返し'
```

実AI検査は対象アプリの `OPENAI_API_KEY`、`MATERIAL_MODEL`、`RESPONSES_MODEL`、`EVALUATION_MODEL` を設定して実行する。架空の経歴を材料分析に送り、合成音声で会話し、終了時は評価ジョブを作る。API利用料が発生する。

```sh
pnpm test:e2e:live
```

各シナリオは専用のD1・DO・Queueと新しいブラウザで開始する。PRはtest環境、実AIは独立した一時ディレクトリ上のdevelopment環境で起動し、後処理で停止・削除する。テスト用の音声サービスは入力PCMの振幅を確認してから文字起こしと返答音を返す。仮想マイクのWAVには「原因を調べて、索引を追加しました」という合成音声を使用している。再生はスピーカーにつながるWeb Audioグラフの振幅と再生時計から判定する。初回の模擬質問は500ミリ秒の再生終了と、そのうち400ミリ秒以上の発音を確認する。質問が文字だけ届く場合や、回答への返答が無音PCMの場合も復帰案内から会話を再開する。実マイクや物理スピーカーの品質は実機確認の対象となる。

質問操作の競合は、模擬AIが言い換えの返事を保留したまま見送りを受け付けるケースと、見送り直後に一時停止して再開するケースで検査する。旧接続の終了時に遅れて届く文字と音声を送り、新しい質問の表示、保存された発言の世代、再開後の回答と返答を照合する。

[修正前を再現する手順](regressions/README.md)に、対象ソースの固定方法、原因別パッチ、対応するシナリオを記載した。

2026年11月8日の実行結果と再起動への対応は[検証記録](../../docs/research/voice-interview-e2e.md)を参照する。
