# Queue契約とジョブの進行を分け、D1で実行権を管理する

2026年11月2日合意。Queueの契約はTypeSpecからJSON Schema・型・Ajv検証コードを生成し、本文を契約版と評価実行のジョブIDに限定します。D1を業務状態の正本とし、Queueは開始通知に使います。重複配送、新旧Workerの混在、削除との競合を想定し、配送成功と評価成功を分けて扱うためです。

## 検討した選択肢

- JSON SchemaやZodを直接原本にする：生成工程を減らせる方法もありますが、HTTPと同じTypeSpecで契約を先に定義する方針を選びます。QueueはOpenAPIを経由させません。
- 会話やモデル設定をメッセージへ入れる：Consumer単独で扱いやすい反面、削除・再実行・固定入力の管理先が増えるため、D1の不変入力をIDで参照します。
- Queueの配送回数で評価回数を管理する：実行権待ちやD1障害で評価前に上限へ達するため採用しません。評価の試行はD1、配送の再試行はQueueで管理します。
- 面接DOのAlarmへ評価回復を集約する：面接の待機期限と予約が競合し、評価が面接DOの稼働へ依存するため、Evaluation Workerの定期回復を選びます。

## 実行権と配送判断

ジョブと本人全体の評価枠を一体で取得し、所有者・世代・期限を保存時にも検証します。期限付き実行権による復旧と、古いConsumerの結果拒否を組み合わせます。実行権があっても外部AIの厳密な一回実行や課金の重複防止までは保証しません。

終端状態を確認した場合、後続処理をD1へ永続化できた場合、または[配送異常の隔離記録](0014-quarantine-invalid-job-notifications.md)を保存できた場合にackします。判断・保存できない配送はretryします。評価上限到達などアプリが判断できる失敗は、D1の失敗状態とDLQ送信待ちを先に保存します。DLQ到着だけで完了済みジョブを失敗へ戻さず、未完了でも実行者と回復経路を照合します。

送信待ち記録と定期回復の運用負担を引き受けます。D1・Queue間の原子性はなく、送信後の停止で重複し得るため、受信側の実行権管理を維持します。DLQの無条件な自動差し戻しは採用しません。

## 初期値と検証

AI待機、試行全体、実行権、再試行、定期回復を別の期限として管理します。実行権の更新でも試行全体の上限を延ばしません。初期値は実測した性能保証ではなく、モデル・入力上限・運用結果を踏まえて見直します。数値、状態遷移、ack・retry・DLQの正式な規則は[MVP仕様書](../spec/mvp.md#評価ジョブと再実行)へ集約します。

合意時点では固定版の生成・接続・定期実行は未検証でした。2026年11月3日にローカルで確認し、[検証記録](../research/local-worker-integration.md)へ結果とQueue永続性の制約を追記しました。時計を差し替えた境界テストと実際の配送検証を分けます。DLQ処理自身の失敗・保持期限・運用回復など、残る事項も仕様書で管理します。根拠となる公式資料は[TypeSpec JSON Schema](https://typespec.io/docs/emitters/json-schema/reference/)、[Queue配送保証](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)、[再試行](https://developers.cloudflare.com/queues/configuration/batching-retries/)、[DLQ](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)です。
